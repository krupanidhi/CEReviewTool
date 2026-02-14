import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join, basename } from 'path'
import { promises as fs } from 'fs'
import { loadSAATData, matchApplicantToServiceArea, buildSAATSummary, deriveFiscalYear } from '../services/saatService.js'
import { analyzeDocumentEnhanced } from '../services/enhancedDocumentIntelligence.js'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'

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

    // Only add if we have meaningful question text (skip noise like dates, page headers)
    if (questionText.length > 10) {
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

    console.log('\n🔍 ===== QA COMPARISON ANALYSIS START =====')

    // 0. Extract Funding Opportunity Number and derive fiscal year
    const fundingOppNumber = extractFundingOppNumber(applicationData)
    const fiscalYear = fundingOppNumber ? deriveFiscalYear(fundingOppNumber) : null
    console.log(`🔢 Funding Opportunity: ${fundingOppNumber || 'Not found'}, Fiscal Year: ${fiscalYear || 'Unknown'}`)

    // 1. Parse checklist questions (dynamic path resolution using fiscal year)
    const dataPath = await resolveChecklistPath('programspecific', fiscalYear, req.body.checklistPath)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const psqData = JSON.parse(raw)
    const { questions: userQuestions } = parseChecklistQuestions(psqData)

    console.log(`📋 Parsed ${userQuestions.length} questions from ${dataPath}`)

    // 2. Extract applicant profile for SAAT matching and AI context
    const applicantProfile = extractApplicantProfile(applicationData)
    console.log(`👤 Applicant: ${applicantProfile.organizationName || 'Unknown'}, Type: ${applicantProfile.organizationType || 'Unknown'}, Zips: ${applicantProfile.zipCodesFromApp.length}`)

    // 3. Load SAAT data and match to applicant's service area
    let saatData = null
    let saatSummary = ''
    const saatQuestionNums = userQuestions.filter(q => q.requiresSAAT).map(q => q.number)
    if (fiscalYear && saatQuestionNums.length > 0) {
      try {
        saatData = await loadSAATData(fiscalYear, fundingOppNumber)
        if (saatData.found) {
          // Match applicant to the correct service area before building summary
          matchApplicantToServiceArea(saatData, applicantProfile, applicationData)
          saatSummary = buildSAATSummary(saatData)
          const matched = saatData.matchedArea
          if (matched) {
            console.log(`📊 SAAT matched: SA ${matched.id} (${matched.city}, ${matched.state}) — ${saatData.matchMethod}`)
          } else {
            console.log(`📊 SAAT: ${saatData.serviceAreas.length} service areas loaded, but NO match to applicant — ${saatData.matchMethod}`)
          }
        } else {
          console.warn(`⚠️ SAAT data not found for ${fundingOppNumber} in ${fiscalYear}`)
        }
      } catch (saatErr) {
        console.warn(`⚠️ SAAT data load failed: ${saatErr.message}`)
      }
    }

    // 4. Prepare application evidence summary for AI (uses same applicantProfile)
    const applicationSummary = buildApplicationSummary(applicationData, applicantProfile)

    // 4. Build AI prompt
    console.log(`📊 SAAT questions: [${saatQuestionNums.join(', ')}]`)

    const questionsForAI = userQuestions.map(q => {
      let line = `Q${q.number}: ${q.question}`
      const qualifier = detectConditionalQualifier(q.question)
      if (qualifier) line += `\n  ⚠️ CONDITIONAL: ${qualifier}`
      if (q.suggestedResources) line += `\n  → Look in: ${q.suggestedResources}`
      if (q.requiresSAAT) line += `\n  → [REQUIRES SAAT DATA]`
      return line
    }).join('\n\n')

    const { systemPrompt, userPrompt } = buildAnalysisPrompt({
      questionsForAI,
      applicationSummary,
      saatQuestionNums,
      saatData,
      saatSummary,
      fundingOppNumber,
      fiscalYear,
      checklistType: 'Program-Specific'
    })

    console.log(`📝 Sending ${userQuestions.length} questions to AI (${saatQuestionNums.length} SAAT-tagged)`)
    console.log(`📄 Application summary: ${applicationSummary.length} chars`)
    console.log(`📊 SAAT data included: ${saatData?.found ? 'Yes' : 'No'}`)

    // 5. Call Azure OpenAI
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.1,
      maxTokens: 12000
    })

    const aiResponseText = response.choices[0]?.message?.content || ''
    console.log(`🤖 AI response length: ${aiResponseText.length} chars`)

    // 6. Parse AI response and build comparison results
    const aiAnswers = parseAIResponse(aiResponseText)
    const comparisonResults = buildComparisonResults(userQuestions, aiAnswers)

    // 7. Calculate summary stats
    const summary = calculateSummary(comparisonResults)

    console.log(`\n📊 QA Comparison Summary: ${summary.totalQuestions} questions — Yes: ${summary.yesCount}, No: ${summary.noCount}, N/A: ${summary.naCount}`)
    console.log('🔍 ===== QA COMPARISON ANALYSIS COMPLETE =====\n')

    res.json({
      success: true,
      summary,
      results: comparisonResults,
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
    console.log(`🤖 AI response length: ${aiResponseText.length} chars`)

    // 5. Parse AI response and build comparison results
    const aiAnswers = parseAIResponse(aiResponseText)
    const comparisonResults = buildComparisonResults(userQuestions, aiAnswers)

    // 6. Summary
    const summary = calculateSummary(comparisonResults)

    console.log(`📊 Standard Checklist Summary: ${summary.totalQuestions} questions — Yes: ${summary.yesCount}, No: ${summary.noCount}, N/A: ${summary.naCount}`)
    console.log('🔍 ===== STANDARD CHECKLIST COMPARISON COMPLETE =====\n')

    res.json({
      success: true,
      summary,
      metadata,
      results: comparisonResults
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

// ─── Shared AI helpers ───────────────────────────────────────────────────────

/**
 * Build the system + user prompts for checklist analysis.
 */
function buildAnalysisPrompt({ questionsForAI, applicationSummary, saatQuestionNums, saatData, saatSummary, fundingOppNumber, fiscalYear, checklistType }) {
  const systemPrompt = `You are an expert HRSA grant application reviewer performing a ${checklistType} Checklist review for a Service Area Competition (SAC) application.

You will receive checklist questions, an APPLICANT PROFILE, and evidence extracted from the grant application (and optionally SAAT data). For EACH question you must provide a thorough, evidence-based answer.

═══════════════════════════════════════════════════════════════
CRITICAL: APPLICABILITY-FIRST REASONING (MUST FOLLOW FOR EVERY QUESTION)
═══════════════════════════════════════════════════════════════
Before answering Yes or No, you MUST FIRST determine if the question APPLIES to this applicant.
Many checklist questions are conditional — they only apply to certain applicant types.

STEP 1: Read the question carefully for CONDITIONAL QUALIFIERS such as:
  - "Public Agencies:" → ONLY applies if applicant IS a public agency
  - "New applicant:" → ONLY applies if applicant IS a new applicant
  - "New or competing supplement applicant:" → ONLY applies to new or competing supplement applicants
  - "requesting RPH funding:" → ONLY applies if applicant requests RPH funding
  - "requesting HP and/or RPH funding:" → ONLY applies if applicant requests HP or RPH funding
  - "If funding is only requested for MSAW" → conditional on MSAW-only funding

STEP 2: Check the APPLICANT PROFILE at the top of the application evidence:
  - Organization Type (Nonprofit, Public Agency, Tribal, etc.)
  - Is New Applicant / Is Competing Supplement
  - Funding Types Requested (CHC, MSAW, HP, RPH)

STEP 3: Apply the rule:
  - If the question has a conditional qualifier AND the applicant does NOT meet that condition → answer "N/A"
  - Example: Q asks "Public Agencies: Does the application include Attachment 6: Co-Applicant Agreement?"
    If applicant is "Nonprofit with 501C3" (NOT a public agency) → answer "N/A"
    Reasoning: "This question applies only to public agencies. The applicant is a nonprofit (Type: M: Nonprofit with 501C3, page X), so Attachment 6 is not required."
  - Example: Q asks "New or competing supplement applicant requesting RPH funding: Does the applicant demonstrate consultation with residents of public housing?"
    If applicant does NOT request RPH funding → answer "N/A"
    Reasoning: "This question applies only to applicants requesting RPH funding. The applicant does not request RPH funding."

ONLY after confirming the question APPLIES should you evaluate Yes or No based on evidence.

═══════════════════════════════════════════════════════════════
EVIDENCE-BASED ANSWERING (when question DOES apply)
═══════════════════════════════════════════════════════════════

CRITICAL: DATA SOURCE PRIORITY (always follow this hierarchy):
  1. ACTUAL SUBMITTED FORMS (highest authority): Summary Page, Form 1A, Form 5A, Form 5B, SF-424, SF-424A
  2. Budget Narrative, Attachments
  3. Project Narrative
  4. Project Abstract (LOWEST authority — may contain outdated or draft values)
  If a value in the Project Abstract conflicts with a value on an actual form (e.g., Service Area ID,
  patient projections, funding amounts), ALWAYS use the value from the actual form.

- Answer "Yes" ONLY if you find clear, specific evidence that the requirement is met.
- Answer "No" ONLY if the question applies AND you find evidence the requirement is NOT met, or you thoroughly searched and found no evidence it is met.
- "evidence" must cite SPECIFIC values, field names, form names, attachment names, or table data found in the application. Include page numbers.
- "reasoning" must explain step-by-step WHY you reached your conclusion, referencing the evidence.
- Each question may include "Look in:" hints telling you WHERE to search first (e.g., "Project Narrative", "Form 5A", "SF-424A", "SAAT"). Always search those sources first, then broaden.
- For questions about whether forms/attachments are included, look for those specific document names, form headers, or attachment labels anywhere in the application.
- For questions about patient numbers, funding amounts, or service types, look for specific numeric values in tables, forms, and narrative text. ALWAYS prefer Form 1A and SF-424A values over Project Abstract.
- For questions about service areas or sites, look for Summary Page and Form 5B data, zip codes, and site addresses. The Service Area ID on the Summary Page is authoritative.
- Do NOT answer "No" simply because an attachment is missing — first check if the attachment is even REQUIRED for this applicant type.
- Only answer "Unable to determine" if you genuinely cannot find ANY relevant evidence after thorough search AND the question clearly applies to this applicant.
${saatQuestionNums.length > 0 ? `
═══════════════════════════════════════════════════════════════
SAAT DATA CROSS-REFERENCING (Questions ${saatQuestionNums.join(', ')})
═══════════════════════════════════════════════════════════════
These questions are marked [REQUIRES SAAT DATA].

CRITICAL FOR Q10 ("Does the applicant propose a service area announced under this NOFO number?"):
- Q10 is answered "Yes" if the applicant's Funding Opportunity Number (from SF-424) matches the NOFO
  AND the applicant proposes a valid service area (identified by Service Area ID, city/state, or zip codes).
- The SAAT data lists ALL service areas announced under this NOFO. The applicant does NOT need to match
  a specific SAAT row — they just need to propose ANY service area announced under the NOFO.
- If the applicant's service area is NOT in the SAAT CSV, that does NOT mean Q10 is "No" — the SAAT CSV
  may be a partial export. Check the application's NOFO number and proposed Service Area ID instead.
- If Q10 is "No", then Q11-Q15 must all be "N/A" per the checklist instructions.

FOR Q11-Q16 (require matched SAAT service area data):
1. Extract the relevant SAAT value from the MATCHED service area (e.g., "SAAT patient target: 19,137")
2. Find the corresponding APPLICATION value by searching the actual forms:
   - Patient counts: Search Form 1A tables for "total unduplicated patients" or similar
   - Funding amounts: Search SF-424A tables for federal funding requested
   - Service types: Search Form 5A for services listed as "Column I" (direct) or "Column II" (contract)
   - Zip codes: Search Form 5B for proposed service site zip codes
3. For ZIP CODE validation (Q16): Compare SAAT zip codes against the applicant's Form 5B zip codes.
   The SAAT provides zip codes with patient percentages. The applicant must include zip codes where
   the cumulative patient percentage reaches at least 75%, OR all zip codes if the total is less than 75%.
4. Show the calculation or comparison (e.g., "15,617 / 19,137 = 81.6%, exceeds 75% threshold")
5. Conclude based on the comparison
6. If NO matched SAAT service area was found, note that SAAT cross-validation was not possible and
   answer based on application evidence alone.

For SAAT questions, do NOT just check if a form exists — you must find and compare the ACTUAL NUMERIC VALUES.` : ''}

Return a JSON array with this EXACT structure (one entry per question):
[
  {
    "questionNumber": 1,
    "aiAnswer": "Yes",
    "confidence": "high",
    "evidence": "Found Project Narrative on pages 5-25, SF-424 on page 1, Budget on pages 30-35...",
    "pageReferences": [1, 5, 25, 30, 35],
    "reasoning": "Step 1: This question applies to all applicants (no conditional qualifier). Step 2: Searched application for Project Narrative — found on pages 5-25. Step 3: The requirement is met."
  }
]

Return ONLY the JSON array, no other text.`

  let userPrompt = `${checklistType.toUpperCase()} CHECKLIST QUESTIONS:\n${questionsForAI}\n\nAPPLICATION EVIDENCE:\n${applicationSummary}`

  if (saatQuestionNums.length > 0 && saatData?.found) {
    userPrompt += `\n\nSAAT REFERENCE DATA (for questions ${saatQuestionNums.join(', ')}):\n${saatSummary}`
  } else if (saatQuestionNums.length > 0 && !saatData?.found) {
    userPrompt += `\n\nNOTE: Questions ${saatQuestionNums.join(', ')} require SAAT data but it is not available (${!fundingOppNumber ? 'Funding Opportunity Number not found' : 'SAAT CSV not found for ' + fiscalYear}). For these questions, attempt to answer based on application evidence alone and note that SAAT cross-validation was not possible.`
  }

  return { systemPrompt, userPrompt }
}

/**
 * Parse AI JSON response, handling markdown code blocks and malformed JSON.
 */
function parseAIResponse(aiResponseText) {
  try {
    const jsonMatch = aiResponseText.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
  } catch (parseError) {
    console.error('❌ Failed to parse AI response:', parseError.message)
    console.log('Raw AI response (first 500 chars):', aiResponseText.substring(0, 500))
  }
  return []
}

/**
 * Build analysis results: merge parsed checklist questions with AI answers.
 */
function buildComparisonResults(questions, aiAnswers) {
  return questions.map(q => {
    const aiResult = aiAnswers.find(a => a.questionNumber === q.number) || {
      aiAnswer: 'Unable to determine',
      confidence: 'low',
      evidence: 'AI did not return an answer for this question',
      pageReferences: [],
      reasoning: 'No analysis available'
    }

    return {
      questionNumber: q.number,
      question: q.question,
      aiAnswer: aiResult.aiAnswer,
      confidence: aiResult.confidence || 'low',
      evidence: aiResult.evidence || '',
      pageReferences: aiResult.pageReferences || [],
      reasoning: aiResult.reasoning || '',
      suggestedResources: q.suggestedResources || '',
      requiresSAAT: q.requiresSAAT || false
    }
  })
}

/**
 * Calculate summary statistics from AI analysis results.
 */
function calculateSummary(results) {
  const totalQuestions = results.length
  const yesCount = results.filter(r => (r.aiAnswer || '').toLowerCase() === 'yes').length
  const noCount = results.filter(r => (r.aiAnswer || '').toLowerCase() === 'no').length
  const naCount = results.filter(r => { const v = (r.aiAnswer || '').toLowerCase(); return v === 'n/a' || v === 'not applicable' }).length
  return { totalQuestions, yesCount, noCount, naCount }
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
  }

  const allText = []

  // Collect all text from pages
  if (applicationData.pages) {
    applicationData.pages.slice(0, 20).forEach(p => {
      const lineText = p.lines?.map(l => l.content).join('\n') || ''
      if (lineText) allText.push(lineText)
    })
  }

  // Collect from key-value pairs
  if (applicationData.keyValuePairs) {
    applicationData.keyValuePairs.forEach(kv => {
      const key = (kv.key || '').toLowerCase()
      const val = (kv.value || '').trim()

      if (key.includes('type of applicant') || key.includes('applicant type')) {
        profile.applicantType = val
        if (/nonprofit|non-profit|501c/i.test(val)) { profile.isNonprofit = true; profile.organizationType = val }
        if (/public\s*agency/i.test(val)) { profile.isPublicAgency = true; profile.organizationType = val }
        if (/tribal|indian/i.test(val)) { profile.isTribal = true; profile.organizationType = val }
      }
      if (key.includes('applicant name') || key.includes('organization name') || key.includes('legal name')) {
        if (!profile.organizationName) profile.organizationName = val
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
    }
  }

  // Organization name
  if (!profile.organizationName) {
    const nameMatch = fullText.match(/(?:Applicant|Organization|Legal)\s*Name[^:]*:\s*([^\n]+)/i)
    if (nameMatch) profile.organizationName = nameMatch[1].trim()
  }

  // New vs existing applicant
  if (/new\s*(?:access\s*point|applicant)/i.test(fullText)) profile.isNewApplicant = true
  if (/competing\s*supplement/i.test(fullText)) profile.isCompetingSupplement = true

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
  if (fundingMatch) profile.fundingRequested = fundingMatch[1].replace(/,/g, '')

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
    '=== APPLICANT PROFILE (use these facts to determine question applicability) ===',
    `Organization Name: ${profile.organizationName || 'Unknown'}`,
    `Organization Type: ${profile.organizationType || 'Unknown'}`,
    `Is Nonprofit: ${profile.isNonprofit ? 'YES' : 'No'}`,
    `Is Public Agency: ${profile.isPublicAgency ? 'YES' : 'No'}`,
    `Is Tribal/Urban Indian: ${profile.isTribal ? 'YES' : 'No'}`,
    `Is New Applicant: ${profile.isNewApplicant ? 'YES' : 'No'}`,
    `Is Competing Supplement: ${profile.isCompetingSupplement ? 'YES' : 'No'}`,
    `Service Area ID (from Summary Page/Form 1A): ${profile.serviceAreaId || 'Not extracted — search Summary Page and Form 1A'}`,
    `Service Area City/State: ${profile.serviceAreaCity && profile.serviceAreaState ? profile.serviceAreaCity + ', ' + profile.serviceAreaState : 'Not extracted — search Summary Page'}`,
    `Funding Types Requested: ${profile.fundingTypesRequested.length > 0 ? profile.fundingTypesRequested.join(', ') : 'Not determined'}`,
    `Requests RPH Funding: ${profile.requestsRPH ? 'YES' : 'No'}`,
    `Requests HP Funding: ${profile.requestsHP ? 'YES' : 'No'}`,
    `Requests MSAW Funding: ${profile.requestsMSAW ? 'YES' : 'No'}`,
    `Patient Projection (Form 1A): ${profile.patientProjection || 'Not extracted — search Form 1A in application'}`,
    `Funding Requested (SF-424A): ${profile.fundingRequested ? '$' + parseInt(profile.fundingRequested).toLocaleString() : 'Not extracted — search SF-424A in application'}`,
    `Zip Codes Found in Application: ${profile.zipCodesFromApp.length > 0 ? profile.zipCodesFromApp.slice(0, 50).join(', ') + (profile.zipCodesFromApp.length > 50 ? ` ... (${profile.zipCodesFromApp.length} total)` : '') : 'Search Form 5B in application'}`,
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
