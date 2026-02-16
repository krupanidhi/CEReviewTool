import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join, basename } from 'path'
import { promises as fs } from 'fs'
import { loadSAATData, matchApplicantToServiceArea, buildSAATSummary, deriveFiscalYear } from '../services/saatService.js'
import { analyzeDocumentEnhanced } from '../services/enhancedDocumentIntelligence.js'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'
import {
  PROGRAM_SPECIFIC_RULES, STANDARD_RULES,
  buildApplicationIndex, analyzeApplicantType, evaluateCondition,
  answerPresenceQuestion, extractRelevantPages,
  parseSuggestedResources, lookupFormPages
} from '../services/checklistRules.js'
import { extractTocLinks } from '../services/pdfLinkExtractor.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const router = express.Router()

const CHECKLIST_QUESTIONS_ROOT = join(__dirname, '../../checklistQuestions')

// Known checklist PDF-to-JSON name mappings
// Key = search pattern (case-insensitive), Value = canonical JSON filename
const CHECKLIST_MAPPINGS = {
  programspecific: { pdfPattern: /program\s*specific/i, jsonName: 'ProgramSpecificQuestions_structured.json' },
  standard:       { pdfPattern: /standard\s*checklist/i, jsonName: 'StandardChecklist_structured.json' }
}

/**
 * Ensure a structured JSON exists for a checklist.
 * Resolution order:
 *   1. Explicit JSON path (if provided and exists)
 *   2. Cached structured JSON in checklistQuestions/<FY>/
 *   3. Cached structured JSON in checklistQuestions/ (root)
 *   4. Source PDF found in checklistQuestions/<FY>/ → extract via Azure DI → save JSON alongside
 *   5. Source PDF found in checklistQuestions/ (root) → extract → save
 *   6. Legacy fallback: search extractions/ and stored-checklists/
 *
 * @param {string} checklistType  - 'programspecific' or 'standard'
 * @param {string|null} fiscalYear - e.g. 'FY26'
 * @param {string|null} explicitPath - caller-supplied path override
 * @returns {string} Resolved path to the structured JSON file
 */
async function resolveChecklistPath(checklistType, fiscalYear = null, explicitPath = null) {
  const mapping = CHECKLIST_MAPPINGS[checklistType]
  if (!mapping) throw new Error(`Unknown checklist type: ${checklistType}`)

  // 1. Explicit path
  if (explicitPath) {
    try {
      await fs.access(explicitPath)
      console.log(`📋 Using explicit checklist path: ${explicitPath}`)
      return explicitPath
    } catch {
      console.warn(`⚠️ Explicit path not found: ${explicitPath}, falling back to auto-resolve`)
    }
  }

  // Build ordered list of directories to search (FY-specific first, then all FY subdirs)
  const searchDirs = []
  if (fiscalYear) searchDirs.push(join(CHECKLIST_QUESTIONS_ROOT, fiscalYear))
  searchDirs.push(CHECKLIST_QUESTIONS_ROOT)
  // When no fiscal year is known, also scan all FY subdirectories (newest first)
  if (!fiscalYear) {
    try {
      const entries = await fs.readdir(CHECKLIST_QUESTIONS_ROOT, { withFileTypes: true })
      const fyDirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a)) // newest FY first (FY26 > FY25 > 2024)
      for (const d of fyDirs) searchDirs.push(join(CHECKLIST_QUESTIONS_ROOT, d))
    } catch { /* root doesn't exist */ }
  }

  // 2. Look for existing cached structured JSON
  for (const dir of searchDirs) {
    const jsonPath = join(dir, mapping.jsonName)
    try {
      await fs.access(jsonPath)
      console.log(`📋 Found cached structured JSON: ${jsonPath}`)
      return jsonPath
    } catch { /* not found, continue */ }
  }

  // 3. Look for source PDF → extract → cache JSON
  for (const dir of searchDirs) {
    try {
      const files = await fs.readdir(dir)
      const pdfFile = files.find(f => mapping.pdfPattern.test(f) && /\.pdf$/i.test(f))
      if (pdfFile) {
        const pdfPath = join(dir, pdfFile)
        const jsonPath = join(dir, mapping.jsonName)
        console.log(`📋 No cached JSON found. Extracting from PDF: ${pdfPath}`)
        await extractAndCacheChecklist(pdfPath, jsonPath)
        return jsonPath
      }
    } catch { /* dir doesn't exist, skip */ }
  }

  // 4. Legacy fallback: search extractions/ and stored-checklists/ for any matching JSON
  const legacyDirs = [
    join(__dirname, '../../extractions'),
    join(__dirname, '../../stored-checklists'),
    join(__dirname, '../../data')
  ]
  for (const dir of legacyDirs) {
    try {
      const files = await fs.readdir(dir)
      const jsonFile = files.find(f =>
        mapping.pdfPattern.test(f) && /\.json$/i.test(f) && /structured/i.test(f)
      )
      if (jsonFile) {
        const resolved = join(dir, jsonFile)
        console.log(`📋 Found legacy structured JSON: ${resolved}`)
        return resolved
      }
    } catch { /* skip */ }
  }

  throw new Error(
    `No checklist found for type "${checklistType}" (FY=${fiscalYear || 'unknown'}). ` +
    `Place a PDF in ${fiscalYear ? join(CHECKLIST_QUESTIONS_ROOT, fiscalYear) : CHECKLIST_QUESTIONS_ROOT}/`
  )
}

/**
 * Extract a checklist PDF via Azure Document Intelligence, transform to
 * structured JSON, and save it alongside the PDF for future reuse.
 */
async function extractAndCacheChecklist(pdfPath, jsonOutputPath) {
  const pdfBuffer = await fs.readFile(pdfPath)
  console.log(`  � Sending ${basename(pdfPath)} (${(pdfBuffer.length / 1024).toFixed(0)} KB) to Azure DI...`)

  const analysisResult = await analyzeDocumentEnhanced(pdfBuffer, 'application/pdf')
  const structuredData = transformToStructured(analysisResult.data)

  // Also save the raw extraction for debugging
  const rawJsonPath = jsonOutputPath.replace('_structured.json', '_extraction.json')
  await fs.writeFile(rawJsonPath, JSON.stringify(analysisResult.data, null, 2))
  console.log(`  💾 Raw extraction saved: ${rawJsonPath}`)

  await fs.writeFile(jsonOutputPath, JSON.stringify(structuredData, null, 2))
  console.log(`  ✅ Structured JSON cached: ${jsonOutputPath}`)
}

/**
 * Extract Funding Opportunity Number from application data.
 * Searches key-value pairs, content, and form fields for patterns like HRSA-26-004.
 */
function extractFundingOppNumber(applicationData) {
  if (!applicationData) return null

  // Search key-value pairs
  const kvPairs = applicationData.keyValuePairs || []
  for (const kv of kvPairs) {
    const val = (kv.value || '').trim()
    const match = val.match(/HRSA-\d{2}-\d{3}/i)
    if (match) return match[0].toUpperCase()
  }

  // Search content text
  const content = applicationData.content || ''
  const contentMatch = content.match(/HRSA-\d{2}-\d{3}/i)
  if (contentMatch) return contentMatch[0].toUpperCase()

  // Search sections
  const sections = applicationData.sections || []
  for (const section of sections) {
    const sectionContent = section.content?.map(c => c.text).join(' ') || ''
    const sMatch = sectionContent.match(/HRSA-\d{2}-\d{3}/i)
    if (sMatch) return sMatch[0].toUpperCase()
  }

  // Search tables
  const tables = applicationData.tables || []
  for (const table of tables) {
    const formQuestions = table.formQuestions || []
    for (const fq of formQuestions) {
      const answer = (fq.answer || '').trim()
      const fqMatch = answer.match(/HRSA-\d{2}-\d{3}/i)
      if (fqMatch) return fqMatch[0].toUpperCase()
    }
  }

  return null
}

const endpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const key = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

if (!endpoint || !key || !deployment) {
  throw new Error('Azure OpenAI credentials not configured')
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(key))

/**
 * Universal checklist question parser.
 * Handles merged questions (multiple numbered Qs in one section's title+content),
 * extracts user answers per-question, and captures suggested resources.
 *
 * Works for both ProgramSpecific and Standard checklists.
 *
 * @param {Object} data - Structured JSON from Azure DI extraction
 * @returns {{ questions: Array, metadata: Object }}
 */
