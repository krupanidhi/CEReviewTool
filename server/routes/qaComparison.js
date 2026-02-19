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
  loadRulesForFiscalYear,
  buildApplicationIndex, analyzeApplicantType, evaluateCondition,
  evaluateCompletenessCheck,
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
  console.log(`  📄 Sending ${basename(pdfPath)} (${(pdfBuffer.length / 1024).toFixed(0)} KB) to Azure DI...`)

  const analysisResult = await analyzeDocumentEnhanced(pdfBuffer, 'application/pdf')
  const structuredData = transformToStructured(analysisResult.data)

  // Also save the raw extraction for debugging
  const rawJsonPath = jsonOutputPath.replace('_structured.json', '_extraction.json')
  await fs.writeFile(rawJsonPath, JSON.stringify(analysisResult.data, null, 2))
  console.log(`  💾 Raw extraction saved: ${rawJsonPath}`)

  await fs.writeFile(jsonOutputPath, JSON.stringify(structuredData, null, 2))
  console.log(`  ✅ Structured JSON cached: ${jsonOutputPath}`)

  // Extract questions via OpenAI from raw DI content and cache immediately
  const rawContent = analysisResult.data?.content || ''
  if (rawContent) {
    try {
      // Detect checklist type from filename
      const fname = basename(pdfPath).toLowerCase()
      const checklistType = fname.includes('standard') ? 'standard' : 'programspecific'
      const questions = await extractQuestionsWithAI(rawContent, checklistType)
      if (questions.length > 0) {
        const questionsCache = jsonOutputPath.replace(/_structured\.json$/i, '_questions.json')
        const cacheData = { questions, metadata: {}, parsedAt: new Date().toISOString(), source: 'openai_extraction' }
        await fs.writeFile(questionsCache, JSON.stringify(cacheData, null, 2), 'utf-8')
        console.log(`  💾 Cached ${questions.length} questions to ${basename(questionsCache)}`)
      }
    } catch (aiErr) {
      console.warn(`  ⚠️ OpenAI question extraction failed (will retry on next load): ${aiErr.message}`)
    }
  }
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
 * Extract checklist questions using OpenAI from raw DI text content.
 *
 * DI extracts the text perfectly; OpenAI understands the structure and
 * identifies every numbered and unnumbered question regardless of format.
 * Result is cached as _questions.json — one-time cost per checklist per FY.
 *
 * @param {string} rawContent - Raw text content from DI extraction
 * @param {string} checklistType - 'programspecific' or 'standard'
 * @returns {Promise<Array>} Extracted questions
 */
async function extractQuestionsWithAI(rawContent, checklistType) {
  console.log(`🤖 Extracting questions from raw DI text via OpenAI (${checklistType})...`)
  console.log(`   Raw content length: ${rawContent.length} chars`)

  const systemPrompt = `You are a document analysis expert. Your task is to extract ALL checklist questions from a government grant review checklist document.

Rules:
- Extract EVERY numbered question (e.g., "1. Does the applicant...", "2. Public Agencies: Does...")
- Extract EVERY unnumbered question that has Yes/No/N/A checkboxes or answer options
- Include the FULL question text — do not truncate or summarize
- Preserve the original question numbering exactly as it appears
- For unnumbered questions, set originalNumber to null
- Identify which section each question belongs to (e.g., "Completeness Checklist", "Eligibility Checklist", "Patient Projection Funding Reduction Check")
- Note if a question references SAAT (Service Area Analysis Tool)
- Extract any "Suggested Resource(s)" mentioned near each question
- Do NOT include section headers, metadata, reviewer comments, or instructions as questions
- Do NOT include "As of" dates, "Action Taken", "Completion Status", or "Other comments" fields

Return a JSON object with this exact structure:
{
  "questions": [
    {
      "number": 1,
      "question": "Full question text here",
      "section": "Section name (e.g., Completeness Checklist)",
      "originalNumber": 1,
      "suggestedResources": "Resource text if any, or empty string",
      "requiresSAAT": false
    }
  ]
}`

  const userPrompt = `Extract ALL questions from this ${checklistType === 'programspecific' ? 'Program-Specific' : 'Standard'} checklist document:\n\n${rawContent}`

  const result = await client.getChatCompletions(deployment, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], {
    temperature: 0,
    maxTokens: 16000,
    responseFormat: { type: 'json_object' }
  })

  const responseText = result.choices[0]?.message?.content || '{}'
  const parsed = JSON.parse(responseText)
  const questions = parsed.questions || []

  // Normalize: ensure sequential numbering and add source field
  questions.forEach((q, idx) => {
    q.number = idx + 1
    q.source = 'openai_extraction'
    q.pageReference = q.pageReference || null
    q.suggestedResources = q.suggestedResources || ''
    q.requiresSAAT = q.requiresSAAT || false
  })

  console.log(`✅ OpenAI extracted ${questions.length} questions`)
  if (questions.length > 0) {
    questions.forEach(q => {
      console.log(`   Q${q.number} [${q.section || '?'}] (orig#${q.originalNumber || 'unnumbered'}): "${q.question.substring(0, 80)}..."`)
    })
  }

  return questions
}

/**
 * Deterministic question extraction from Document Intelligence structured JSON.
 *
 * Walks DI sections and extracts every checklist question:
 *   - Numbered questions: section title starts with "N. ..."
 *   - Unnumbered items: items in content with Yes/No/N/A checkboxes (e.g., Completeness Checklist items)
 *   - Merged questions: additional numbered questions embedded in a section's content
 *
 * No AI/GPT involved — purely deterministic, stable, and cacheable.
 *
 * @param {Array} sections - DI structured sections (data.document.sections)
 * @param {Array} parseLog - Log array for detailed output
 * @returns {Array} Extracted questions
 */