function parseChecklistQuestions(data) {
  const questions = new Map() // keyed by question number to deduplicate
  const metadata = {}
  const sections = data?.document?.sections || []

  // Collect ALL text from sections (title + content) in document order,
  // including children, so we can split on question boundaries.
  const allTextBlocks = []

  function collectText(section) {
    const title = (section.title || '').trim()
    const content = (section.content || '').trim()
    const pageRef = section.pageReference || null

    // Collect metadata from formFields
    if (section.formFields) {
      section.formFields.forEach(ff => {
        const key = (ff.field || '').trim()
        const val = (ff.value || '').trim()
        if (['Announcement Name', 'Grant (#)', 'Announcement (#)', 'Funding Cycle Code',
             'Completion Status', 'Program Specific Recommendation', 'Recommendation',
             'Name', 'Date'].includes(key)) {
          if (!metadata[key]) metadata[key] = val
        }
      })
    }

    // GMS Recommendation metadata
    if (title === 'GMS Recommendation') {
      metadata.gmsRecommendation = {}
      if (section.formFields) {
        section.formFields.forEach(ff => {
          metadata.gmsRecommendation[ff.field] = ff.value
        })
      }
      if (content) {
        const justMatch = content.match(/Justification:\s*([\s\S]*?)(?:Date:|$)/i)
        if (justMatch) metadata.gmsRecommendation.Justification = justMatch[1].trim()
      }
    }

    // Combine title + content as one text block
    const combined = [title, content].filter(Boolean).join('\n')
    if (combined) allTextBlocks.push({ text: combined, pageRef })

    if (section.children) {
      section.children.forEach(child => collectText(child))
    }
  }

  sections.forEach(s => collectText(s))

  // Join all text into one stream so we can split on question boundaries
  const fullText = allTextBlocks.map(b => b.text).join('\n')

  // Split into individual questions using numbered pattern: "N. <question text>"
  // We find all positions where a question starts, then extract text between them.
  const questionStarts = []
  const qStartRegex = /(?:^|\n)\s*(\d{1,2})\.\s+/g
  let m
  while ((m = qStartRegex.exec(fullText)) !== null) {
    const num = parseInt(m[1])
    // Filter out noise: only accept question numbers 1-30 and skip dates/page numbers
    if (num >= 1 && num <= 30) {
      // Make sure this isn't a date like "1/22/26" or page ref like "1/3"
      const charAfterNum = fullText.substring(m.index + m[0].length, m.index + m[0].length + 1)
      const charBeforeMatch = m.index > 0 ? fullText[m.index - 1] : '\n'
      // Skip if preceded by "/" (date/page pattern)
      if (charBeforeMatch === '/') continue
      questionStarts.push({ num, startIdx: m.index, matchLen: m[0].length })
    }
  }

  // Extract each question's full text block (from its start to the next question's start)
  for (let i = 0; i < questionStarts.length; i++) {
    const qs = questionStarts[i]
    const textStart = qs.startIdx + qs.matchLen
    const textEnd = i + 1 < questionStarts.length ? questionStarts[i + 1].startIdx : fullText.length
    const rawBlock = fullText.substring(qs.startIdx, textEnd).trim()

    // The question text is everything from after "N. " up to the first answer checkbox or "Suggested Resource"
    const afterNum = fullText.substring(textStart, textEnd).trim()

    // Extract question text: everything before the first checkbox pattern or "Suggested Resource"
    let questionText = afterNum
      .split(/\n/)[0] // Take first line as primary question
    // But some questions span multiple lines before the checkbox — grab until first checkbox
    const checkboxIdx = afterNum.search(/\[\s*[X_\s]*\s*\]\s*(?:Yes|No|N\/?A)/i)
    const suggestedIdx = afterNum.search(/Suggested Resource/i)
    let cutoff = afterNum.length
    if (checkboxIdx > 0) cutoff = Math.min(cutoff, checkboxIdx)
    if (suggestedIdx > 0) cutoff = Math.min(cutoff, suggestedIdx)
    questionText = afterNum.substring(0, cutoff)
      .replace(/\[\s*X?\s*_?\s*\]\s*(Yes|No|N\/A)/gi, '')
      .replace(/:unselected:/gi, '')
      .replace(/:selected:/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()

    // Extract suggested resources from this question's block
    const suggestedResources = extractSuggestedResources(rawBlock)

    // Detect SAAT requirement
    const requiresSAAT = /\bSAAT\b/i.test(rawBlock)

    // Determine page reference
    const pageRef = findPageRef(rawBlock, allTextBlocks)

    // Only add if we have meaningful question text (skip noise like dates, page headers, metadata sections)
    const isMetadata = /^Other\s+comments\b/i.test(questionText) ||
      /^Completion\s+Status/i.test(questionText) ||
      /^Program\s+Specific\s+(Checklist|Recommendation)/i.test(questionText) ||
      /^GMS\s+Recommendation/i.test(questionText)
    if (!isMetadata && questionText.length > 10) {
      // Keep the better version if duplicate (longer question text wins)
      const existing = questions.get(qs.num)
      if (!existing || questionText.length > existing.question.length) {
        questions.set(qs.num, {
          number: qs.num,
          question: questionText,
          suggestedResources,
          requiresSAAT,
          pageReference: pageRef
        })
      }
    }
  }

  return {
    questions: [...questions.values()].sort((a, b) => a.number - b.number),
    metadata
  }
}

/**
 * Extract "Suggested Resource(s):" values from a question block
 */
function extractSuggestedResources(block) {
  const resources = []
  const regex = /Suggested Resource\(?s?\)?:\s*([^\n\[]*(?:\[[^\]]*\])?[^\n]*)/gi
  let rm
  while ((rm = regex.exec(block)) !== null) {
    let res = rm[1]
      .replace(/\[\s*X?\s*_?\s*\]\s*(Yes|No|N\/A)/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (res && res.length > 2) resources.push(res)
  }
  // Deduplicate and join
  return [...new Set(resources)].join(' | ')
}

/**
 * Find the page reference for a question block by matching against source text blocks
 */
function findPageRef(rawBlock, allTextBlocks) {
  const snippet = rawBlock.substring(0, 80)
  for (const b of allTextBlocks) {
    if (b.text.includes(snippet.trim().substring(0, 40)) && b.pageRef) return b.pageRef
  }
  return null
}

/**
 * GET /api/qa-comparison/questions
 * Return parsed questions with user-provided answers
 */
router.get('/questions', async (req, res) => {
  try {
    const dataPath = await resolveChecklistPath('programspecific', null, req.query.path)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const data = JSON.parse(raw)
    const { questions, metadata } = parseChecklistQuestions(data)

    res.json({
      success: true,
      totalQuestions: questions.length,
      questions,
      metadata
    })
  } catch (error) {
    console.error('❌ Error parsing questions:', error)
    res.status(500).json({ error: 'Failed to parse questions', message: error.message })
  }
})

/**
 * POST /api/qa-comparison/analyze
 * Run AI analysis to derive answers from application evidence and compare with user answers
 */
router.post('/analyze', async (req, res) => {
  try {
    const { applicationData } = req.body

    if (!applicationData) {
      return res.status(400).json({ error: 'Application data is required' })
    }

    console.log('\n🔍 ===== RULES-BASED QA COMPARISON START =====')
    console.log(`📦 applicationData: ${applicationData.pages?.length || 0} pages, ${applicationData.sections?.length || 0} sections`)

    // 0. Extract Funding Opportunity Number and derive fiscal year
    const fundingOppNumber = extractFundingOppNumber(applicationData)
    const fiscalYear = fundingOppNumber ? deriveFiscalYear(fundingOppNumber) : null
    console.log(`🔢 Funding Opportunity: ${fundingOppNumber || 'Not found'}, Fiscal Year: ${fiscalYear || 'Unknown'}`)

    // 1. Parse checklist questions
    const dataPath = await resolveChecklistPath('programspecific', fiscalYear, req.body.checklistPath)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const psqData = JSON.parse(raw)
    const { questions: userQuestions } = parseChecklistQuestions(psqData)
    console.log(`📋 Parsed ${userQuestions.length} questions`)

    // 2. Extract PDF TOC links if not already present in applicationData
    //    These give us exact hyperlink destinations from the PDF's Table of Contents.
    if (!applicationData.tocLinks) {
      try {
        const pdfPath = await findApplicationPdf(applicationData)
        if (pdfPath) {
          const pdfBuffer = await fs.readFile(pdfPath)
          const tocLinks = await extractTocLinks(pdfBuffer)
          if (tocLinks.length > 0) {
            applicationData.tocLinks = tocLinks
            console.log(`🔗 Lazy-extracted ${tocLinks.length} TOC links from ${basename(pdfPath)}`)
          }
        }
      } catch (linkErr) {
        console.warn(`⚠️ Lazy PDF link extraction skipped: ${linkErr.message}`)
      }
    }

    // 3. Build application index (TOC → page map) — deterministic, no AI
    const appIndex = buildApplicationIndex(applicationData)

    // 4. Extract applicant profile and analyze type flags
    const applicantProfile = extractApplicantProfile(applicationData)
    const applicantFlags = analyzeApplicantType(applicantProfile, applicationData)
    console.log(`👤 Applicant: ${applicantProfile.organizationName || 'Unknown'}`)

    // 4. Load SAAT data
    let saatData = null
    let saatSummary = ''
    const saatQuestionNums = userQuestions.filter(q => q.requiresSAAT).map(q => q.number)
    if (fiscalYear && saatQuestionNums.length > 0) {
      try {
        saatData = await loadSAATData(fiscalYear, fundingOppNumber)
        if (saatData.found) {
          matchApplicantToServiceArea(saatData, applicantProfile, applicationData)
          saatSummary = buildSAATSummary(saatData)
          const matched = saatData.matchedArea
          console.log(matched
            ? `📊 SAAT matched: SA ${matched.id} (${matched.city}, ${matched.state}) — ${saatData.matchMethod}`
            : `📊 SAAT: ${saatData.serviceAreas.length} areas loaded, NO match — ${saatData.matchMethod}`)
        }
      } catch (saatErr) {
        console.warn(`⚠️ SAAT load failed: ${saatErr.message}`)
      }
    }

    // 5. Process each question using rules engine
    const comparisonResults = []
    const aiQuestionsToAsk = [] // Collect questions that need AI

    // Track Q10 answer for dependency chain (Q11-Q15 depend on Q10=Yes)
    let q10Answer = null

    for (const q of userQuestions) {
      const rule = PROGRAM_SPECIFIC_RULES.find(r => r.questionNumber === q.number)

      if (!rule) {
        // No rule defined — fall back to AI
        aiQuestionsToAsk.push(q)
        continue
      }

      // Check condition (applicant type, funding type, etc.)
      const condResult = evaluateCondition(rule, applicantFlags)
      if (!condResult.applicable) {
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: 'N/A',
          confidence: 'high',
          evidence: condResult.reason,
          pageReferences: [],
          reasoning: condResult.reason,
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: q.requiresSAAT || false,
          method: 'rules_condition'
        })
        if (q.number === 10) q10Answer = 'N/A'
        continue
      }

      // Check dependency (Q11-Q15 depend on Q10=Yes)
      if (rule.dependsOn) {
        const depAnswer = q10Answer || comparisonResults.find(r => r.questionNumber === rule.dependsOn.question)?.aiAnswer
        if (depAnswer && depAnswer.toLowerCase() !== rule.dependsOn.requiredAnswer.toLowerCase()) {
          comparisonResults.push({
            questionNumber: q.number,
            question: q.question,
            aiAnswer: 'N/A',
            confidence: 'high',
            evidence: `Per the checklist instructions, since Question ${rule.dependsOn.question} was answered "${depAnswer}", this question is not applicable.`,
            pageReferences: [],
            reasoning: `The checklist states that if Question ${rule.dependsOn.question} is answered "No", then Questions 11 through 15 should be marked N/A.`,
            suggestedResources: q.suggestedResources || '',
            requiresSAAT: q.requiresSAAT || false,
            method: 'rules_dependency'
          })
          continue
        }
      }

      // Apply answer strategy — pass suggestedResources as primary lookup hint
      if (rule.answerStrategy === 'presence') {
        const result = answerPresenceQuestion(rule, appIndex, q.suggestedResources)
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          ...result,
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: q.requiresSAAT || false,
          method: 'rules_presence'
        })
        console.log(`   Q${q.number}: ${result.aiAnswer} (presence check) → pages [${result.pageReferences.join(', ')}]`)
      } else if (rule.answerStrategy === 'saat_compare') {
        // SAAT questions — collect for focused AI call with SAAT data
        aiQuestionsToAsk.push({ ...q, rule, isSAAT: true })
        if (q.number === 10) {
          // We need Q10 answered before Q11-Q15, so mark it for priority
          aiQuestionsToAsk[aiQuestionsToAsk.length - 1].priority = true
        }
      } else if (rule.answerStrategy === 'ai_focused') {
        // Focused AI — collect with relevant pages
        aiQuestionsToAsk.push({ ...q, rule })
      }
    }

    // 6. Process AI questions in batches — focused prompts with only relevant pages
    if (aiQuestionsToAsk.length > 0) {
      console.log(`\n🤖 Sending ${aiQuestionsToAsk.length} questions to AI (focused prompts)...`)

      // Separate SAAT questions from non-SAAT for different prompt strategies
      const saatQuestions = aiQuestionsToAsk.filter(q => q.isSAAT)
      const focusedQuestions = aiQuestionsToAsk.filter(q => !q.isSAAT)

      // 6a. Handle SAAT questions as a batch (they share SAAT data context)
      if (saatQuestions.length > 0) {
        const saatResults = await answerSAATQuestionsBatch(saatQuestions, appIndex, saatData, saatSummary, applicantProfile)
        for (const r of saatResults) {
          if (r.questionNumber === 10) q10Answer = r.aiAnswer
          comparisonResults.push(r)
        }

        // Re-evaluate Q11-Q15 dependencies now that Q10 is answered
        if (q10Answer && q10Answer.toLowerCase() !== 'yes') {
          for (const q of saatQuestions) {
            if (q.rule?.dependsOn?.question === 10 && !comparisonResults.find(r => r.questionNumber === q.number)) {
              comparisonResults.push({
                questionNumber: q.number,
                question: q.question,
                aiAnswer: 'N/A',
                confidence: 'high',
                evidence: `Q10 answered "${q10Answer}" — questions 11-15 are N/A per checklist instructions.`,
                pageReferences: [],
                reasoning: `Dependency: Q10=${q10Answer}, so this question is automatically N/A.`,
                suggestedResources: q.suggestedResources || '',
                requiresSAAT: q.requiresSAAT || false,
                method: 'rules_dependency'
              })
            }
          }
        }
      }

      // 6b. Handle focused AI questions — each gets only its relevant pages
      if (focusedQuestions.length > 0) {
        const focusedResults = await answerFocusedQuestionsBatch(focusedQuestions, appIndex, applicantProfile)
        comparisonResults.push(...focusedResults)
      }
    }

    // 7. Sort results by question number and calculate summary
    comparisonResults.sort((a, b) => a.questionNumber - b.questionNumber)
    const summary = calculateSummary(comparisonResults)

    // Log results
    console.log('\n� Final Results:')
    comparisonResults.forEach(r => {
      console.log(`   Q${r.questionNumber}: ${r.aiAnswer} (${r.method || 'ai'}) → pages [${(r.pageReferences || []).join(', ')}]`)
    })
    console.log(`\n📊 Summary: ${summary.totalQuestions} questions — Yes: ${summary.yesCount}, No: ${summary.noCount}, N/A: ${summary.naCount}`)
    console.log('🔍 ===== RULES-BASED QA COMPARISON COMPLETE =====\n')

    res.json({
      success: true,
      summary,
      results: comparisonResults,
      pageOffset: appIndex.pageOffset || 0,
      saatInfo: saatData?.found ? {
        available: true,
        fundingOppNumber,
        fiscalYear,
        patientTarget: saatData.patientTarget,
        totalFunding: saatData.totalFunding,
        serviceTypes: saatData.serviceTypes,
        zipCodeCount: saatData.totalZipCodes
      } : {
        available: false,
        fundingOppNumber: fundingOppNumber || null,
        fiscalYear: fiscalYear || null,
        reason: !fundingOppNumber ? 'Funding Opportunity Number not found in application' : !fiscalYear ? 'Could not derive fiscal year' : 'SAAT CSV not found'
      }
    })

  } catch (error) {
    console.error('❌ QA Comparison error:', error)
    res.status(500).json({
      error: 'Failed to run QA comparison analysis',
      message: error.message
    })
  }
})