function extractQuestionsFromDI(sections, parseLog) {
  const questions = []
  // Track current section header (e.g., "Completeness Checklist", "Eligibility Checklist")
  let currentSectionHeader = 'Unknown'
  // Track which numbered questions we've already seen (to handle duplicate Q1 across sections)
  const seenNumbers = new Set()

  // Sections to skip entirely (only reviewer-level sections, NOT page-break artifacts)
  const SKIP_TITLES = /^(Recommendations|GMS\s+Recommendation|Close\s+Window)$/i
  const METADATA_LINE = /^(As of\s+\d|Action\s+Taken|Completion\s+Status|Other\s+comments)/i
  const TIMESTAMP_TITLE = /^\d{1,2}\/\d{1,2}\/\d{2,4}/

  parseLog.push(`--- DI-Based Question Extraction ---`)
  parseLog.push(`Source: Document Intelligence structured JSON (deterministic)`)
  parseLog.push('')

  function cleanQuestionText(text) {
    return text
      .replace(/\[\s*[X_\s]*\s*\]\s*(?:Yes|No|N\/?A)/gi, '')
      .replace(/:selected:|:unselected:/gi, '')
      .replace(/Suggested Resource\(?s?\)?:\s*[^\n]*/gi, '')
      .replace(/View\[/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function extractResourcesFromBlock(text) {
    const resources = []
    const regex = /Suggested Resource\(?s?\)?:\s*([^\n\[]*(?:\[[^\]]*\])?[^\n]*)/gi
    let rm
    while ((rm = regex.exec(text)) !== null) {
      let res = rm[1]
        .replace(/\[\s*X?\s*_?\s*\]\s*(Yes|No|N\/A)/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (res && res.length > 2) resources.push(res)
    }
    return [...new Set(resources)].join(' | ')
  }

  /**
   * Extract unnumbered checklist items from a section's content.
   * These are items like "Project Narrative", "Attachment 6: ..." that have
   * Yes/No/N/A checkboxes but no numbered prefix.
   *
   * Only extracts from known checklist header sections (Completeness, Eligibility, etc.)
   * to avoid picking up reviewer comments from page-break artifact sections.
   */
  function extractUnnumberedItems(content, sectionName, pageRef) {
    // Only extract unnumbered items from actual checklist sections, not page-break artifacts
    if (!/checklist|eligibility|completeness/i.test(sectionName)) {
      parseLog.push(`  (unnumbered scan skipped for non-checklist section: "${sectionName}")`)
      return
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line.length < 5) continue
      if (METADATA_LINE.test(line)) continue
      if (TIMESTAMP_TITLE.test(line)) continue
      if (/^Suggested Resource/i.test(line)) continue
      if (/^\[\s*[X_\s]*\s*\]\s*(Yes|No|N\/?A)/i.test(line)) continue
      if (/^(Eligibility|Completeness|Patient Projection)/i.test(line)) {
        // This is a sub-header, update section name
        currentSectionHeader = line.replace(/\s*Checklist\s*$/i, '').trim() + ' Checklist'
        continue
      }
      // Skip reviewer narrative text (starts with "The applicant...", "Based on...", etc.)
      if (/^(The applicant|Based on|A new budget|Close Window)/i.test(line)) continue
      // Skip if it looks like a numbered question (will be handled separately)
      if (/^\d{1,2}\.\s+/.test(line)) continue
      // Skip sentence fragments (lines starting with lowercase or short fragments)
      if (/^[a-z]/.test(line) && line.length < 60) continue

      // Check if this line is DIRECTLY followed by a checkbox or Suggested Resource within next 2 lines
      let hasCheckbox = false
      for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
        if (/\[\s*[X_\s]*\s*\]\s*(Yes|No|N\/?A)/i.test(lines[j])) { hasCheckbox = true; break }
        if (/Suggested Resource/i.test(lines[j])) { hasCheckbox = true; break }
      }
      if (!hasCheckbox) continue

      const questionText = cleanQuestionText(line)
      if (questionText.length < 5) continue

      // Gather the full block for resource extraction
      const blockLines = lines.slice(i, Math.min(i + 4, lines.length))
      const block = blockLines.join('\n')

      questions.push({
        number: questions.length + 1,
        question: questionText,
        section: sectionName || currentSectionHeader,
        originalNumber: null,
        source: 'document_intelligence',
        suggestedResources: extractResourcesFromBlock(block),
        requiresSAAT: /\bSAAT\b/i.test(block),
        pageReference: pageRef
      })
      parseLog.push(`  Q${questions.length} [${sectionName}] (unnumbered): "${questionText.substring(0, 100)}"`)
    }
  }

  /**
   * Extract a numbered question from a section title (and optionally its content).
   */
  function extractNumberedQuestion(title, content, sectionNumber, sectionName, pageRef) {
    // Extract question text from title — strip the "N. " prefix
    const titleMatch = title.match(/^(\d{1,2})\.\s+(.+)/)
    if (!titleMatch) return
    const origNum = parseInt(titleMatch[1])
    let questionText = cleanQuestionText(titleMatch[2])

    // Skip metadata/noise
    if (questionText.length < 5) return
    if (METADATA_LINE.test(questionText)) return

    // Skip duplicate question numbers (e.g., second "1." from Patient Projection section)
    // But track the section change
    if (seenNumbers.has(origNum)) {
      // This is a new section with restarted numbering — give it a unique sequential number
      const fullBlock = [title, content].filter(Boolean).join('\n')
      questions.push({
        number: questions.length + 1,
        question: questionText,
        section: sectionName || currentSectionHeader,
        originalNumber: origNum,
        source: 'document_intelligence',
        suggestedResources: extractResourcesFromBlock(fullBlock),
        requiresSAAT: /\bSAAT\b/i.test(fullBlock),
        pageReference: pageRef
      })
      parseLog.push(`  Q${questions.length} [${sectionName}] (orig#${origNum}, renumbered): "${questionText.substring(0, 100)}"`)
      return
    }

    seenNumbers.add(origNum)
    const fullBlock = [title, content].filter(Boolean).join('\n')

    questions.push({
      number: questions.length + 1,
      question: questionText,
      section: sectionName || currentSectionHeader,
      originalNumber: origNum,
      source: 'document_intelligence',
      suggestedResources: extractResourcesFromBlock(fullBlock),
      requiresSAAT: /\bSAAT\b/i.test(fullBlock),
      pageReference: pageRef
    })
    parseLog.push(`  Q${questions.length} [${sectionName}] (orig#${origNum}): "${questionText.substring(0, 100)}"`)
  }

  /**
   * Extract merged numbered questions from a section's content.
   * These are additional "N. ..." patterns found in the content text.
   * Also detects the "Patient Projection Funding Reduction Check" sub-section
   * which may appear as unnumbered text after a recognizable header.
   */
  function extractMergedQuestions(content, sectionName, pageRef) {
    if (!content) return

    // Detect Patient Projection sub-header position (used for section assignment)
    const ppHeaderIdx = content.search(/Patient Projection Funding Reduction Check/i)

    // ─── Find all "N. <uppercase letter>" patterns (numbered merged questions) ──
    const mergedRegex = /(?:^|\n)\s*(\d{1,2})\.\s+([A-Z])/g
    let match
    const mergedStarts = []
    while ((match = mergedRegex.exec(content)) !== null) {
      mergedStarts.push({ num: parseInt(match[1]), idx: match.index })
    }

    for (let i = 0; i < mergedStarts.length; i++) {
      const ms = mergedStarts[i]
      const textEnd = i + 1 < mergedStarts.length ? mergedStarts[i + 1].idx : content.length
      const rawBlock = content.substring(ms.idx, textEnd).trim()

      const afterPrefix = rawBlock.replace(/^\d{1,2}\.\s+/, '')
      const checkboxIdx = afterPrefix.search(/\[\s*[X_\s]*\s*\]\s*(?:Yes|No|N\/?A)/i)
      const suggestedIdx = afterPrefix.search(/Suggested Resource/i)
      let cutoff = afterPrefix.length
      if (checkboxIdx > 0) cutoff = Math.min(cutoff, checkboxIdx)
      if (suggestedIdx > 0) cutoff = Math.min(cutoff, suggestedIdx)
      let questionText = cleanQuestionText(afterPrefix.substring(0, cutoff))

      if (questionText.length < 5) continue
      if (METADATA_LINE.test(questionText)) continue

      if (seenNumbers.has(ms.num)) {
        parseLog.push(`  (merged) orig#${ms.num}: DUPLICATE SKIPPED`)
        continue
      }
      seenNumbers.add(ms.num)

      // Assign section: if after Patient Projection header, use that; otherwise use
      // the last known checklist header (not page-break artifact names like "Print All")
      let qSection = sectionName || currentSectionHeader
      if (ppHeaderIdx >= 0 && ms.idx > ppHeaderIdx) {
        qSection = 'Patient Projection Funding Reduction Check'
      } else if (/print\s+all|HRSA\s+EHBs/i.test(qSection)) {
        // Page-break artifact — use the previous checklist header instead
        qSection = 'Completeness and Eligibility Checklist'
      }

      questions.push({
        number: questions.length + 1,
        question: questionText,
        section: qSection,
        originalNumber: ms.num,
        source: 'document_intelligence',
        suggestedResources: extractResourcesFromBlock(rawBlock),
        requiresSAAT: /\bSAAT\b/i.test(rawBlock),
        pageReference: pageRef
      })
      parseLog.push(`  Q${questions.length} [${qSection}] (merged, orig#${ms.num}): "${questionText.substring(0, 100)}"`)
    }

    // ─── Extract Patient Projection question (unnumbered, after sub-header) ───
    if (ppHeaderIdx >= 0) {
      parseLog.push(`  → Sub-header detected: "Patient Projection Funding Reduction Check"`)
      const afterHeader = content.substring(ppHeaderIdx)
      const ppMatch = afterHeader.match(/If the Form 1A[^[]*/)
      if (ppMatch) {
        const ppText = cleanQuestionText(ppMatch[0])
        if (ppText.length > 10) {
          questions.push({
            number: questions.length + 1,
            question: ppText,
            section: 'Patient Projection Funding Reduction Check',
            originalNumber: null,
            source: 'document_intelligence',
            suggestedResources: extractResourcesFromBlock(afterHeader),
            requiresSAAT: /\bSAAT\b/i.test(afterHeader),
            pageReference: pageRef
          })
          parseLog.push(`  Q${questions.length} [Patient Projection] (from sub-header): "${ppText.substring(0, 100)}"`)
        }
      }
    }
  }

  // ─── Walk all sections ─────────────────────────────────────────────────────
  function processSection(section, depth = 0) {
    const title = (section.title || '').trim()
    const content = (section.content || '').trim()
    const pageRef = section.pageReference || null
    const secNum = section.sectionNumber

    // Skip non-question sections
    if (SKIP_TITLES.test(title)) {
      parseLog.push(`${'  '.repeat(depth)}SKIP: "${title.substring(0, 80)}"`)
      return
    }
    if (TIMESTAMP_TITLE.test(title)) {
      parseLog.push(`${'  '.repeat(depth)}SKIP (timestamp): "${title.substring(0, 80)}"`)
      return
    }

    parseLog.push(`${'  '.repeat(depth)}Processing: "${title.substring(0, 100)}" (sec#${secNum || '?'}, page ${pageRef || '?'})`)

    // Detect section headers (non-numbered top-level sections)
    const isHeader = !secNum && !(/^\d{1,2}\.\s+/.test(title))
    if (isHeader && title.length > 3) {
      // Update current section header name
      currentSectionHeader = title
        .replace(/\s*Checklist\s*$/i, '')
        .replace(/\s*Check\s*$/i, '')
        .trim()
      // Append "Checklist" or "Check" back if it was there
      if (/checklist/i.test(title)) currentSectionHeader += ' Checklist'
      else if (/check/i.test(title)) currentSectionHeader += ' Check'

      parseLog.push(`${'  '.repeat(depth)}  → Section header: "${currentSectionHeader}"`)

      // Extract unnumbered items from this header section's content
      if (content) {
        extractUnnumberedItems(content, currentSectionHeader, pageRef)
        // Also scan for merged numbered questions in header content
        // (e.g., "Print All | SA | HRSA EHBs" section may contain Q19 in FY26)
        extractMergedQuestions(content, currentSectionHeader, pageRef)
      }
    }

    // Numbered question in title
    if (/^\d{1,2}\.\s+/.test(title)) {
      // Detect if this question's TITLE indicates Patient Projection section
      // Only check the title — content may contain the PP header for a different section's merged questions
      if (/patient\s+projection|funding\s+reduction/i.test(title)) {
        currentSectionHeader = 'Patient Projection Funding Reduction Check'
        parseLog.push(`${'  '.repeat(depth)}  → Detected Patient Projection section from title`)
      }
      extractNumberedQuestion(title, content, secNum, currentSectionHeader, pageRef)

      // Check for merged questions in content
      if (content) {
        extractMergedQuestions(content, currentSectionHeader, pageRef)
      }
    }

    // Process children
    if (section.children) {
      section.children.forEach(child => processSection(child, depth + 1))
    }
  }

  sections.forEach(s => processSection(s))

  parseLog.push('')
  parseLog.push(`DI extraction complete: ${questions.length} questions found`)

  return questions
}

/**
 * Universal checklist question parser — Document Intelligence based.
 *
 * Extracts ALL questions deterministically from DI structured JSON:
 *   - Numbered questions (e.g., "1. Did the applicant include...")
 *   - Unnumbered items (e.g., "Project Narrative → Yes/No")
 *   - Multiple sections (Completeness, Eligibility, Patient Projection, etc.)
 *   - Merged questions in section content
 *
 * No AI/GPT involved — purely deterministic from DI extraction.
 * DI extraction is done once per FY and cached forever.
 *
 * @param {Object} data - Structured JSON from Azure DI extraction
 * @param {Object} [logOptions] - { logFile, fiscalYear, checklistType }
 * @returns {Promise<{ questions: Array, metadata: Object }>}
 */
async function parseChecklistQuestions(data, logOptions = {}) {
  const parseLog = []

  // ─── Check for cached _questions.json ──────────────────────────────────────
  // If a sourcePath is provided, derive a _questions.json cache path from it.
  // If the cache exists, load directly — no re-parsing needed.
  if (logOptions.sourcePath) {
    const questionsCache = logOptions.sourcePath.replace(/_structured\.json$/i, '_questions.json')
    try {
      const cached = await fs.readFile(questionsCache, 'utf-8')
      const parsed = JSON.parse(cached)
      if (parsed.questions && parsed.questions.length > 0) {
        console.log(`📋 Loaded ${parsed.questions.length} questions from cache: ${basename(questionsCache)}`)
        return { questions: parsed.questions, metadata: parsed.metadata || {} }
      }
    } catch {
      // Cache doesn't exist yet — will parse and create it below
    }
  }

  const metadata = {}
  const sections = data?.document?.sections || []

  parseLog.push(`=== Checklist Question Parsing Log ===`)
  parseLog.push(`Timestamp: ${new Date().toISOString()}`)
  if (logOptions.fiscalYear) parseLog.push(`Fiscal Year: ${logOptions.fiscalYear}`)
  if (logOptions.checklistType) parseLog.push(`Checklist Type: ${logOptions.checklistType}`)
  parseLog.push(`Total top-level sections in JSON: ${sections.length}`)
  parseLog.push('')

  // ─── Collect metadata from formFields ──────────────────────────────────────
  function collectMetadata(section) {
    const title = (section.title || '').trim()
    const content = (section.content || '').trim()

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

    if (section.children) {
      section.children.forEach(child => collectMetadata(child))
    }
  }

  sections.forEach(s => collectMetadata(s))

  // ─── Extract questions using OpenAI from raw DI text content ───────────────
  // Load raw content from the _extraction.json (DI's raw text output)
  let rawContent = ''
  if (logOptions.sourcePath) {
    const extractionPath = logOptions.sourcePath.replace(/_structured\.json$/i, '_extraction.json')
    try {
      const extractionRaw = await fs.readFile(extractionPath, 'utf-8')
      const extractionData = JSON.parse(extractionRaw)
      rawContent = extractionData.content || ''
    } catch {
      console.warn(`⚠️ Could not load extraction JSON from ${extractionPath}`)
    }
  }
  // If no extraction file, try to get content from the structured data itself
  if (!rawContent) {
    const allContent = []
    function gatherContent(section) {
      if (section.title) allContent.push(section.title)
      if (section.content) allContent.push(section.content)
      if (section.children) section.children.forEach(c => gatherContent(c))
    }
    sections.forEach(s => gatherContent(s))
    rawContent = allContent.join('\n')
  }

  parseLog.push(`Raw content length: ${rawContent.length} chars`)

  const questions = await extractQuestionsWithAI(rawContent, logOptions.checklistType || 'programspecific')

  parseLog.push('')
  parseLog.push(`--- Final Results ---`)
  parseLog.push(`Total questions extracted: ${questions.length}`)
  questions.forEach(q => {
    parseLog.push(`  Q${q.number} [${q.section || '?'}] (${q.source || '?'}): "${q.question.substring(0, 100)}${q.question.length > 100 ? '...' : ''}"`)
    parseLog.push(`    Page: ${q.pageReference || '?'}, SAAT: ${q.requiresSAAT || false}, OrigNum: ${q.originalNumber || 'n/a'}`)
    if (q.suggestedResources) parseLog.push(`    Resources: ${q.suggestedResources}`)
  })
  parseLog.push(`Metadata: ${JSON.stringify(metadata, null, 2)}`)
  parseLog.push('')

  // Write log to file
  if (logOptions.logFile) {
    const logContent = parseLog.join('\n')
    fs.appendFile(logOptions.logFile, logContent + '\n\n', 'utf-8')
      .then(() => console.log(`📝 Question parsing log written to ${logOptions.logFile}`))
      .catch(err => console.warn(`⚠️ Failed to write parsing log: ${err.message}`))
  }

  // ─── Cache parsed questions as _questions.json ─────────────────────────────
  if (logOptions.sourcePath && questions.length > 0) {
    const questionsCache = logOptions.sourcePath.replace(/_structured\.json$/i, '_questions.json')
    const cacheData = { questions, metadata, parsedAt: new Date().toISOString() }
    fs.writeFile(questionsCache, JSON.stringify(cacheData, null, 2), 'utf-8')
      .then(() => console.log(`💾 Cached ${questions.length} questions to ${basename(questionsCache)}`))
      .catch(err => console.warn(`⚠️ Failed to cache questions: ${err.message}`))
  }

  return { questions, metadata }
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
    const parseLogFile = join(__dirname, '../../logs/checklist_question_parsing.log')
    const { questions, metadata } = await parseChecklistQuestions(data, {
      logFile: parseLogFile,
      checklistType: 'programspecific',
      sourcePath: dataPath
    })

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
 * Determine if a document_review question is a pure presence/inclusion check.
 * These can be answered deterministically by checking if the attachment/form
 * exists in the application's TOC page references (formPageMap) — no AI needed.
 *
 * A question is presence-only if:
 *   1. The question text asks about document inclusion/presence
 *      (e.g., "Does the application include Attachment 12: Operational Plan?")
 *   2. The rule's lookFor items are attachment/form names (not content queries)
 *
 * Content-evaluation questions (e.g., "Does the applicant propose to operate..."
 * or "Does the applicant demonstrate consultation...") require AI to read and
 * interpret the document content, so they are NOT presence-only.
 */
function isPresenceOnlyQuestion(questionText, rule) {
  if (!questionText) return false
  const q = questionText.toLowerCase()

  // Pattern 1: "Does the application include [Attachment/Form]?"
  // Pattern 2: "Did the applicant include [a document]?"
  // These are pure presence checks — just verify the document exists in TOC
  const presencePatterns = [
    /does the application include/i,
    /did the applicant include/i,
    /does the application contain/i,
    /is .+ included in the application/i,
  ]

  const isPresenceText = presencePatterns.some(p => p.test(q))
  if (!isPresenceText) return false

  // Verify the lookFor items are attachment/form names (not content queries)
  const lookFor = rule.lookFor || []
  if (lookFor.length === 0) return false

  // If lookFor contains attachment numbers or form names, it's a presence check
  const hasAttachmentOrForm = lookFor.some(item =>
    /attachment\s+\d+/i.test(item) ||
    /form\s+\d+/i.test(item) ||
    /project\s+narrative/i.test(item) ||
    /budget\s+narrative/i.test(item) ||
    /organizational\s+chart/i.test(item) ||
    /bylaws/i.test(item) ||
    /sliding\s+fee/i.test(item) ||
    /co-?applicant\s+agreement/i.test(item)
  )

  return hasAttachmentOrForm
}

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
    const parseLogFile = join(__dirname, '../../logs/checklist_question_parsing.log')
    const { questions: userQuestions } = await parseChecklistQuestions(psqData, {
      logFile: parseLogFile,
      fiscalYear: fiscalYear || 'Unknown',
      checklistType: 'programspecific',
      sourcePath: dataPath
    })
    console.log(`📋 Parsed ${userQuestions.length} questions`)

    // 1b. Load rules from JSON (generated by server/scripts/generateRules.js)
    const programRules = await loadRulesForFiscalYear(fiscalYear, 'programspecific')

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
    //    Pass appIndex so flags are derived from specific form pages (Form 1A, SF-424, Summary Page)
    //    via TOC links — not from scanning all page text.
    const applicantProfile = extractApplicantProfile(applicationData)
    const applicantFlags = analyzeApplicantType(applicantProfile, applicationData, appIndex)
    console.log(`👤 Applicant: ${applicantProfile.organizationName || 'Unknown'}`)

    // 5. Load SAAT data
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

    // 6. Process each question using JSON-driven rules
    const comparisonResults = []
    const aiQuestionsToAsk = [] // Collect questions that need AI

    // Track answers by question number for dependency chains
    const answersByQNum = {}

    for (const q of userQuestions) {
      const rule = programRules.find(r => r.questionNumber === q.number)

      if (!rule) {
        // No rule for this question — send to AI for general analysis
        console.log(`   Q${q.number}: No rule → AI general ("${q.question.substring(0, 60)}...")`)
        aiQuestionsToAsk.push(q)
        continue
      }

      console.log(`   Q${q.number}: ${rule.answerStrategy} → "${q.question.substring(0, 60)}..."`)

      // Check condition (applicant type, funding type, etc.)
      const condResult = evaluateCondition(rule, applicantFlags)
      if (!condResult.applicable) {
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: 'N/A',
          confidence: 'high',
          evidence: condResult.reason,
          pageReferences: condResult.pageReferences || [],
          reasoning: condResult.reason,
          suggestedResources: q.suggestedResources || rule.suggestedResources || '',
          requiresSAAT: q.requiresSAAT || false,
          method: 'rules_condition'
        })
        answersByQNum[q.number] = 'N/A'
        continue
      }

      // Check dependency (e.g., Q11-Q15 depend on Q10=Yes)
      if (rule.dependsOn) {
        const depQNum = rule.dependsOn.question
        const depAnswer = answersByQNum[depQNum]
        if (depAnswer && depAnswer.toLowerCase() !== rule.dependsOn.requiredAnswer.toLowerCase()) {
          comparisonResults.push({
            questionNumber: q.number,
            question: q.question,
            aiAnswer: 'N/A',
            confidence: 'high',
            evidence: `Per the checklist instructions, since Question ${depQNum} was answered "${depAnswer}", this question is not applicable.`,
            pageReferences: [],
            reasoning: `Dependency: Q${depQNum}=${depAnswer}, so this question is N/A.`,
            suggestedResources: q.suggestedResources || rule.suggestedResources || '',
            requiresSAAT: q.requiresSAAT || false,
            method: 'rules_dependency'
          })
          answersByQNum[q.number] = 'N/A'
          continue
        }
      }

      // Route by answer strategy
      if (rule.answerStrategy === 'completeness_check') {
        // Deterministic: check TOC for required attachments based on applicant type
        const result = evaluateCompletenessCheck(rule, appIndex, applicantFlags)
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: result.aiAnswer,
          confidence: result.confidence,
          evidence: result.evidence,
          pageReferences: result.pageReferences,
          reasoning: result.reasoning,
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: false,
          method: 'rules_completeness_check'
        })
        answersByQNum[q.number] = result.aiAnswer
        console.log(`   Q${q.number}: completeness_check → ${result.aiAnswer}`)
      } else if (rule.answerStrategy === 'prior_answers_summary') {
        // Deferred: must be processed after all other questions are answered
        aiQuestionsToAsk.push({ ...q, rule, isDeferredSummary: true })
      } else if (rule.answerStrategy === 'saat_compare') {
        // SAAT questions — collect for batch AI call with SAAT data + complianceGuidance
        aiQuestionsToAsk.push({ ...q, rule, isSAAT: true })
      } else if (rule.answerStrategy === 'document_review' && isPresenceOnlyQuestion(q.question, rule)) {
        // Deterministic: check TOC page references for attachment/document existence
        // If the attachment key exists in formPageMap (resolved from TOC links), it exists.
        // No AI text search needed — TOC page references are authoritative.
        const result = answerPresenceQuestion(rule, appIndex, q.suggestedResources)
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: result.aiAnswer,
          confidence: result.confidence,
          evidence: result.evidence,
          pageReferences: result.pageReferences,
          reasoning: result.reasoning,
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: false,
          method: 'rules_presence_check'
        })
        answersByQNum[q.number] = result.aiAnswer
        console.log(`   Q${q.number}: presence_check → ${result.aiAnswer} (TOC-based, no AI)`)
      } else {
        // eligibility_check, content-based document_review, or any other strategy
        // All go to focused AI with complianceGuidance from the rule
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
          answersByQNum[r.questionNumber] = r.aiAnswer
          comparisonResults.push(r)
        }

        // Post-batch: enforce ALL dependency chains deterministically.
        // For each SAAT question with a dependsOn, check if the parent question's answer
        // disqualifies it. This handles:
        //   - Q10 (NOFO) → Q11-Q16 (if Q10 ≠ Yes → N/A)
        //   - Q11 (patient target) → Q20 (if Q11 ≠ Yes → N/A)
        //   - Any future dependency chains across FYs
        for (const q of saatQuestions) {
          if (!q.rule?.dependsOn) continue
          const depQNum = q.rule.dependsOn.question
          const depAnswer = answersByQNum[depQNum]
          const requiredAnswer = q.rule.dependsOn.requiredAnswer

          // Skip if parent not answered yet or parent answer matches required
          if (!depAnswer) continue
          if (depAnswer.toLowerCase() === requiredAnswer.toLowerCase()) continue

          // Parent answer doesn't match → override this question to N/A
          console.log(`   🔗 Q${depQNum}="${depAnswer}" (required "${requiredAnswer}") → Q${q.number} = N/A`)
          const existingIdx = comparisonResults.findIndex(r => r.questionNumber === q.number)
          const naResult = {
            questionNumber: q.number,
            question: q.question,
            aiAnswer: 'N/A',
            confidence: 'high',
            evidence: `Question ${depQNum} answered "${depAnswer}" — this question requires Q${depQNum}="${requiredAnswer}" to be applicable, per checklist instructions.`,
            pageReferences: [],
            reasoning: `Dependency: Q${depQNum}="${depAnswer}" (required "${requiredAnswer}"), so this question is N/A.`,
            suggestedResources: q.suggestedResources || '',
            requiresSAAT: q.requiresSAAT || false,
            method: 'rules_dependency'
          }
          if (existingIdx >= 0) {
            comparisonResults[existingIdx] = naResult
          } else {
            comparisonResults.push(naResult)
          }
          answersByQNum[q.number] = 'N/A'
        }

        // Post-batch: retry any SAAT questions that got "Unable to determine"
        // This happens when the AI batch response is truncated or skips a question.
        const unansweredSaat = saatQuestions.filter(q => {
          const answer = answersByQNum[q.number]
          return answer && /unable\s+to\s+determine/i.test(answer)
        })
        if (unansweredSaat.length > 0 && unansweredSaat.length <= 3) {
          console.log(`   🔄 Retrying ${unansweredSaat.length} unanswered SAAT question(s): ${unansweredSaat.map(q => 'Q' + q.number).join(', ')}`)
          const retryResults = await answerSAATQuestionsBatch(unansweredSaat, appIndex, saatData, saatSummary, applicantProfile)
          for (const r of retryResults) {
            if (r.aiAnswer && !/unable\s+to\s+determine/i.test(r.aiAnswer)) {
              // Replace the old "Unable to determine" with the retry result
              const existingIdx = comparisonResults.findIndex(cr => cr.questionNumber === r.questionNumber)
              if (existingIdx >= 0) {
                comparisonResults[existingIdx] = r
              }
              answersByQNum[r.questionNumber] = r.aiAnswer
              console.log(`   ✅ Retry Q${r.questionNumber}: ${r.aiAnswer}`)
            }
          }
        }
      }

      // 6b. Handle focused AI questions — each gets only its relevant pages
      //     Exclude deferred summary questions (they are resolved after all AI answers)
      if (focusedQuestions.length > 0) {
        const actualFocused = focusedQuestions.filter(q => !q.isDeferredSummary)
        if (actualFocused.length > 0) {
          const focusedResults = await answerFocusedQuestionsBatch(actualFocused, appIndex, applicantProfile)
          for (const r of focusedResults) {
            answersByQNum[r.questionNumber] = r.aiAnswer
          }
          comparisonResults.push(...focusedResults)
        }
      }
    }

    // 6c. Process deferred prior_answers_summary questions AFTER all other answers are known
    //     Uses AI to intelligently evaluate the nature of each finding, not just count No answers.
    const deferredQuestions = aiQuestionsToAsk.filter(q => q.isDeferredSummary)
    for (const q of deferredQuestions) {
      const result = await evaluatePriorAnswersSummary(q, answersByQNum, comparisonResults)
      comparisonResults.push({
        questionNumber: q.number,
        question: q.question,
        aiAnswer: result.aiAnswer,
        confidence: result.confidence,
        evidence: result.evidence,
        pageReferences: result.pageReferences,
        reasoning: result.reasoning,
        suggestedResources: q.suggestedResources || '',
        requiresSAAT: false,
        method: result.method
      })
      answersByQNum[q.number] = result.aiAnswer
      console.log(`   Q${q.number}: prior_answers_summary → ${result.aiAnswer} (${result.method})`)
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
    const standardLogFile = join(__dirname, '../../logs/checklist_question_parsing.log')
    const { questions, metadata } = await parseChecklistQuestions(data, {
      logFile: standardLogFile,
      checklistType: 'standard',
      sourcePath: dataPath
    })

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
 * Run rules-based AI analysis for Standard Checklist questions.
 * Uses the same pipeline as /analyze (program-specific):
 *   - Load rules from StandardRules.json
 *   - Build application index (TOC → page map)
 *   - Extract applicant profile + type flags
 *   - For each question: evaluate condition / completeness_check / focused AI
 */
router.post('/standard-analyze', async (req, res) => {
  try {
    const { applicationData } = req.body

    if (!applicationData) {
      return res.status(400).json({ error: 'Application data is required' })
    }

    console.log('\n🔍 ===== RULES-BASED STANDARD CHECKLIST START =====')
    console.log(`📦 applicationData: ${applicationData.pages?.length || 0} pages`)

    // 0. Extract Funding Opportunity Number and derive fiscal year
    const fundingOppNumber = extractFundingOppNumber(applicationData)
    const fiscalYear = fundingOppNumber ? deriveFiscalYear(fundingOppNumber) : null
    console.log(`🔢 Funding Opportunity: ${fundingOppNumber || 'Not found'}, Fiscal Year: ${fiscalYear || 'Unknown'}`)

    // 1. Parse standard checklist questions
    const dataPath = await resolveChecklistPath('standard', fiscalYear, req.body.checklistPath)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const scData = JSON.parse(raw)
    const standardLogFile = join(__dirname, '../../logs/checklist_question_parsing.log')
    const { questions: userQuestions, metadata } = await parseChecklistQuestions(scData, {
      logFile: standardLogFile,
      fiscalYear: fiscalYear || 'Unknown',
      checklistType: 'standard',
      sourcePath: dataPath
    })
    console.log(`📋 Parsed ${userQuestions.length} standard checklist questions from ${dataPath}`)

    // 1b. Load rules from StandardRules.json
    const standardRules = await loadRulesForFiscalYear(fiscalYear, 'standard')

    // 2. Extract PDF TOC links if not already present
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

    // 3. Build application index (TOC → page map) — deterministic, no AI
    const appIndex = buildApplicationIndex(applicationData)

    // 4. Extract applicant profile and analyze type flags
    const applicantProfile = extractApplicantProfile(applicationData)
    const applicantFlags = analyzeApplicantType(applicantProfile, applicationData, appIndex)
    console.log(`👤 Applicant: ${applicantProfile.organizationName || 'Unknown'} (${applicantProfile.organizationType || 'Unknown'})`)
    console.log(`   Flags: public_agency=${applicantFlags.isPublicAgency}, nonprofit=${applicantFlags.isNonprofit}, new=${applicantFlags.isNew}, competing_supp=${applicantFlags.isCompetingSupplement}`)

    // 5. Process each question using rules (same pattern as /analyze)
    const comparisonResults = []
    const aiQuestionsToAsk = []
    const answersByQNum = {}

    for (const q of userQuestions) {
      const rule = standardRules.find(r => r.questionNumber === q.number)

      if (!rule) {
        // No rule for this question — send to AI
        console.log(`   Q${q.number}: No rule → AI general ("${q.question.substring(0, 60)}...")`)
        aiQuestionsToAsk.push(q)
        continue
      }

      console.log(`   Q${q.number}: ${rule.answerStrategy} → "${q.question.substring(0, 60)}..."`)

      // Check condition (applicant type, etc.)
      const condResult = evaluateCondition(rule, applicantFlags)
      if (!condResult.applicable) {
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: 'N/A',
          confidence: 'high',
          evidence: condResult.reason,
          pageReferences: condResult.pageReferences || [],
          reasoning: condResult.reason,
          suggestedResources: q.suggestedResources || rule.suggestedResources || '',
          requiresSAAT: false,
          method: 'rules_condition'
        })
        answersByQNum[q.number] = 'N/A'
        continue
      }

      // Check dependency
      if (rule.dependsOn) {
        const depQNum = rule.dependsOn.question
        const depAnswer = answersByQNum[depQNum]
        if (depAnswer && depAnswer.toLowerCase() !== rule.dependsOn.requiredAnswer.toLowerCase()) {
          comparisonResults.push({
            questionNumber: q.number,
            question: q.question,
            aiAnswer: 'N/A',
            confidence: 'high',
            evidence: `Per the checklist instructions, since Question ${depQNum} was answered "${depAnswer}", this question is not applicable.`,
            pageReferences: [],
            reasoning: `Dependency: Q${depQNum}=${depAnswer}, so this question is N/A.`,
            suggestedResources: q.suggestedResources || rule.suggestedResources || '',
            requiresSAAT: false,
            method: 'rules_dependency'
          })
          answersByQNum[q.number] = 'N/A'
          continue
        }
      }

      // Route by answer strategy
      if (rule.answerStrategy === 'completeness_check') {
        // Deterministic: check TOC for required attachments based on applicant type
        const result = evaluateCompletenessCheck(rule, appIndex, applicantFlags)
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: result.aiAnswer,
          confidence: result.confidence,
          evidence: result.evidence,
          pageReferences: result.pageReferences,
          reasoning: result.reasoning,
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: false,
          method: 'rules_completeness_check'
        })
        answersByQNum[q.number] = result.aiAnswer
        console.log(`   Q${q.number}: completeness_check → ${result.aiAnswer}`)
      } else if (rule.answerStrategy === 'prior_answers_summary') {
        // Deferred: must be processed after all other questions are answered
        aiQuestionsToAsk.push({ ...q, rule, isDeferredSummary: true })
      } else if (rule.answerStrategy === 'document_review' && isPresenceOnlyQuestion(q.question, rule)) {
        // Deterministic: check TOC page references for attachment/document existence
        const result = answerPresenceQuestion(rule, appIndex, q.suggestedResources)
        comparisonResults.push({
          questionNumber: q.number,
          question: q.question,
          aiAnswer: result.aiAnswer,
          confidence: result.confidence,
          evidence: result.evidence,
          pageReferences: result.pageReferences,
          reasoning: result.reasoning,
          suggestedResources: q.suggestedResources || '',
          requiresSAAT: false,
          method: 'rules_presence_check'
        })
        answersByQNum[q.number] = result.aiAnswer
        console.log(`   Q${q.number}: presence_check → ${result.aiAnswer} (TOC-based, no AI)`)
      } else {
        // eligibility_check, content-based document_review, or any other strategy → focused AI
        aiQuestionsToAsk.push({ ...q, rule })
      }
    }

    // 6. Process AI questions with focused pages (same as program-specific)
    const actualAIQuestions = aiQuestionsToAsk.filter(q => !q.isDeferredSummary)
    if (actualAIQuestions.length > 0) {
      console.log(`\n🤖 Sending ${actualAIQuestions.length} standard questions to AI (focused prompts)...`)
      const focusedResults = await answerFocusedQuestionsBatch(actualAIQuestions, appIndex, applicantProfile)
      for (const r of focusedResults) {
        answersByQNum[r.questionNumber] = r.aiAnswer
      }
      comparisonResults.push(...focusedResults)
    }

    // 6b. Process deferred prior_answers_summary questions AFTER all other answers are known
    //     Uses AI to intelligently evaluate the nature of each finding, not just count No answers.
    const deferredStdQuestions = aiQuestionsToAsk.filter(q => q.isDeferredSummary)
    for (const q of deferredStdQuestions) {
      const result = await evaluatePriorAnswersSummary(q, answersByQNum, comparisonResults)
      comparisonResults.push({
        questionNumber: q.number,
        question: q.question,
        aiAnswer: result.aiAnswer,
        confidence: result.confidence,
        evidence: result.evidence,
        pageReferences: result.pageReferences,
        reasoning: result.reasoning,
        suggestedResources: q.suggestedResources || '',
        requiresSAAT: false,
        method: result.method
      })
      answersByQNum[q.number] = result.aiAnswer
      console.log(`   Q${q.number}: prior_answers_summary → ${result.aiAnswer} (${result.method})`)
    }

    // 7. Sort results by question number and calculate summary
    comparisonResults.sort((a, b) => a.questionNumber - b.questionNumber)
    const summary = calculateSummary(comparisonResults)

    // Log results
    console.log('\n📋 Final Standard Results:')
    comparisonResults.forEach(r => {
      console.log(`   Q${r.questionNumber}: ${r.aiAnswer} (${r.method || 'ai'}) → pages [${(r.pageReferences || []).join(', ')}]`)
    })
    console.log(`\n📊 Standard Summary: ${summary.totalQuestions} questions — Yes: ${summary.yesCount}, No: ${summary.noCount}, N/A: ${summary.naCount}`)
    console.log('🔍 ===== RULES-BASED STANDARD CHECKLIST COMPLETE =====\n')

    res.json({
      success: true,
      summary,
      metadata,
      results: comparisonResults,
      pageOffset: appIndex.pageOffset || 0
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

  // Search both documents/ and applications/ folders (FY/NOFO structure)
  const searchRoots = [
    join(__dirname, '../../documents'),
    join(__dirname, '../../applications')
  ]

  for (const root of searchRoots) {
    const found = await searchDir(root)
    if (found) return found
  }

  return null
}

// ─── Prior Answers Summary (AI-Based Eligibility Synthesis) ─────────────────

/**
 * Evaluate a prior_answers_summary question (e.g., "Is the applicant eligible?")
 * by sending ALL prior answers with their evidence and reasoning to AI.
 *
 * This replaces the naive "any No = ineligible" logic. The AI understands that:
 *   - Some "No" answers are eligibility-blocking (e.g., wrong NOFO, not a valid entity)
 *   - Some "No" answers are compliance deficiencies (e.g., missing attachment)
 *   - Some "N/A" answers are expected (e.g., question doesn't apply to this applicant type)
 *   - The overall eligibility determination is a judgment call, not a simple count
 *
 * Universal: works for any checklist type, any fiscal year, any number of questions.
 *
 * @param {Object} q - The deferred summary question object
 * @param {Object} answersByQNum - Map of question number → answer string
 * @param {Array} comparisonResults - All prior results with evidence/reasoning
 * @returns {Object} Result object with aiAnswer, confidence, evidence, reasoning
 */
async function evaluatePriorAnswersSummary(q, answersByQNum, comparisonResults) {
  const priorAnswers = Object.entries(answersByQNum)
    .filter(([qNum]) => parseInt(qNum) < q.number)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))

  const noAnswers = priorAnswers.filter(([, ans]) => /^no$/i.test(ans))
  const yesAnswers = priorAnswers.filter(([, ans]) => /^yes$/i.test(ans))
  const naAnswers = priorAnswers.filter(([, ans]) => /^n\/a$/i.test(ans))

  // Fast path: if all answers are Yes or N/A, no AI needed — clearly eligible
  if (noAnswers.length === 0) {
    return {
      aiAnswer: 'Yes',
      confidence: 'high',
      evidence: `All ${priorAnswers.length} prior checklist questions were answered Yes (${yesAnswers.length}) or N/A (${naAnswers.length}). No compliance issues were identified.`,
      reasoning: `All prior questions passed. The applicant meets all requirements evaluated in this checklist.`,
      pageReferences: [],
      method: 'rules_prior_answers_summary'
    }
  }

  // There are "No" answers — send to AI for intelligent synthesis
  // Build a structured summary of all prior answers for the AI
  const answerSummaryLines = priorAnswers.map(([qNum, ans]) => {
    const result = comparisonResults.find(r => r.questionNumber === parseInt(qNum))
    const question = result?.question || `Question ${qNum}`
    const evidence = result?.evidence || ''
    const reasoning = result?.reasoning || ''
    // Truncate evidence to keep prompt manageable
    const evidenceShort = evidence.length > 300 ? evidence.substring(0, 300) + '...' : evidence
    return `Q${qNum} [${ans.toUpperCase()}]: ${question}\n  Evidence: ${evidenceShort}\n  Reasoning: ${reasoning}`
  })

  const complianceGuidance = q.rule?.complianceGuidance || ''

  const systemPrompt = `You are an expert HRSA grant reviewer making a final eligibility determination based on all prior checklist findings.

YOUR TASK: Given the summary of all prior checklist question answers (Yes, No, N/A) with their evidence and reasoning, determine the overall eligibility of the applicant.

CRITICAL INSTRUCTIONS:
- Not all "No" answers are equal. You must evaluate the NATURE and SIGNIFICANCE of each finding:
  * A "No" on a service area/NOFO match question means the applicant applied for a service area not announced under this NOFO — this is an eligibility-blocking finding.
  * A "No" on a document inclusion question means a required attachment is missing — this is a compliance deficiency.
  * A "No" on a content/eligibility question means a substantive requirement is not met.
  * "N/A" answers are expected when questions don't apply to this applicant type — they are NOT deficiencies.
- Consider the checklist as a whole: are the findings collectively disqualifying, or are they minor/addressable?
- Your answer must be "Yes" (eligible) or "No" (not eligible).
${complianceGuidance ? `\nCOMPLIANCE GUIDANCE: ${complianceGuidance}` : ''}

WRITING STYLE:
- Write "evidence" as a clear summary paragraph listing the key findings and their significance.
- Write "reasoning" explaining WHY the applicant is or is not eligible based on the nature of the findings.
- Be specific about which questions drive the determination and why.

Return ONLY a JSON object (not an array):
{"aiAnswer":"Yes","confidence":"high","evidence":"...","reasoning":"..."}`

  const userPrompt = `SUMMARY QUESTION: ${q.question}

PRIOR CHECKLIST ANSWERS (${priorAnswers.length} total — ${yesAnswers.length} Yes, ${noAnswers.length} No, ${naAnswers.length} N/A):

${answerSummaryLines.join('\n\n')}`

  try {
    console.log(`   Prior answers summary: ${priorAnswers.length} answers (${noAnswers.length} No), sending to AI...`)
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.1, maxTokens: 1500 })

    const aiText = response.choices[0]?.message?.content || ''
    console.log(`   Prior answers AI response: ${aiText.length} chars, finishReason: ${response.choices[0]?.finishReason}`)

    // Parse the AI response
    let cleaned = aiText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
    try {
      const parsed = JSON.parse(cleaned)
      const answer = (parsed.aiAnswer || '').trim()
      // Validate answer is Yes or No
      if (/^(yes|no)$/i.test(answer)) {
        return {
          aiAnswer: answer.charAt(0).toUpperCase() + answer.slice(1).toLowerCase(),
          confidence: parsed.confidence || 'high',
          evidence: parsed.evidence || '',
          reasoning: parsed.reasoning || '',
          pageReferences: [],
          method: 'rules_prior_answers_ai'
        }
      }
    } catch (parseErr) {
      console.warn(`   ⚠️ Failed to parse prior_answers AI response: ${parseErr.message}`)
    }
  } catch (aiErr) {
    console.error(`   ❌ Prior answers AI error: ${aiErr.message}`)
  }

  // Fallback only if AI call fails entirely — use the old deterministic logic
  console.warn(`   ⚠️ Prior answers AI failed — falling back to deterministic logic`)
  const noQNums = noAnswers.map(([qNum]) => `Q${qNum}`).join(', ')
  return {
    aiAnswer: 'No',
    confidence: 'medium',
    evidence: `${noAnswers.length} of ${priorAnswers.length} prior checklist questions were answered No: ${noQNums}. AI-based synthesis was unavailable.`,
    reasoning: `Questions answered No (${noQNums}) — AI synthesis failed, using conservative deterministic fallback.`,
    pageReferences: [],
    method: 'rules_prior_answers_summary_fallback'
  }
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
    if (q.rule?.complianceGuidance) line += `\n  COMPLIANCE CRITERIA: ${q.rule.complianceGuidance}`
    if (q.suggestedResources || q.rule?.suggestedResources) line += `\n  SUGGESTED RESOURCES: ${q.suggestedResources || q.rule.suggestedResources}`
    return line
  }).join('\n\n')

  const systemPrompt = `You are an expert HRSA grant reviewer conducting a compliance review. Answer ONLY the questions below using the SAAT data and application form data provided.

CRITICAL INSTRUCTIONS:
- Each question includes COMPLIANCE CRITERIA from the User Guide that describe exactly what to evaluate.
- Cross-reference the SAAT data with the application forms to verify compliance.
- For patient target questions: compare actual numbers and show the calculation.
- For funding questions: compare actual dollar amounts and show the comparison.
- For service/population type questions: list what the SAAT requires and what the application proposes.
- If a question depends on another (e.g., "If Q10 is No, Q11-Q15 are N/A"), handle dependencies.

WRITING STYLE:
- Write "evidence" as a clear, descriptive paragraph a reviewer can read. Reference the specific page, form name, and values found.
- Write "reasoning" as a brief explanation of how the compliance criteria are or are not met.
- Always mention the page number where you found the data (e.g., "Form 1A on page 135 shows 5,200 projected patients").
- Show specific numbers, percentages, and comparisons.

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
        // Resolve page references from evidence text using the appIndex + rule lookFor
        const resolvedPages = resolvePageRefsFromIndex(aiResult.evidence, aiResult.reasoning, q.question, appIndex, q.rule)
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
      let line = `Q${q.number}: ${q.question}`
      if (q.rule?.complianceGuidance) line += `\n  COMPLIANCE CRITERIA: ${q.rule.complianceGuidance}`
      if (q.suggestedResources || q.rule?.suggestedResources) line += `\n  SUGGESTED RESOURCES: ${q.suggestedResources || q.rule.suggestedResources}`
      return line
    }).join('\n\n')

    const systemPrompt = `You are an expert HRSA grant reviewer conducting a compliance review. Answer ONLY the questions below using the application pages provided.

CRITICAL INSTRUCTIONS:
- Each question includes COMPLIANCE CRITERIA that describe exactly what to evaluate. Use these criteria — do NOT just check if a word or document name appears in the text.
- For document inclusion questions: verify the document is actually present as a distinct attachment/form, not just mentioned in passing text.
- For eligibility questions: evaluate whether the applicant meets the specific criteria described in the compliance guidance.
- For service/form questions: verify the specific content requirements are met (e.g., correct columns checked, required sections completed).

For each question, answer "Yes", "No", or "N/A" with specific evidence from the pages.

WRITING STYLE:
- Write "evidence" as a clear, descriptive paragraph a reviewer can read. Mention the specific page number, document/form name, and what you found.
- Write "reasoning" as a brief explanation of how the compliance criteria are or are not met.
- Be specific: cite page numbers, form names, column values, and actual content found.

Return ONLY a JSON array:
[{"questionNumber":6,"aiAnswer":"Yes","confidence":"high","evidence":"The Budget Narrative on page 55 describes the applicant's direct involvement in staffing and operations. Form 5A on page 143 shows services the applicant will provide directly.","pageReferences":[55,143],"reasoning":"The compliance criteria require the applicant to demonstrate a substantive role. The Budget Narrative and Form 5A confirm direct service delivery and budget management, not merely applying on behalf of another organization."}]`

    const userPrompt = `QUESTIONS WITH COMPLIANCE CRITERIA:\n${questionsText}\n\nAPPLICATION PAGES:\n${allPageTexts.join('\n\n')}\n\nAPPLICANT: ${applicantProfile.organizationName || 'Unknown'} (${applicantProfile.organizationType || 'Unknown'})`

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
          const resolvedPages = resolvePageRefsFromIndex(aiResult.evidence, aiResult.reasoning, q.question, appIndex, q.rule)
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
 * 
 * PRIORITY ORDER:
 *   1. Rule's lookFor targets → direct TOC page lookup (most accurate)
 *   2. Evidence/reasoning text → form/attachment mention extraction
 *   3. Explicit "page N" references from AI text (least reliable)
 * 
 * @param {string} evidence - AI evidence text
 * @param {string} reasoning - AI reasoning text
 * @param {string} question - The checklist question text
 * @param {Object} appIndex - Application index with formPageMap, formPageRanges, pages
 * @param {Object} [rule] - Optional rule with lookFor array for primary TOC lookup
 */
function resolvePageRefsFromIndex(evidence, reasoning, question, appIndex, rule) {
  const { formPageMap, formPageRanges, pages } = appIndex
  if (!formPageMap || formPageMap.size === 0) return []

  const combinedText = [evidence || '', reasoning || '', question || ''].join(' ')
  const foundPages = new Set()

  // PRIORITY 1: Use rule's lookFor targets for direct TOC page lookup.
  // This ensures that if a rule targets "Attachment 11", we always include
  // Attachment 11's exact TOC page — even if the AI evidence text doesn't
  // mention it by that exact name.
  if (rule?.lookFor && Array.isArray(rule.lookFor)) {
    for (const target of rule.lookFor) {
      const normalized = target.toLowerCase()
      // Try formPageMap exact match
      if (formPageMap.has(normalized)) {
        foundPages.add(formPageMap.get(normalized))
        continue
      }
      // Try extracting "Attachment N" pattern from the target
      const attMatch = target.match(/Attachment\s+(\d+)/i)
      if (attMatch) {
        const attKey = `attachment ${attMatch[1]}`
        if (formPageMap.has(attKey)) {
          foundPages.add(formPageMap.get(attKey))
          continue
        }
      }
      // Try extracting "Form N[A-Z]?" pattern from the target
      const formMatch = target.match(/Form\s+(\d+[A-Za-z]?)/i)
      if (formMatch) {
        const formKey = `form ${formMatch[1].toLowerCase()}`
        if (formPageMap.has(formKey)) {
          foundPages.add(formPageMap.get(formKey))
          continue
        }
      }
      // Try partial match
      for (const [mapKey, page] of formPageMap) {
        if (mapKey.includes(normalized) || normalized.includes(mapKey)) {
          foundPages.add(page)
          break
        }
      }
    }
  }

  // PRIORITY 2: Extract form/attachment mentions from evidence + reasoning text
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

  // New vs existing applicant — DO NOT set from full-text scanning.
  // These flags are determined authoritatively by analyzeApplicantType()
  // which reads Form 1A, SF-424, and Summary Page via TOC links.
  // Full-text scanning produces false positives from instructional text.

  // Funding types requested — DO NOT set from full-text scanning.
  // HP/RPH/MSAW appear in checklist instructions, NOFO descriptions, etc.
  // The authoritative source is the Summary Page, read by analyzeApplicantType().
  // fundingTypesRequested is populated here only for informational display,
  // NOT used for condition evaluation.
  if (/\bCHC\b/.test(fullText)) profile.fundingTypesRequested.push('CHC')

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