/**
 * GET /api/qa-comparison/standard-questions
 * Return parsed Standard Checklist questions with user-provided answers and metadata
 */
router.get('/standard-questions', async (req, res) => {
  try {
    const dataPath = await resolveChecklistPath('standard', null, req.query.path)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const data = JSON.parse(raw)
    const { questions, metadata } = parseChecklistQuestions(data)

    res.json({
      success: true,
      totalQuestions: questions.length,
      questions,
      metadata
    })
  } catch (error) {
    console.error('❌ Error parsing standard checklist:', error)
    res.status(500).json({ error: 'Failed to parse standard checklist', message: error.message })
  }
})

/**
 * POST /api/qa-comparison/standard-analyze
 * Run AI analysis for Standard Checklist questions against application evidence
 */
router.post('/standard-analyze', async (req, res) => {
  try {
    const { applicationData } = req.body

    if (!applicationData) {
      return res.status(400).json({ error: 'Application data is required' })
    }

    console.log('\n🔍 ===== STANDARD CHECKLIST COMPARISON START =====')

    // 0. Extract Funding Opportunity Number and derive fiscal year for path resolution
    const fundingOppNumber = extractFundingOppNumber(applicationData)
    const fiscalYear = fundingOppNumber ? deriveFiscalYear(fundingOppNumber) : null
    console.log(`🔢 Funding Opportunity: ${fundingOppNumber || 'Not found'}, Fiscal Year: ${fiscalYear || 'Unknown'}`)

    // 1. Parse standard checklist (dynamic path resolution with fiscal year)
    const dataPath = await resolveChecklistPath('standard', fiscalYear, req.body.checklistPath)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const scData = JSON.parse(raw)
    const { questions: userQuestions, metadata } = parseChecklistQuestions(scData)

    console.log(`📋 Parsed ${userQuestions.length} standard checklist questions from ${dataPath}`)

    // 1b. Extract PDF TOC links if not already present
    if (!applicationData.tocLinks) {
      try {
        const pdfPath = await findApplicationPdf(applicationData)
        if (pdfPath) {
          const pdfBuffer = await fs.readFile(pdfPath)
          const tocLinks = await extractTocLinks(pdfBuffer)
          if (tocLinks.length > 0) {
            applicationData.tocLinks = tocLinks
            console.log(`🔗 Lazy-extracted ${tocLinks.length} TOC links for standard checklist from ${basename(pdfPath)}`)
          }
        }
      } catch (linkErr) {
        console.warn(`⚠️ Lazy PDF link extraction skipped: ${linkErr.message}`)
      }
    }

    // 2. Prepare application evidence
    const applicationSummary = buildApplicationSummary(applicationData)

    // 3. Build AI prompt
    const questionsForAI = userQuestions.map(q => {
      let line = `Q${q.number}: ${q.question}`
      const qualifier = detectConditionalQualifier(q.question)
      if (qualifier) line += `\n  ⚠️ CONDITIONAL: ${qualifier}`
      if (q.suggestedResources) line += `\n  → Look in: ${q.suggestedResources}`
      return line
    }).join('\n\n')

    const { systemPrompt, userPrompt } = buildAnalysisPrompt({
      questionsForAI,
      applicationSummary,
      saatQuestionNums: [],
      saatData: null,
      saatSummary: '',
      fundingOppNumber,
      fiscalYear,
      checklistType: 'Standard'
    })

    console.log(`📝 Sending ${userQuestions.length} standard questions to AI...`)

    // 4. Call Azure OpenAI
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.1,
      maxTokens: 8000
    })

    const aiResponseText = response.choices[0]?.message?.content || ''
    const finishReason2 = response.choices[0]?.finishReason || 'unknown'
    console.log(`🤖 Standard AI response length: ${aiResponseText.length} chars, finishReason: ${finishReason2}`)
    console.log(`🤖 Standard AI response last 100 chars: ...${aiResponseText.slice(-100)}`)

    // 5. Parse AI response and build comparison results with server-side page resolution
    const aiAnswers = parseAIResponse(aiResponseText)
    console.log(`🤖 Standard parsed ${aiAnswers.length} AI answers`)
    const pageIndex = buildPageIndex(applicationData)
    const comparisonResults = buildComparisonResults(userQuestions, aiAnswers, pageIndex)

    // 6. Summary
    const summary = calculateSummary(comparisonResults)

    console.log(`📊 Standard Checklist Summary: ${summary.totalQuestions} questions — Yes: ${summary.yesCount}, No: ${summary.noCount}, N/A: ${summary.naCount}`)
    console.log('🔍 ===== STANDARD CHECKLIST COMPARISON COMPLETE =====\n')

    res.json({
      success: true,
      summary,
      metadata,
      results: comparisonResults,
      pageOffset: pageIndex.pageOffset || 0
    })

  } catch (error) {
    console.error('❌ Standard checklist comparison error:', error)
    res.status(500).json({
      error: 'Failed to run standard checklist comparison',
      message: error.message
    })
  }
})

// ─── Conditional qualifier detection ─────────────────────────────────────────

/**
 * Detect conditional qualifiers in a checklist question that determine applicability.
 * Returns a human-readable description of the condition, or null if unconditional.
 */
function detectConditionalQualifier(questionText) {
  if (!questionText) return null

  // Public agency questions
  if (/^public\s*agenc/i.test(questionText) || /public\s*agenc(?:y|ies)\s*:/i.test(questionText)) {
    return 'Applies ONLY to public agencies. If applicant is nonprofit → answer N/A.'
  }

  // New applicant questions
  if (/^new\s*applicant\s*:/i.test(questionText) || /^new\s*applicant\b/i.test(questionText)) {
    return 'Applies ONLY to new applicants. If applicant is existing/renewal → answer N/A.'
  }

  // New or competing supplement
  if (/new\s*(?:or|and)\s*competing\s*supplement\s*applicant/i.test(questionText)) {
    // Check for additional RPH/HP qualifier
    if (/requesting\s*RPH\s*funding/i.test(questionText)) {
      return 'Applies ONLY to new/competing supplement applicants requesting RPH funding. If not requesting RPH → answer N/A.'
    }
    if (/requesting\s*HP\s*(?:and\/or|or)\s*RPH\s*funding/i.test(questionText)) {
      return 'Applies ONLY to new/competing supplement applicants requesting HP and/or RPH funding. If not requesting HP or RPH → answer N/A.'
    }
    return 'Applies ONLY to new or competing supplement applicants. If existing applicant → answer N/A.'
  }

  // RPH-specific
  if (/requesting\s*RPH\s*funding/i.test(questionText)) {
    return 'Applies ONLY to applicants requesting RPH funding. If not requesting RPH → answer N/A.'
  }

  // HP-specific
  if (/requesting\s*HP\s*(?:and\/or|or)\s*RPH/i.test(questionText)) {
    return 'Applies ONLY to applicants requesting HP and/or RPH funding. If not requesting HP or RPH → answer N/A.'
  }

  // MSAW-specific
  if (/funding\s*is\s*only\s*requested\s*for\s*MSAW/i.test(questionText)) {
    return 'Conditional on MSAW-only funding. Check if applicant requests ONLY MSAW funding.'
  }

  // Q10-dependent (Questions 11-15 depend on Q10 answer)
  if (/if\s*the\s*answer\s*to\s*question\s*10\s*is\s*"?no"?/i.test(questionText)) {
    return 'If Q10 answer is "No", then Q11-Q15 should all be N/A.'
  }

  return null
}

/**
 * Find the application PDF on disk by extracting the application number
 * from the applicationData content and searching documents directories.
 * 
 * @param {Object} applicationData - The parsed application data with pages
 * @returns {Promise<string|null>} Full path to the PDF, or null if not found
 */
async function findApplicationPdf(applicationData) {
  // Extract application number from page content (e.g., "EHB Application Number: 242645")
  let appNumber = null
  for (const p of (applicationData.pages || []).slice(0, 5)) {
    for (const line of (p.lines || [])) {
      const content = line.content || line
      const m = content.match(/(?:EHB\s+)?Application\s+(?:Number|#):\s*(\d{5,7})/i)
      if (m) { appNumber = m[1]; break }
    }
    if (appNumber) break
  }

  if (!appNumber) {
    console.log(`🔗 findApplicationPdf: could not extract application number from data`)
    return null
  }

  console.log(`🔗 findApplicationPdf: looking for Application-${appNumber}.pdf`)

  const docsRoot = join(__dirname, '../../documents')

  // Search recursively: check root and all subdirectories
  async function searchDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isFile() && entry.name.endsWith('.pdf') && entry.name.includes(appNumber)) {
          return fullPath
        }
        if (entry.isDirectory()) {
          const found = await searchDir(fullPath)
          if (found) return found
        }
      }
    } catch { /* ignore unreadable dirs */ }
    return null
  }

  return searchDir(docsRoot)
}

// ─── Rules-Based AI Helpers ──────────────────────────────────────────────────

/**
 * Answer SAAT-related questions (Q10-Q16) as a focused batch.
 * Sends only SAAT data + relevant form pages (Form 1A, SF-424A, Form 5B) to AI.
 */
async function answerSAATQuestionsBatch(saatQuestions, appIndex, saatData, saatSummary, applicantProfile) {
  const results = []

  // Extract pages relevant to SAAT questions — use suggestedResources as primary hint
  const targetPageNums = new Set()

  // Collect from each question's suggestedResources
  for (const q of saatQuestions) {
    const srNames = parseSuggestedResources(q.suggestedResources)
    const items = lookupFormPages(srNames, appIndex.formPageMap)
    for (const item of items) {
      targetPageNums.add(item.page)
      targetPageNums.add(item.page + 1) // next page for multi-page forms
    }
  }

  // Also add standard SAAT-relevant forms as fallback
  const relevantFormNames = ['form 1a', 'sf-424a', 'sf-424', 'form 5b', 'form 5a', 'summary page', 'project abstract', 'project narrative']
  for (const [key, pageNum] of appIndex.formPageMap) {
    if (relevantFormNames.some(f => key.includes(f) || f.includes(key))) {
      targetPageNums.add(pageNum)
      targetPageNums.add(pageNum + 1)
    }
  }

  const relevantPages = []
  const pageNumbers = []
  for (const pn of [...targetPageNums].sort((a, b) => a - b)) {
    const pageData = appIndex.pages.find(p => p.pageNum === pn)
    if (pageData && !pageNumbers.includes(pn)) {
      relevantPages.push(`--- Page ${pn} ---\n${pageData.text}`)
      pageNumbers.push(pn)
    }
  }

  // Build focused prompt with only SAAT questions + relevant pages
  const questionsText = saatQuestions.map(q => {
    let line = `Q${q.number}: ${q.question}`
    if (q.rule?.description) line += `\n  Rule: ${q.rule.description}`
    return line
  }).join('\n\n')

  const systemPrompt = `You are an expert HRSA grant reviewer. Answer ONLY the questions below using the SAAT data and application form data provided.

RULES:
- Q10: "Yes" if the applicant's NOFO matches AND proposes a valid service area from the SAAT. If "No", Q11-Q15 are all "N/A".
- Q11: "Yes" if Form 1A patient projection >= 75% of SAAT Patient Target. Show the numbers.
- Q12: "Yes" if applicant proposes ALL Service Types listed in SAAT.
- Q13: "Yes" if annual SAC funding request (SF-424A) does NOT exceed SAAT Total Funding. Show the amounts.
- Q14: "Yes" if funding distribution matches SAAT (CHC, MSAW, HP, RPH).
- Q15: "Yes" if applicant proposes ALL population types listed in SAAT.
- Q16: "Yes" if Form 5B zip codes cover >= 75% of SAAT patient percentage.

WRITING STYLE:
- Write "evidence" as a clear, descriptive paragraph a reviewer can read. Reference the specific page, form name, and values found.
- Write "reasoning" as a brief explanation of how you reached your conclusion, not a numbered step list.
- Always mention the page number where you found the data (e.g., "Form 1A on page 135 shows 5,200 projected patients").

Return ONLY a JSON array:
[{"questionNumber":10,"aiAnswer":"Yes","confidence":"high","evidence":"The applicant proposes to serve Service Area 154 in Philadelphia, PA, which is listed under NOFO HRSA-26-004 in the SAAT. The Project Abstract on page 5 confirms the applicant is applying for this service area.","pageReferences":[5],"reasoning":"The NOFO number matches and the proposed service area is listed in the SAAT, confirming the applicant is proposing a valid announced service area."}]`

  const userPrompt = `SAAT QUESTIONS:\n${questionsText}\n\nSAAT REFERENCE DATA:\n${saatSummary || 'SAAT data not available — answer based on application evidence alone.'}\n\nAPPLICATION FORM DATA (relevant pages only):\n${relevantPages.slice(0, 12).join('\n\n')}\n\nAPPLICANT PROFILE:\nOrganization: ${applicantProfile.organizationName || 'Unknown'}\nType: ${applicantProfile.organizationType || 'Unknown'}\nCity/State: ${applicantProfile.city || ''}, ${applicantProfile.state || ''}`

  try {
    console.log(`   SAAT batch: ${saatQuestions.length} questions, ${relevantPages.length} pages, ${userPrompt.length} chars`)
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.1, maxTokens: 6000 })

    const aiText = response.choices[0]?.message?.content || ''
    console.log(`   SAAT AI response: ${aiText.length} chars, finishReason: ${response.choices[0]?.finishReason}`)
    const aiAnswers = parseAIResponse(aiText)

    for (const q of saatQuestions) {
      const aiResult = aiAnswers.find(a => a.questionNumber === q.number)
      if (aiResult) {
        // Resolve page references from evidence text using the appIndex
        const resolvedPages = resolvePageRefsFromIndex(aiResult.evidence, aiResult.reasoning, q.question, appIndex)
        results.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: aiResult.aiAnswer || 'Unable to determine',
          confidence: aiResult.confidence || 'medium',
          evidence: aiResult.evidence || '',
          pageReferences: resolvedPages.length > 0 ? resolvedPages : (aiResult.pageReferences || []),
          reasoning: aiResult.reasoning || '',
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: true,
          method: 'rules_saat_ai'
        })
      } else {
        results.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: 'Unable to determine',
          confidence: 'low',
          evidence: 'AI did not return an answer for this SAAT question.',
          pageReferences: [],
          reasoning: 'No analysis available',
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: true,
          method: 'rules_saat_ai'
        })
      }
    }
  } catch (err) {
    console.error(`❌ SAAT batch AI error: ${err.message}`)
    for (const q of saatQuestions) {
      results.push({
        questionNumber: q.number,
        question: q.question,
        aiAnswer: 'Unable to determine',
        confidence: 'low',
        evidence: `AI error: ${err.message}`,
        pageReferences: [],
        reasoning: 'AI call failed',
        suggestedResources: q.suggestedResources || '',
        requiresSAAT: true,
        method: 'rules_saat_ai'
      })
    }
  }

  return results
}

/**
 * Answer focused AI questions in a single batch.
 * Each question gets only its relevant 2-6 pages instead of the entire document.
 * Questions are grouped to minimize AI calls.
 */
async function answerFocusedQuestionsBatch(focusedQuestions, appIndex, applicantProfile) {
  const results = []

  // Group questions by similar focus pages to minimize AI calls
  // But cap each group at 4 questions to keep responses manageable
  const groups = []
  let currentGroup = []
  let currentPages = new Set()

  for (const q of focusedQuestions) {
    const { pageTexts, pageNumbers } = extractRelevantPages(q.rule || q, appIndex, q.suggestedResources)
    const qEntry = { ...q, pageTexts, pageNumbers }

    if (currentGroup.length >= 4) {
      groups.push({ questions: currentGroup, allPages: [...currentPages] })
      currentGroup = [qEntry]
      currentPages = new Set(pageNumbers)
    } else {
      currentGroup.push(qEntry)
      pageNumbers.forEach(p => currentPages.add(p))
    }
  }
  if (currentGroup.length > 0) {
    groups.push({ questions: currentGroup, allPages: [...currentPages] })
  }

  for (const group of groups) {
    // Collect all unique page texts for this group
    const allPageTexts = []
    const allPageNums = new Set()
    for (const q of group.questions) {
      for (let i = 0; i < q.pageTexts.length; i++) {
        if (!allPageNums.has(q.pageNumbers[i])) {
          allPageNums.add(q.pageNumbers[i])
          allPageTexts.push(q.pageTexts[i])
        }
      }
    }

    // If no relevant pages found, try to use first few pages as fallback
    if (allPageTexts.length === 0 && appIndex.pages.length > 0) {
      const fallbackPages = appIndex.pages.slice(0, 3)
      for (const p of fallbackPages) {
        allPageTexts.push(`--- Page ${p.pageNum} ---\n${p.text}`)
        allPageNums.add(p.pageNum)
      }
    }

    const questionsText = group.questions.map(q => {
      const aiQ = q.rule?.aiQuestion || q.question
      let line = `Q${q.number}: ${aiQ}`
      if (q.suggestedResources) line += `\n  → Look in: ${q.suggestedResources}`
      return line
    }).join('\n\n')

    const systemPrompt = `You are an expert HRSA grant reviewer. Answer ONLY the questions below using the application pages provided.

For each question, answer "Yes", "No", or "N/A" with specific evidence from the pages.

WRITING STYLE:
- Write "evidence" as a clear, descriptive paragraph a reviewer can read. Mention the specific page number, document/form name, and what you found.
- Write "reasoning" as a brief explanation of your conclusion, not a numbered step list.
- Example evidence: "The Budget Narrative on page 55 describes the applicant's staffing plan and operational costs. Form 5A on page 143 lists General Primary Medical Care under Column I (direct services), confirming the applicant will provide this service directly."

Return ONLY a JSON array:
[{"questionNumber":6,"aiAnswer":"Yes","confidence":"high","evidence":"The Budget Narrative on page 55 describes the applicant's direct involvement in staffing and operations. Form 5A on page 143 shows services the applicant will provide directly.","pageReferences":[55,143],"reasoning":"The applicant demonstrates a substantive role through direct service delivery and budget management, not merely applying on behalf of another organization."}]`

    const userPrompt = `QUESTIONS:\n${questionsText}\n\nAPPLICATION PAGES:\n${allPageTexts.join('\n\n')}\n\nAPPLICANT: ${applicantProfile.organizationName || 'Unknown'} (${applicantProfile.organizationType || 'Unknown'})`

    try {
      console.log(`   Focused batch: ${group.questions.length} questions, ${allPageTexts.length} pages, ${userPrompt.length} chars`)
      const response = await client.getChatCompletions(deployment, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], { temperature: 0.1, maxTokens: 4000 })

      const aiText = response.choices[0]?.message?.content || ''
      console.log(`   Focused AI response: ${aiText.length} chars, finishReason: ${response.choices[0]?.finishReason}`)
      const aiAnswers = parseAIResponse(aiText)

      for (const q of group.questions) {
        const aiResult = aiAnswers.find(a => a.questionNumber === q.number)
        if (aiResult) {
          const resolvedPages = resolvePageRefsFromIndex(aiResult.evidence, aiResult.reasoning, q.question, appIndex)
          results.push({
            questionNumber: q.number,
            question: q.question,
            aiAnswer: aiResult.aiAnswer || 'Unable to determine',
            confidence: aiResult.confidence || 'medium',
            evidence: aiResult.evidence || '',
            pageReferences: resolvedPages.length > 0 ? resolvedPages : (aiResult.pageReferences || []),
            reasoning: aiResult.reasoning || '',
            suggestedResources: q.suggestedResources || '',
            requiresSAAT: q.requiresSAAT || false,
            method: 'rules_focused_ai'
          })
        } else {
          results.push({
            questionNumber: q.number,
            question: q.question,
            aiAnswer: 'Unable to determine',
            confidence: 'low',
            evidence: 'AI did not return an answer for this question.',
            pageReferences: q.pageNumbers || [],
            reasoning: 'No analysis available',
            suggestedResources: q.suggestedResources || '',
            requiresSAAT: q.requiresSAAT || false,
            method: 'rules_focused_ai'
          })
        }
      }
    } catch (err) {
      console.error(`❌ Focused batch AI error: ${err.message}`)
      for (const q of group.questions) {
        results.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: 'Unable to determine',
          confidence: 'low',
          evidence: `AI error: ${err.message}`,
          pageReferences: [],
          reasoning: 'AI call failed',
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: q.requiresSAAT || false,
          method: 'rules_focused_ai'
        })
      }
    }
  }

  return results
}

/**
 * Resolve page references from AI evidence text using the application index.
 * Extracts form/attachment mentions and maps them to actual pages via formPageMap.
 */
function resolvePageRefsFromIndex(evidence, reasoning, question, appIndex) {
  const { formPageMap, formPageRanges, pages } = appIndex
  if (!formPageMap || formPageMap.size === 0) return []

  const combinedText = [evidence || '', reasoning || '', question || ''].join(' ')
  const foundPages = new Set()

  // Extract form/attachment mentions
  const patterns = [
    { regex: /Attachment\s*(\d+)/gi, keyFn: m => `attachment ${m[1]}` },
    { regex: /SF[-\s]?424\s*([A-Z]?)/gi, keyFn: m => `sf-424${(m[1]||'').toLowerCase()}`.trim() },
    { regex: /Form\s+(\d+[A-Z]?)/gi, keyFn: m => `form ${m[1].toLowerCase()}` },
    { regex: /Project\s+Narrative/gi, keyFn: () => 'project narrative' },
    { regex: /Project\s+Abstract/gi, keyFn: () => 'project abstract' },
    { regex: /Budget\s+Narrative/gi, keyFn: () => 'budget narrative' },
    { regex: /Summary\s+Page/gi, keyFn: () => 'summary page' },
    { regex: /Bylaws/gi, keyFn: () => 'bylaws' },
    { regex: /Organizational\s+Chart/gi, keyFn: () => 'organizational chart' },
    { regex: /Service\s+Area\s+Map/gi, keyFn: () => 'service area map' },
  ]

  for (const { regex, keyFn } of patterns) {
    regex.lastIndex = 0
    let m
    while ((m = regex.exec(combinedText)) !== null) {
      const key = keyFn(m)
      // Use formPageRanges to include pages of multi-page forms
      // For compact forms (≤5 pages), include the full range
      // For large sections (>5 pages), include only the start page
      if (formPageRanges && formPageRanges.has(key)) {
        const range = formPageRanges.get(key)
        const rangeSize = range.end - range.start + 1
        if (rangeSize <= 5) {
          for (let p = range.start; p <= range.end; p++) {
            foundPages.add(p)
          }
        } else {
          foundPages.add(range.start)
        }
        continue
      }
      // Fallback: try exact match from formPageMap (single page)
      if (formPageMap.has(key)) {
        foundPages.add(formPageMap.get(key))
        continue
      }
      // Try partial match
      for (const [mapKey, page] of formPageMap) {
        if (mapKey.includes(key) || key.includes(mapKey)) {
          foundPages.add(page)
          break
        }
      }
    }
  }

  // Also extract explicit "page X" references
  const pageRegex = /\bpage\s*(\d+)/gi
  let pm
  while ((pm = pageRegex.exec(combinedText)) !== null) {
    const num = parseInt(pm[1])
    if (num > 0 && num <= (pages.length || 200)) {
      foundPages.add(num)
    }
  }

  return [...foundPages].filter(p => p > 0).sort((a, b) => a - b).slice(0, 5)
}

// ─── Shared AI helpers (legacy, used by standard-analyze) ───────────────────

/**
 * Build the system + user prompts for checklist analysis.
 */
function buildAnalysisPrompt({ questionsForAI, applicationSummary, saatQuestionNums, saatData, saatSummary, fundingOppNumber, fiscalYear, checklistType }) {
  const systemPrompt = `You are an expert HRSA grant application reviewer performing a ${checklistType} Checklist review for a Service Area Competition (SAC) application.

For EACH question, follow this process:

1. APPLICABILITY CHECK: Questions marked ⚠️ CONDITIONAL have qualifiers (e.g., "Public Agencies:", "New applicant:", "requesting RPH funding:"). Check the APPLICANT PROFILE — if the applicant does NOT match the qualifier, answer "N/A".

2. EVIDENCE SEARCH: If the question applies, search the application evidence for proof.
   - Data priority: Forms (SF-424, Form 1A/5A/5B) > Attachments > Narrative > Abstract
   - Answer "Yes" only with clear evidence. Answer "No" only after thorough search.

3. In your "evidence" field, always mention the specific form names and attachment numbers where you found proof (e.g., "Attachment 11", "SF-424", "Form 5A"). Page numbers will be resolved automatically.
${saatQuestionNums.length > 0 ? `
SAAT DATA (Questions ${saatQuestionNums.join(', ')}):
- Q10: "Yes" if applicant's NOFO matches AND proposes a valid service area. If Q10="No", Q11-Q15 are all "N/A".
- Q11-Q16: Compare SAAT values vs application values (Form 1A patients, SF-424A funding, Form 5A services, Form 5B zips). Show calculations. If no SAAT match, answer from application evidence alone.
- Q16 zips: applicant must cover zips totaling ≥75% of SAAT patient percentage.` : ''}

Return ONLY a JSON array, one entry per question:
[{"questionNumber":1,"aiAnswer":"Yes","confidence":"high","evidence":"Attachment 11 on page 42 contains IRS determination letter...","pageReferences":[42],"reasoning":"Step 1: Question applies. Step 2: Found evidence on page 42. Step 3: Requirement met."}]`

  let userPrompt = `${checklistType.toUpperCase()} CHECKLIST QUESTIONS:\n${questionsForAI}\n\nAPPLICATION EVIDENCE:\n${applicationSummary}`

  if (saatQuestionNums.length > 0 && saatData?.found) {
    userPrompt += `\n\nSAAT REFERENCE DATA (for questions ${saatQuestionNums.join(', ')}):\n${saatSummary}`
  } else if (saatQuestionNums.length > 0 && !saatData?.found) {
    userPrompt += `\n\nNOTE: Questions ${saatQuestionNums.join(', ')} require SAAT data but it is not available (${!fundingOppNumber ? 'Funding Opportunity Number not found' : 'SAAT CSV not found for ' + fiscalYear}). For these questions, attempt to answer based on application evidence alone and note that SAAT cross-validation was not possible.`
  }

  return { systemPrompt, userPrompt }
}

/**
 * Parse AI JSON response with multiple fallback strategies.
 * Handles: markdown fences, truncated JSON, malformed brackets, individual object extraction.
 */
function parseAIResponse(aiResponseText) {
  if (!aiResponseText || aiResponseText.trim().length === 0) {
    console.error('❌ Empty AI response')
    return []
  }

  // Step 1: Strip markdown code fences and fix common AI JSON errors
  let cleaned = aiResponseText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()

  // Fix malformed pageReferences: AI sometimes puts unquoted strings like [SF-424, 11]
  // Convert to empty array since page refs are resolved server-side anyway
  cleaned = cleaned.replace(/"pageReferences"\s*:\s*\[([^\]]*)\]/g, (match, inner) => {
    // If the array contains non-numeric unquoted values, replace with empty array
    if (/[a-zA-Z]/.test(inner) && !/^[\s\d,"]*$/.test(inner)) {
      return '"pageReferences": []'
    }
    return match
  })

  // Step 2: Try direct parse of the full cleaned text
  try {
    const direct = JSON.parse(cleaned)
    if (Array.isArray(direct)) {
      console.log(`✅ Parsed ${direct.length} AI answers (direct)`)
      return direct
    }
  } catch { /* continue to fallbacks */ }

  // Step 3: Extract JSON array with greedy regex
  try {
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0])
      if (Array.isArray(parsed)) {
        console.log(`✅ Parsed ${parsed.length} AI answers (regex array)`)
        return parsed
      }
    }
  } catch { /* continue to repair */ }

  // Step 4: Repair truncated JSON — find the opening '[', then try closing incomplete objects
  try {
    const bracketIdx = cleaned.indexOf('[')
    if (bracketIdx >= 0) {
      let fragment = cleaned.substring(bracketIdx)
      // Close any open strings, objects, arrays
      const openBraces = (fragment.match(/\{/g) || []).length
      const closeBraces = (fragment.match(/\}/g) || []).length
      if (openBraces > closeBraces) {
        // Truncate to last complete object (last '}') and close the array
        const lastClose = fragment.lastIndexOf('}')
        if (lastClose > 0) {
          fragment = fragment.substring(0, lastClose + 1) + ']'
          const repaired = JSON.parse(fragment)
          if (Array.isArray(repaired)) {
            console.log(`⚠️ Parsed ${repaired.length} AI answers (repaired truncated JSON)`)
            return repaired
          }
        }
      }
    }
  } catch { /* continue to individual extraction */ }

  // Step 5: Last resort — extract individual JSON objects by matching {"questionNumber":...}
  try {
    const objects = []
    const objRegex = /\{\s*"questionNumber"\s*:\s*\d+[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g
    let match
    while ((match = objRegex.exec(cleaned)) !== null) {
      try {
        const obj = JSON.parse(match[0])
        objects.push(obj)
      } catch { /* skip malformed individual object */ }
    }
    if (objects.length > 0) {
      console.log(`⚠️ Extracted ${objects.length} AI answers (individual object fallback)`)
      return objects
    }
  } catch { /* all strategies failed */ }

  console.error('❌ All parse strategies failed for AI response')
  console.log('Raw AI response (first 500 chars):', aiResponseText.substring(0, 500))
  console.log('Raw AI response (last 200 chars):', aiResponseText.slice(-200))
  return []
}

/**
 * Build a form-to-page map from application data.
 * Two-pass approach:
 *   Pass 1: Scan each page's header lines, count how many distinct form names appear.
 *           Pages with 3+ distinct names are TOC/index pages → skip for mapping.
 *   Pass 2: For non-TOC pages, record the FIRST page where each form appears as a header.
 *           This gives us the actual start page of each form/attachment.
 *
 * Returns { formMap: Map<normalizedKey, pageNum>, pages: [{pageNum, text}] }
 */
function buildPageIndex(applicationData) {
  const pages = []
  const formMap = new Map()

  if (!applicationData?.pages) return { formMap, pages }

  const headerPatterns = [
    { regex: /\b(Attachment\s*(\d+)[A-Z]?)\b/i, keyFn: m => `attachment ${m[2]}` },
    { regex: /\b(SF[-\s]?424\s*([A-Z]?))\b/i, keyFn: m => `sf-424${(m[2]||'').toLowerCase()}` },
    { regex: /\b(Form\s*(\d+[A-Z]?))\b/i, keyFn: m => `form ${m[2].toLowerCase()}` },
    { regex: /\b(Summary\s*Page)\b/i, keyFn: () => 'summary page' },
    { regex: /\b(Project\s*Narrative)\b/i, keyFn: () => 'project narrative' },
    { regex: /\b(Project\s*Abstract)\b/i, keyFn: () => 'project abstract' },
    { regex: /\b(Budget\s*Narrative)\b/i, keyFn: () => 'budget narrative' },
    { regex: /\b(Budget\s*Justification)\b/i, keyFn: () => 'budget justification' },
    { regex: /\b(Organizational\s*Chart)\b/i, keyFn: () => 'organizational chart' },
    { regex: /\b(Board\s*of\s*Directors)\b/i, keyFn: () => 'board of directors' },
    { regex: /\b(Articles\s*of\s*Incorporation)\b/i, keyFn: () => 'articles of incorporation' },
    { regex: /\b(Bylaws)\b/i, keyFn: () => 'bylaws' },
    { regex: /\b(501\s*\(?c\)?\s*\(?3\)?)\b/i, keyFn: () => '501c3' },
    { regex: /\b(IRS\s*(?:Determination|Tax.Exempt))\b/i, keyFn: () => 'irs determination' },
    { regex: /\b(Co-?Applicant\s*Agreement)\b/i, keyFn: () => 'co-applicant agreement' },
    { regex: /\b(Indirect\s*Cost\s*Rate)\b/i, keyFn: () => 'indirect cost rate' },
    { regex: /\b(Needs\s*Assessment)\b/i, keyFn: () => 'needs assessment' },
    { regex: /\b(Scope\s*of\s*Project)\b/i, keyFn: () => 'scope of project' },
    { regex: /\b(Form\s*990)\b/i, keyFn: () => 'form 990' },
  ]

  // PRIORITY 0: Use PDF TOC hyperlinks if available (exact page destinations)
  // Detect page offset: pdfjs returns physical pages, but footers show different numbers
  const tocLinks = applicationData.tocLinks || []

  // Collect page text first (needed for offset detection)
  for (const p of applicationData.pages) {
    const pageNum = p.pageNumber || p.page || 0
    const lines = (p.lines?.map(l => l.content) || [])
    const fullText = lines.join('\n')
    if (fullText.trim()) pages.push({ pageNum, text: fullText, lines })
  }

  if (tocLinks.length > 0) {
    console.log(`🔗 buildPageIndex: Using ${tocLinks.length} PDF TOC hyperlinks`)
    for (const link of tocLinks) {
      if (!link.text || !link.destPage) continue
      // Use physical page directly (matches PDF viewer page index)
      if (link.text.length > 3) formMap.set(link.text.toLowerCase().trim(), link.destPage)
      for (const { regex, keyFn } of headerPatterns) {
        const m = link.text.match(regex)
        if (m) { formMap.set(keyFn(m), link.destPage); break }
      }
    }
  }

  // FALLBACK: Header scanning for entries not already in formMap from TOC links
  const pageInfos = applicationData.pages.map(p => {
    const pageNum = p.pageNumber || p.page || 0
    const lines = (p.lines?.map(l => l.content) || [])
    const fullText = lines.join('\n')
    const headerText = lines.slice(0, 5).join('\n')
    const foundKeys = new Set()
    for (const { regex, keyFn } of headerPatterns) {
      const m = headerText.match(regex)
      if (m) foundKeys.add(keyFn(m))
    }
    const fullPageKeys = new Set()
    for (const { regex, keyFn } of headerPatterns) {
      const m = fullText.match(new RegExp(regex.source, 'gi'))
      if (m) { for (const match of m) { const km = match.match(regex); if (km) fullPageKeys.add(keyFn(km)) } }
    }
    const isTOC = fullPageKeys.size >= 5
    return { pageNum, headerKeys: foundKeys, isTOC }
  })

  const tocPages = pageInfos.filter(p => p.isTOC).map(p => p.pageNum)
  if (tocPages.length > 0) {
    console.log(`📋 Detected TOC/index pages (skipping for form mapping): ${tocPages.join(', ')}`)
  }

  for (const info of pageInfos) {
    if (info.isTOC) continue
    for (const key of info.headerKeys) {
      if (!formMap.has(key)) formMap.set(key, info.pageNum)
    }
  }

  // Detect page offset: physical page vs footer "Page Number: N"
  let pageOffset = 0
  for (const p of pages) {
    for (const line of (p.lines || [])) {
      const m = line.match(/Page\s+Number:\s*(\d+)/i)
      if (m) {
        pageOffset = p.pageNum - parseInt(m[1])
        break
      }
    }
    if (pageOffset !== 0) break
  }

  if (formMap.size > 0) {
    console.log(`📑 Form/Attachment Index: ${formMap.size} entries${tocLinks.length > 0 ? ` (${tocLinks.length} from PDF links)` : ''}, pageOffset=${pageOffset}`)
  }

  return { formMap, pages, pageOffset }
}

/**
 * Resolve page references server-side.
 * Priority: evidence text > question text (evidence mentions are most relevant).
 * Extracts form/attachment names, looks them up in formMap.
 * Also extracts explicit "page X" references from AI evidence.
 * Returns at most 3 page numbers.
 */
function resolvePageReferences(evidence, reasoning, question, pageIndex) {
  const { formMap, pages } = pageIndex
  if (!formMap || formMap.size === 0) return []

  // Search evidence+reasoning first (higher priority), then question text
  const evidenceText = [evidence || '', reasoning || ''].join(' ')
  const questionText = question || ''
  const foundFromEvidence = new Set()
  const foundFromQuestion = new Set()

  const mentionPatterns = [
    { regex: /Attachment\s*(\d+)/gi, keyFn: m => `attachment ${m[1]}` },
    { regex: /SF[-\s]?424\s*([A-Z]?)/gi, keyFn: m => `sf-424${(m[1]||'').toLowerCase()}` },
    { regex: /Form\s*(\d+[A-Z]?)/gi, keyFn: m => `form ${m[1].toLowerCase()}` },
    { regex: /Summary\s*Page/gi, keyFn: () => 'summary page' },
    { regex: /Project\s*Narrative/gi, keyFn: () => 'project narrative' },
    { regex: /Project\s*Abstract/gi, keyFn: () => 'project abstract' },
    { regex: /Budget\s*(?:Narrative|Justification)/gi, keyFn: m => m[0].toLowerCase().includes('justification') ? 'budget justification' : 'budget narrative' },
    { regex: /Organizational\s*Chart/gi, keyFn: () => 'organizational chart' },
    { regex: /Board\s*of\s*Directors/gi, keyFn: () => 'board of directors' },
    { regex: /Articles\s*of\s*Incorporation/gi, keyFn: () => 'articles of incorporation' },
    { regex: /Bylaws/gi, keyFn: () => 'bylaws' },
    { regex: /501\s*\(?c\)?\s*\(?3\)?/gi, keyFn: () => '501c3' },
    { regex: /IRS\s*(?:Determination|Tax.Exempt)/gi, keyFn: () => 'irs determination' },
    { regex: /Co-?Applicant\s*Agreement/gi, keyFn: () => 'co-applicant agreement' },
    { regex: /Indirect\s*Cost\s*Rate/gi, keyFn: () => 'indirect cost rate' },
    { regex: /Needs\s*Assessment/gi, keyFn: () => 'needs assessment' },
    { regex: /Scope\s*of\s*Project/gi, keyFn: () => 'scope of project' },
    { regex: /Form\s*990/gi, keyFn: () => 'form 990' },
  ]

  function extractFromText(text, targetSet) {
    for (const { regex, keyFn } of mentionPatterns) {
      // Reset regex lastIndex for each text
      regex.lastIndex = 0
      let m
      while ((m = regex.exec(text)) !== null) {
        const key = keyFn(m)
        const pageNum = formMap.get(key)
        if (pageNum) targetSet.add(pageNum)
      }
    }

    // Also extract explicit "page X" or "pages X-Y" from AI evidence
    const pageNumRegex = /\bpage\s*(\d+)/gi
    let pm
    while ((pm = pageNumRegex.exec(text)) !== null) {
      const num = parseInt(pm[1])
      if (num > 0 && num <= (pages.length || 200)) {
        targetSet.add(num)
      }
    }
  }

  extractFromText(evidenceText, foundFromEvidence)
  extractFromText(questionText, foundFromQuestion)

  // Prefer evidence-derived pages; supplement with question-derived if needed
  let result = [...foundFromEvidence].filter(p => p > 0)
  if (result.length < 3) {
    const extras = [...foundFromQuestion].filter(p => p > 0 && !foundFromEvidence.has(p))
    result = result.concat(extras)
  }

  result.sort((a, b) => a - b)
  return result.slice(0, 3)
}

/**
 * Build analysis results: merge parsed checklist questions with AI answers.
 * Uses server-side page reference resolution instead of AI-provided page numbers.
 */
function buildComparisonResults(questions, aiAnswers, pageIndex) {
  const results = questions.map(q => {
    const aiResult = aiAnswers.find(a => a.questionNumber === q.number) || {
      aiAnswer: 'Unable to determine',
      confidence: 'low',
      evidence: 'AI did not return an answer for this question',
      pageReferences: [],
      reasoning: 'No analysis available'
    }

    // Resolve page references server-side from evidence text
    const resolvedPages = pageIndex
      ? resolvePageReferences(aiResult.evidence, aiResult.reasoning, q.question, pageIndex)
      : (aiResult.pageReferences || [])

    const finalPages = resolvedPages.length > 0 ? resolvedPages : (aiResult.pageReferences || [])

    return {
      questionNumber: q.number,
      question: q.question,
      aiAnswer: aiResult.aiAnswer,
      confidence: aiResult.confidence || 'low',
      evidence: aiResult.evidence || '',
      pageReferences: finalPages,
      reasoning: aiResult.reasoning || '',
      suggestedResources: q.suggestedResources || '',
      requiresSAAT: q.requiresSAAT || false
    }
  })

  // Log page resolution summary
  console.log('📄 Page references resolved:')
  results.forEach(r => {
    console.log(`   Q${r.questionNumber}: ${r.aiAnswer} → pages [${r.pageReferences.join(', ')}]`)
  })

  return results
}

/**
 * Calculate summary statistics from AI analysis results.
 */
function calculateSummary(results) {
  const totalQuestions = results.length
  const yesCount = results.filter(r => (r.aiAnswer || '').toLowerCase() === 'yes').length
  const noCount = results.filter(r => (r.aiAnswer || '').toLowerCase() === 'no').length
  const naCount = results.filter(r => { const v = (r.aiAnswer || '').toLowerCase(); return v === 'n/a' || v === 'not applicable' }).length
  const answeredCount = yesCount + noCount + naCount
  const agreementRate = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0
  return { totalQuestions, yesCount, noCount, naCount, agreementRate }
}

/**
 * Compress text to reduce AI token usage — ported from Prefunding Review.
 * Strips page markers, excessive whitespace, formatting chars, and noise.
 */
function compressText(text) {
  if (!text) return ''
  let compressed = text
  compressed = compressed.replace(/={10,}/g, '')
  compressed = compressed.replace(/PAGE \d+/gi, '')
  compressed = compressed.replace(/Page Number:\s*\d+/gi, '')
  compressed = compressed.replace(/Tracking Number[^\n]*/gi, '')
  compressed = compressed.replace(/\n{3,}/g, '\n\n')
  compressed = compressed.replace(/[ \t]{2,}/g, ' ')
  compressed = compressed.replace(/^\s+$/gm, '')
  compressed = compressed.replace(/Page \d+ of \d+/gi, '')
  compressed = compressed.replace(/[│┤├┼─┌┐└┘]/g, ' ')
  compressed = compressed.replace(/_{5,}/g, '')
  compressed = compressed.replace(/-{5,}/g, '')
  compressed = compressed.replace(/\.{5,}/g, '')
  compressed = compressed.replace(/  +/g, ' ')
  compressed = compressed.replace(/\n /g, '\n')
  compressed = compressed.split('\n').filter(line => line.trim().length > 0).join('\n')
  return compressed.trim()
}

/**
 * Extract key applicant profile facts from the application data.
 * These facts are used by the AI to determine question applicability (e.g., N/A for nonprofits on public agency questions).
 */
function extractApplicantProfile(applicationData) {
  const profile = {
    organizationType: null,       // e.g., "Nonprofit with 501C3", "Public Agency", "Tribal"
    organizationName: null,       // e.g., "AGAPE COMMUNITY HEALTH CENTER, INC."
    applicantType: null,          // e.g., "New", "Competing Supplement", "Existing"
    serviceAreaId: null,          // e.g., "109" — from Summary Page or Form 1A (authoritative)
    serviceAreaCity: null,        // e.g., "Jacksonville"
    serviceAreaState: null,       // e.g., "FL"
    fundingTypesRequested: [],    // e.g., ["CHC"], ["CHC", "MSAW", "HP", "RPH"]
    isPublicAgency: false,
    isNonprofit: false,
    isTribal: false,
    requestsRPH: false,
    requestsHP: false,
    requestsMSAW: false,
    isNewApplicant: false,
    isCompetingSupplement: false,
    zipCodesFromApp: [],          // zip codes found in Form 5A/5B
    serviceTypesFromApp: [],      // service types from Form 5A
    patientProjection: null,      // total unduplicated patients from Form 1A
    fundingRequested: null,       // total funding requested from SF-424A
    sourcePages: {},              // tracks which page each fact was found on
  }

  // Collect text per page (with page numbers) for source tracking
  const pageTexts = [] // { pageNum, text }
  const allText = []

  if (applicationData.pages) {
    applicationData.pages.slice(0, 50).forEach(p => {
      const pageNum = p.pageNumber || p.page || 0
      const lineText = p.lines?.map(l => l.content).join('\n') || ''
      if (lineText) {
        allText.push(lineText)
        pageTexts.push({ pageNum, text: lineText })
      }
    })
  }

  // Helper: find which page a regex pattern matches on
  function findPageForPattern(pattern) {
    for (const pt of pageTexts) {
      if (pattern.test(pt.text)) return pt.pageNum
    }
    return null
  }

  // Collect from key-value pairs
  if (applicationData.keyValuePairs) {
    applicationData.keyValuePairs.forEach(kv => {
      const key = (kv.key || '').toLowerCase()
      const val = (kv.value || '').trim()
      const kvPage = kv.pageNumber || kv.page || null

      if (key.includes('type of applicant') || key.includes('applicant type')) {
        profile.applicantType = val
        if (kvPage) profile.sourcePages.organizationType = kvPage
        if (/nonprofit|non-profit|501c/i.test(val)) { profile.isNonprofit = true; profile.organizationType = val }
        if (/public\s*agency/i.test(val)) { profile.isPublicAgency = true; profile.organizationType = val }
        if (/tribal|indian/i.test(val)) { profile.isTribal = true; profile.organizationType = val }
      }
      if (key.includes('applicant name') || key.includes('organization name') || key.includes('legal name')) {
        if (!profile.organizationName) {
          profile.organizationName = val
          if (kvPage) profile.sourcePages.organizationName = kvPage
        }
      }
    })
  }

  // Search full text for applicant type patterns
  const fullText = allText.join('\n')

  // Organization type detection
  if (!profile.organizationType) {
    const orgTypeMatch = fullText.match(/Type of Applicant[^:]*:\s*([^\n]+)/i)
    if (orgTypeMatch) {
      const val = orgTypeMatch[1].trim()
      profile.organizationType = val
      if (/nonprofit|non-profit|501c/i.test(val)) profile.isNonprofit = true
      if (/public\s*agency/i.test(val)) profile.isPublicAgency = true
      if (/tribal|indian/i.test(val)) profile.isTribal = true
      if (!profile.sourcePages.organizationType) {
        profile.sourcePages.organizationType = findPageForPattern(/Type of Applicant/i)
      }
    }
  }

  // Additional org type patterns (e.g., "M: Nonprofit with 501C3")
  if (!profile.organizationType) {
    const altMatch = fullText.match(/[A-Z]:\s*(Nonprofit[^\n]*|Public Agency[^\n]*|Tribal[^\n]*)/i)
    if (altMatch) {
      profile.organizationType = altMatch[1].trim()
      if (/nonprofit|non-profit|501c/i.test(altMatch[1])) profile.isNonprofit = true
      if (/public\s*agency/i.test(altMatch[1])) profile.isPublicAgency = true
      if (/tribal|indian/i.test(altMatch[1])) profile.isTribal = true
      if (!profile.sourcePages.organizationType) {
        profile.sourcePages.organizationType = findPageForPattern(/[A-Z]:\s*(?:Nonprofit|Public Agency|Tribal)/i)
      }
    }
  }

  // Organization name
  if (!profile.organizationName) {
    const nameMatch = fullText.match(/(?:Applicant|Organization|Legal)\s*Name[^:]*:\s*([^\n]+)/i)
    if (nameMatch) {
      profile.organizationName = nameMatch[1].trim()
      if (!profile.sourcePages.organizationName) {
        profile.sourcePages.organizationName = findPageForPattern(/(?:Applicant|Organization|Legal)\s*Name/i)
      }
    }
  }

  // New vs existing applicant
  if (/new\s*(?:access\s*point|applicant)/i.test(fullText)) {
    profile.isNewApplicant = true
    profile.sourcePages.isNewApplicant = findPageForPattern(/new\s*(?:access\s*point|applicant)/i)
  }
  if (/competing\s*supplement/i.test(fullText)) {
    profile.isCompetingSupplement = true
    profile.sourcePages.isCompetingSupplement = findPageForPattern(/competing\s*supplement/i)
  }

  // Funding types requested — look in SF-424A, budget sections
  if (/\bCHC\b/.test(fullText)) profile.fundingTypesRequested.push('CHC')
  if (/\bMSAW\b/.test(fullText)) { profile.fundingTypesRequested.push('MSAW'); profile.requestsMSAW = true }
  if (/\bHP\b/.test(fullText) && /homeless/i.test(fullText)) { profile.fundingTypesRequested.push('HP'); profile.requestsHP = true }
  if (/\bRPH\b/.test(fullText)) { profile.fundingTypesRequested.push('RPH'); profile.requestsRPH = true }

  // ─── Service Area ID extraction (from Summary Page, Form 1A — authoritative forms) ───
  // Priority: Summary Page > Form 1A > key-value pairs > Project Abstract
  // Pattern: "Service Area ID" or "Proposed Service Area" followed by a number
  const saIdPatterns = [
    /Summary\s*Page[\s\S]{0,500}?Service\s*Area\s*(?:ID|#|Number)?[:\s]*(\d{1,4})/i,
    /Service\s*Area\s*(?:ID|#|Number)\s*[:\s]*(\d{1,4})/i,
    /Proposed\s*Service\s*Area\s*(?:ID|#|Number)?[:\s]*(\d{1,4})/i,
    /Service\s*Area[:\s]*(\d{1,4})\s*(?:City|,)/i,
  ]
  for (const pat of saIdPatterns) {
    const saMatch = fullText.match(pat)
    if (saMatch) {
      profile.serviceAreaId = saMatch[1]
      profile.sourcePages.serviceAreaId = findPageForPattern(pat)
      break
    }
  }

  // Extract service area city/state from Summary Page or Form 5B
  const saCityMatch = fullText.match(/Service\s*Area[^:]*(?:City|Location)[^:]*:\s*([A-Za-z\s]+),\s*([A-Z]{2})/i)
    || fullText.match(/Proposed\s*Service\s*Area[^:]*:\s*\d+\s*(?:City[^:]*:\s*)?([A-Za-z\s]+),\s*([A-Z]{2})/i)
    || fullText.match(/City,?\s*State[:\s]*([A-Za-z\s]+),\s*([A-Z]{2})/i)
  if (saCityMatch) {
    profile.serviceAreaCity = saCityMatch[1].trim()
    profile.serviceAreaState = saCityMatch[2].trim()
  }

  // Zip codes from Form 5B (look specifically in Form 5B sections, not entire document)
  const zipMatches = fullText.match(/\b\d{5}(?:-\d{4})?\b/g) || []
  const uniqueZips = [...new Set(zipMatches)].filter(z => {
    const num = parseInt(z)
    return num >= 501 && num <= 99950 // valid US zip range
  })
  profile.zipCodesFromApp = uniqueZips.slice(0, 200)

  // Patient projection from Form 1A — look for specific Form 1A patterns first
  // Priority: Form 1A "unduplicated patients" > Summary Page "patient projection" > generic
  const patientPatterns = [
    /Form\s*1A[\s\S]{0,1000}?(?:total\s*)?unduplicated\s*patients?[^:]*:\s*([\d,]+)/i,
    /unduplicated\s*patients?\s*(?:projected|to\s*be\s*served)[^:]*:\s*([\d,]+)/i,
    /patient\s*(?:projection|target)[^:]*:\s*([\d,]+)/i,
    /(?:total\s*(?:unduplicated\s*)?patients?|patient\s*(?:projection|target|count))[^:]*:\s*([\d,]+)/i,
  ]
  for (const pat of patientPatterns) {
    const patientMatch = fullText.match(pat)
    if (patientMatch) {
      profile.patientProjection = patientMatch[1].replace(/,/g, '')
      profile.sourcePages.patientProjection = findPageForPattern(pat)
      break
    }
  }

  // Also check tables for patient projection (Form 1A is often a table)
  if (!profile.patientProjection && applicationData.tables) {
    for (const table of applicationData.tables) {
      for (const row of (table.structuredData || [])) {
        const vals = Object.entries(row)
        for (const [key, val] of vals) {
          if (/unduplicated\s*patients?|patient\s*(?:target|projection)/i.test(key) && /^\d[\d,]*$/.test((val || '').trim())) {
            profile.patientProjection = val.trim().replace(/,/g, '')
            profile.sourcePages.patientProjection = table.pageNumber || null
            break
          }
        }
        if (profile.patientProjection) break
      }
      if (profile.patientProjection) break
    }
  }

  // Funding requested from SF-424A
  const fundingMatch = fullText.match(/(?:total\s*(?:federal\s*)?(?:funding|funds?)\s*requested|federal\s*(?:funds?\s*)?requested)[^:]*:\s*\$?([\d,]+)/i)
  if (fundingMatch) {
    profile.fundingRequested = fundingMatch[1].replace(/,/g, '')
    profile.sourcePages.fundingRequested = findPageForPattern(/(?:total\s*(?:federal\s*)?(?:funding|funds?)\s*requested|federal\s*(?:funds?\s*)?requested)/i)
  }

  return profile
}

/**
 * Build a compressed summary of the application data for AI consumption.
 * Strips bounding boxes, polygons, word-level data — sends only essential text content.
 * Prepends an APPLICANT PROFILE section with key facts for applicability reasoning.
 */
function buildApplicationSummary(applicationData, preExtractedProfile = null) {
  const parts = []

  // Use pre-extracted profile if available, otherwise extract now
  const profile = preExtractedProfile || extractApplicantProfile(applicationData)
  const profileLines = [
    '=== APPLICANT PROFILE ===',
    `Organization Name: ${profile.organizationName || 'Unknown'}`,
    `Organization Type: ${profile.organizationType || 'Unknown'}`,
    `Is Nonprofit: ${profile.isNonprofit ? 'YES' : 'No'}`,
    `Is Public Agency: ${profile.isPublicAgency ? 'YES' : 'No'}`,
    `Is Tribal/Urban Indian: ${profile.isTribal ? 'YES' : 'No'}`,
    `Is New Applicant: ${profile.isNewApplicant ? 'YES' : 'No'}`,
    `Is Competing Supplement: ${profile.isCompetingSupplement ? 'YES' : 'No'}`,
    `Service Area ID: ${profile.serviceAreaId || 'Unknown'}`,
    `Service Area City/State: ${profile.serviceAreaCity && profile.serviceAreaState ? profile.serviceAreaCity + ', ' + profile.serviceAreaState : 'Unknown'}`,
    `Funding Types: ${profile.fundingTypesRequested.length > 0 ? profile.fundingTypesRequested.join(', ') : 'Unknown'}`,
    `Requests RPH: ${profile.requestsRPH ? 'YES' : 'No'}`,
    `Requests HP: ${profile.requestsHP ? 'YES' : 'No'}`,
    `Requests MSAW: ${profile.requestsMSAW ? 'YES' : 'No'}`,
    `Patient Projection: ${profile.patientProjection || 'Unknown'}`,
    `Funding Requested: ${profile.fundingRequested ? '$' + parseInt(profile.fundingRequested).toLocaleString() : 'Unknown'}`,
    `Zip Codes: ${profile.zipCodesFromApp.length > 0 ? profile.zipCodesFromApp.slice(0, 30).join(', ') + (profile.zipCodesFromApp.length > 30 ? ` ... (${profile.zipCodesFromApp.length} total)` : '') : 'Unknown'}`,
    '=== END APPLICANT PROFILE ==='
  ]
  parts.push(profileLines.join('\n'))

  // Include page text — extract only line content, no bounding boxes/polygons/words
  if (applicationData.pages) {
    const pageTexts = applicationData.pages
      .slice(0, 50)
      .map(p => {
        const lineText = p.lines?.map(l => l.content).join('\n') || p.text || ''
        if (!lineText.trim()) return null
        return `--- Page ${p.pageNumber || p.page} ---\n${lineText}`
      })
      .filter(Boolean)
    if (pageTexts.length > 0) {
      parts.push('APPLICATION CONTENT:\n' + compressText(pageTexts.join('\n\n')))
    }
  }

  // Include sections — compressed content only
  if (applicationData.sections) {
    const sectionTexts = applicationData.sections
      .slice(0, 50)
      .map(s => {
        const content = s.content?.map(c => c.text).join('\n') || ''
        return `[${s.sectionNumber || ''} ${s.title}]\n${content}`
      })
    parts.push('\nSECTIONS:\n' + compressText(sectionTexts.join('\n\n')))
  }

  // Include tables — structured data only, no raw cells/bounding boxes
  if (applicationData.tables) {
    const tableSummaries = applicationData.tables
      .filter(t => t.structuredData && t.structuredData.length > 0)
      .slice(0, 40)
      .map(t => {
        const headers = Object.keys(t.structuredData[0] || {})
        const rows = t.structuredData.slice(0, 10)
        const headerLine = headers.join(' | ')
        const rowLines = rows.map(r => headers.map(h => r[h] || '').join(' | '))
        return `[Table Page ${t.pageNumber || '?'}]\n${headerLine}\n${rowLines.join('\n')}`
      })
    if (tableSummaries.length > 0) {
      parts.push('\nTABLES:\n' + tableSummaries.join('\n\n'))
    }
  }

  // Include key-value pairs
  if (applicationData.keyValuePairs && applicationData.keyValuePairs.length > 0) {
    const kvTexts = applicationData.keyValuePairs
      .slice(0, 50)
      .map(kv => `${kv.key}: ${kv.value}`)
    parts.push('\nKEY-VALUE PAIRS:\n' + kvTexts.join('\n'))
  }

  const summary = parts.join('\n\n')
  // Safety cap for Azure OpenAI token limits (~120k chars ≈ 30k tokens)
  // Compression already reduces payload — this only triggers for extremely large applications
  return summary.substring(0, 120000)
}

export default router
