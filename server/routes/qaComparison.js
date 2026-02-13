import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'
import { loadSAATData, buildSAATSummary, deriveFiscalYear } from '../services/saatService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const router = express.Router()

// Default checklist file locations (fallback)
const DEFAULT_PSQ_PATH = join(__dirname, '../../data/ProgramSpecificQuestions.json')
const DEFAULT_STD_PATH = join(__dirname, '../../data/CE Standard Checklist_structured.json')
const CHECKLIST_QUESTIONS_ROOT = join(__dirname, '../../checklistQuestions')

/**
 * Resolve a checklist file path dynamically:
 * 1. If an explicit path is provided, use it
 * 2. If a filename pattern is provided, search extractions/ and data/ folders
 * 3. Fall back to the default path
 */
async function resolveChecklistPath(explicitPath, filenamePattern, defaultPath, fiscalYear = null) {
  // Option 1: Explicit path provided
  if (explicitPath) {
    try {
      await fs.access(explicitPath)
      console.log(`📋 Using explicit checklist path: ${explicitPath}`)
      return explicitPath
    } catch {
      console.warn(`⚠️ Explicit path not found: ${explicitPath}, falling back`)
    }
  }

  // Option 2: Search by filename pattern — prioritize checklistQuestions/<FY>/ folder
  if (filenamePattern) {
    const searchDirs = []
    // If fiscal year is known, search its subfolder first
    if (fiscalYear) {
      searchDirs.push(join(CHECKLIST_QUESTIONS_ROOT, fiscalYear))
    }
    // Then search general folders
    searchDirs.push(
      CHECKLIST_QUESTIONS_ROOT,
      join(__dirname, '../../data'),
      join(__dirname, '../../extractions'),
      join(__dirname, '../../stored-checklists')
    )
    for (const dir of searchDirs) {
      try {
        const files = await fs.readdir(dir)
        const match = files.find(f => f.toLowerCase().includes(filenamePattern.toLowerCase()))
        if (match) {
          const resolved = join(dir, match)
          console.log(`📋 Found checklist by pattern "${filenamePattern}" in ${dir}: ${match}`)
          return resolved
        }
      } catch { /* dir doesn't exist, skip */ }
    }
  }

  // Option 3: Default path
  console.log(`📋 Using default checklist path: ${defaultPath}`)
  return defaultPath
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
 * Parse the ProgramSpecificQuestions.json to extract clean question/answer pairs
 */
function parseUserAnswers(data) {
  const questions = []
  const sections = data?.document?.sections || []

  function extractFromSection(section) {
    const title = section.title || ''
    const content = section.content || ''
    const combined = title + ' ' + content

    // Match numbered questions like "1. Did the applicant include..."
    // The answer is embedded as [ X ] Yes, [_] No, [_] N/A patterns
    const questionMatch = title.match(/^(\d+)\.\s+(.+)/)
    if (questionMatch) {
      const questionNum = parseInt(questionMatch[1])
      let questionText = questionMatch[2].trim()

      // Clean up question text generically:
      // 1. Strip everything from first "Suggested Resource" occurrence onwards (catches all resource refs)
      // 2. Remove answer checkbox markers like [X] Yes, [_] No, [_] N/A
      // 3. Clean up any remaining artifacts (orphaned brackets, pipes, URLs, page refs)
      questionText = questionText
        .replace(/\s*Suggested Resource.*$/i, '')
        .replace(/\[\s*X?\s*_?\s*\]\s*(Yes|No|N\/A)/gi, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\|/g, '')
        .replace(/\[[\s"?\\_]*\]/g, '')
        .replace(/\[\s*["?\\]*\s*$/g, '')
        .replace(/\s+/g, ' ')
        .trim()

      // Extract the user's answer from title + content
      const userAnswer = extractAnswer(combined)

      // Also check for sub-questions embedded in content
      const subQuestions = extractSubQuestions(content, questionNum)

      // Detect if this question references SAAT as a suggested resource
      const rawTitleUpper = title.toUpperCase()
      const rawContentUpper = content.toUpperCase()
      const requiresSAAT = rawTitleUpper.includes('SAAT') || rawContentUpper.includes('SAAT')

      questions.push({
        number: questionNum,
        question: questionText,
        userAnswer: userAnswer,
        rawTitle: title,
        rawContent: content,
        requiresSAAT: requiresSAAT
      })

      // Add sub-questions found in content
      subQuestions.forEach(sq => questions.push(sq))
    }

    // Recurse into children
    if (section.children) {
      section.children.forEach(child => extractFromSection(child))
    }
  }

  sections.forEach(section => {
    extractFromSection(section)
    if (section.children) {
      section.children.forEach(child => extractFromSection(child))
    }
  })

  // Deduplicate by question number, keeping the one with the most complete answer
  const deduped = {}
  questions.forEach(q => {
    if (!deduped[q.number] || q.userAnswer.length > deduped[q.number].userAnswer.length) {
      deduped[q.number] = q
    }
  })

  return Object.values(deduped).sort((a, b) => a.number - b.number)
}

/**
 * Extract Yes/No/N/A answer from text containing checkbox patterns
 */
function extractAnswer(text) {
  // Look for checked boxes: [ X ] Yes, [ X ] No, [ X ] N/A
  const yesChecked = /\[\s*X\s*\]\s*Yes/i.test(text)
  const noChecked = /\[\s*X\s*\]\s*No/i.test(text)
  const naChecked = /\[\s*X\s*\]\s*N\/?A/i.test(text)

  if (yesChecked && !noChecked && !naChecked) return 'Yes'
  if (noChecked && !yesChecked && !naChecked) return 'No'
  if (naChecked && !yesChecked && !noChecked) return 'N/A'
  if (yesChecked && noChecked) return 'Yes' // If both appear, first checked wins
  if (noChecked && naChecked) return 'No'

  // Check for unchecked patterns - all unchecked means no answer
  const hasCheckboxes = /\[\s*[X_\s]*\s*\]/.test(text)
  if (hasCheckboxes) return 'Not answered'

  return 'Not determined'
}

/**
 * Extract sub-questions embedded in content text
 */
function extractSubQuestions(content, parentNum) {
  const subQuestions = []
  // Match patterns like "7. Does the applicant..." or "17. New or competing..."
  const regex = /(\d+)\.\s+([^[]+?)(?:\[\s*[X_\s]*\s*\]\s*(?:Yes|No|N\/A))/gi
  let match
  while ((match = regex.exec(content)) !== null) {
    const num = parseInt(match[1])
    if (num !== parentNum && num > parentNum) {
      let questionText = match[2].trim()
        .replace(/Suggested Resource\(s\):[^\[]*\[[\"\?]*/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

      // Get the answer from the surrounding text
      const surroundingText = content.substring(match.index, match.index + match[0].length + 100)
      const answer = extractAnswer(surroundingText)

      subQuestions.push({
        number: num,
        question: questionText,
        userAnswer: answer,
        rawTitle: '',
        rawContent: surroundingText
      })
    }
  }
  return subQuestions
}

/**
 * GET /api/qa-comparison/questions
 * Return parsed questions with user-provided answers
 */
router.get('/questions', async (req, res) => {
  try {
    const dataPath = await resolveChecklistPath(req.query.path, req.query.filename || 'ProgramSpecificQuestions', DEFAULT_PSQ_PATH)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const data = JSON.parse(raw)
    const questions = parseUserAnswers(data)

    res.json({
      success: true,
      totalQuestions: questions.length,
      questions
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

    // 1. Parse user-provided answers (dynamic path resolution using fiscal year)
    const dataPath = await resolveChecklistPath(req.body.checklistPath, req.body.checklistFilename || 'ProgramSpecificQuestions', DEFAULT_PSQ_PATH, fiscalYear)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const psqData = JSON.parse(raw)
    const userQuestions = parseUserAnswers(psqData)

    console.log(`📋 Parsed ${userQuestions.length} questions from ${dataPath}`)

    // 2. Load SAAT data for Q11-Q15 validation (if fiscal year is available)
    let saatData = null
    let saatSummary = ''
    if (fiscalYear) {
      try {
        saatData = await loadSAATData(fiscalYear, fundingOppNumber)
        if (saatData.found) {
          saatSummary = buildSAATSummary(saatData)
          console.log(`📊 SAAT data loaded: patient_target=${saatData.patientTarget}, ${saatData.serviceTypes.length} service types, ${saatData.totalZipCodes} zip codes`)
        } else {
          console.warn(`⚠️ SAAT data not found for ${fundingOppNumber} in ${fiscalYear}`)
        }
      } catch (saatErr) {
        console.warn(`⚠️ SAAT data load failed: ${saatErr.message}`)
      }
    }

    // 3. Prepare application evidence summary for AI
    const applicationSummary = buildApplicationSummary(applicationData)

    // 4. Build AI prompt — clearly separate SAAT questions from non-SAAT questions
    const saatQuestionNums = userQuestions.filter(q => q.requiresSAAT).map(q => q.number)
    const nonSaatQuestionNums = userQuestions.filter(q => !q.requiresSAAT).map(q => q.number)

    console.log(`📊 SAAT questions: [${saatQuestionNums.join(', ')}], Non-SAAT questions: [${nonSaatQuestionNums.join(', ')}]`)

    // Build question list with clear SAAT tagging
    const questionsForAI = userQuestions.map(q => {
      if (q.requiresSAAT) {
        return `Question ${q.number} [REQUIRES SAAT DATA]: ${q.question}`
      }
      return `Question ${q.number}: ${q.question}`
    }).join('\n')

    const systemPrompt = `You are an expert HRSA grant application reviewer. You will analyze program-specific eligibility/completeness questions against a grant application.

For EACH question, you must:
- Answer "Yes", "No", or "N/A" based on the evidence
- Provide specific evidence citing exact values and page numbers from the application
- Give clear reasoning explaining your determination

RULES:
- Most questions can be answered by examining the application document directly (forms, attachments, tables, text)
- Be thorough — search all sections, tables, form data, and key-value pairs for relevant evidence
- For questions about forms/attachments, look for those specific forms in the application
- For questions about patient numbers, funding amounts, or service types, look for specific values in tables
- For questions about service areas or sites, look for Form 5B and related data
- Only answer "Unable to determine" if you genuinely cannot find ANY relevant evidence in the application after thorough search
- NEVER answer "Unable to determine" just because a question seems complex — look for the evidence first

${saatQuestionNums.length > 0 ? `SAAT-TAGGED QUESTIONS (${saatQuestionNums.join(', ')}):
Questions marked [REQUIRES SAAT DATA] need SAAT reference data to validate. SAAT data will be provided in the user message if available. For these questions, compare application values against SAAT values and show the specific numbers in your reasoning.` : ''}

Return a JSON array with this exact structure:
[
  {
    "questionNumber": 1,
    "aiAnswer": "Yes" | "No" | "N/A" | "Unable to determine",
    "confidence": "high" | "medium" | "low",
    "evidence": "Specific evidence found (cite exact values, field names, form names)",
    "pageReferences": [26, 135],
    "reasoning": "Clear explanation of why this answer was determined, with specific values"
  }
]

Return ONLY the JSON array, no other text.`

    // Build user prompt — application evidence first, then SAAT data scoped to tagged questions only
    let userPrompt = `PROGRAM-SPECIFIC QUESTIONS TO ANSWER:
${questionsForAI}

APPLICATION EVIDENCE:
${applicationSummary}`

    // Only append SAAT data if there are SAAT-tagged questions
    if (saatQuestionNums.length > 0 && saatData?.found) {
      userPrompt += `

SAAT REFERENCE DATA (use ONLY for questions ${saatQuestionNums.join(', ')} marked [REQUIRES SAAT DATA]):
${saatSummary}

For each SAAT question, your reasoning MUST include:
- The specific SAAT value (e.g., "SAAT patient target: 19,137")
- The corresponding application value (e.g., "Form 1A projected patients: 15,617")
- The calculation or comparison (e.g., "15,617 / 19,137 = 81.6%, which exceeds the 75% threshold")
- Your conclusion based on the comparison`
    } else if (saatQuestionNums.length > 0 && !saatData?.found) {
      userPrompt += `

NOTE FOR QUESTIONS ${saatQuestionNums.join(', ')}: These questions require SAAT data for full validation, but SAAT data is not available (${!fundingOppNumber ? 'Funding Opportunity Number not found in application' : 'SAAT CSV not found for ' + fiscalYear}). Answer "Unable to determine" for these specific questions only and explain that SAAT data is needed.`
    }

    console.log(`📝 Sending ${userQuestions.length} questions to AI (${saatQuestionNums.length} SAAT-tagged)`)
    console.log(`📄 Application summary: ${applicationSummary.length} chars`)
    console.log(`📊 SAAT data included: ${saatData?.found ? 'Yes' : 'No'}`)

    // 5. Call Azure OpenAI (increased tokens for SAAT-enriched prompts)
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.1,
      maxTokens: 8000
    })

    const aiResponseText = response.choices[0]?.message?.content || ''
    console.log(`🤖 AI response length: ${aiResponseText.length} chars`)

    // 6. Parse AI response
    let aiAnswers = []
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = aiResponseText.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        aiAnswers = JSON.parse(jsonMatch[0])
      }
    } catch (parseError) {
      console.error('❌ Failed to parse AI response:', parseError.message)
      console.log('Raw AI response:', aiResponseText.substring(0, 500))
    }

    // 6. Build comparison results
    const comparisonResults = userQuestions.map(uq => {
      const aiResult = aiAnswers.find(a => a.questionNumber === uq.number) || {
        aiAnswer: 'Unable to determine',
        confidence: 'low',
        evidence: 'AI did not return an answer for this question',
        pageReferences: [],
        reasoning: 'No analysis available'
      }

      const userAnswer = uq.userAnswer
      const aiAnswer = aiResult.aiAnswer
      const match = compareAnswers(userAnswer, aiAnswer)

      return {
        questionNumber: uq.number,
        question: uq.question,
        userAnswer,
        aiAnswer,
        match,
        confidence: aiResult.confidence || 'low',
        evidence: aiResult.evidence || '',
        pageReferences: aiResult.pageReferences || [],
        reasoning: aiResult.reasoning || ''
      }
    })

    // 7. Calculate summary stats
    const totalQuestions = comparisonResults.length
    const matchCount = comparisonResults.filter(r => r.match === 'agree').length
    const disagreeCount = comparisonResults.filter(r => r.match === 'disagree').length
    const uncertainCount = comparisonResults.filter(r => r.match === 'uncertain').length
    const agreementRate = totalQuestions > 0 ? Math.round((matchCount / totalQuestions) * 100) : 0

    const summary = {
      totalQuestions,
      matchCount,
      disagreeCount,
      uncertainCount,
      agreementRate
    }

    console.log(`\n📊 QA Comparison Summary:`)
    console.log(`  ✅ Agree: ${matchCount}`)
    console.log(`  ❌ Disagree: ${disagreeCount}`)
    console.log(`  ❓ Uncertain: ${uncertainCount}`)
    console.log(`  📈 Agreement Rate: ${agreementRate}%`)
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
 * Parse the CE Standard Checklist structured JSON to extract clean question/answer pairs
 */
function parseStandardChecklist(data) {
  const questions = []
  const metadata = {}
  const sections = data?.document?.sections || []

  sections.forEach(section => {
    const title = section.title || ''
    const content = section.content || ''
    const combined = title + ' ' + content

    // Extract numbered questions (1, 2, 3)
    const questionMatch = title.match(/^(\d+)\.\s+(.+)/)
    if (questionMatch) {
      const questionNum = parseInt(questionMatch[1])
      let questionText = questionMatch[2].trim()
        .replace(/\[X\]\s*/gi, '')
        .replace(/\[\]\s*/gi, '')
        .replace(/:unselected:/gi, '')
        .replace(/:selected:/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

      // Extract answer from checkbox patterns [X] Yes, [] No, etc.
      const userAnswer = extractStandardAnswer(combined)

      questions.push({
        number: questionNum,
        question: questionText,
        userAnswer: userAnswer
      })
    }

    // Extract metadata fields from formFields
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

    // Extract GMS Recommendation section
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
  })

  return { questions, metadata }
}

/**
 * Extract Yes/No/N/A from Standard Checklist checkbox patterns
 */
function extractStandardAnswer(text) {
  // Standard checklist uses [X] Yes [] No [] N/A format
  if (/\[X\]\s*Yes/i.test(text)) return 'Yes'
  if (/\[X\]\s*No/i.test(text) || /\[X\]\s*NO/i.test(text)) return 'No'
  if (/\[X\]\s*N\/?A/i.test(text)) return 'N/A'
  return 'Not determined'
}

/**
 * GET /api/qa-comparison/standard-questions
 * Return parsed Standard Checklist questions with user-provided answers and metadata
 */
router.get('/standard-questions', async (req, res) => {
  try {
    const dataPath = await resolveChecklistPath(req.query.path, req.query.filename || 'Standard Checklist', DEFAULT_STD_PATH)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const data = JSON.parse(raw)
    const { questions, metadata } = parseStandardChecklist(data)

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
    const dataPath = await resolveChecklistPath(req.body.checklistPath, req.body.checklistFilename || 'Standard Checklist', DEFAULT_STD_PATH, fiscalYear)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const scData = JSON.parse(raw)
    const { questions: userQuestions, metadata } = parseStandardChecklist(scData)

    console.log(`📋 Parsed ${userQuestions.length} standard checklist questions from ${dataPath}`)

    // 2. Prepare application evidence
    const applicationSummary = buildApplicationSummary(applicationData)

    // 3. Build AI prompt
    const questionsForAI = userQuestions.map(q =>
      `Question ${q.number}: ${q.question}`
    ).join('\n')

    const systemPrompt = `You are an expert HRSA grant application reviewer. You will be given:
1. Standard review checklist questions for a Service Area Competition (SAC) application
2. Evidence extracted from the grant application document

Your task is to INDEPENDENTLY determine the answer to each question based SOLELY on the application evidence.

These are STANDARD checklist questions (not program-specific). They check:
- Question 1: Whether all required attachments are present (Project Narrative, SF-424, Budget, Forms 1A-8, Attachments 1-12, etc.)
- Question 2: Whether the applicant is an eligible entity type (non-profit, governmental unit, tribal org, etc.)
- Question 3: Any other observations or comments about the application

For each question:
- Answer "Yes", "No", or "N/A"
- Provide specific evidence from the application
- List which required documents/attachments were found or missing
- Reference page numbers

Return your analysis as a JSON array:
[
  {
    "questionNumber": 1,
    "aiAnswer": "Yes" | "No" | "N/A" | "Unable to determine",
    "confidence": "high" | "medium" | "low",
    "evidence": "Brief description of evidence found",
    "pageReferences": [1, 2],
    "reasoning": "Detailed reasoning",
    "details": "For Q1: list of attachments found/missing. For Q2: entity type evidence. For Q3: any notable observations."
  }
]

Return ONLY the JSON array, no other text.`

    const userPrompt = `STANDARD REVIEW CHECKLIST QUESTIONS:
${questionsForAI}

APPLICATION EVIDENCE:
${applicationSummary}`

    console.log(`📝 Sending ${userQuestions.length} standard questions to AI...`)

    // 4. Call Azure OpenAI
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.1,
      maxTokens: 4000
    })

    const aiResponseText = response.choices[0]?.message?.content || ''
    console.log(`🤖 AI response length: ${aiResponseText.length} chars`)

    // 5. Parse AI response
    let aiAnswers = []
    try {
      const jsonMatch = aiResponseText.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        aiAnswers = JSON.parse(jsonMatch[0])
      }
    } catch (parseError) {
      console.error('❌ Failed to parse AI response:', parseError.message)
    }

    // 6. Build comparison results
    const comparisonResults = userQuestions.map(uq => {
      const aiResult = aiAnswers.find(a => a.questionNumber === uq.number) || {
        aiAnswer: 'Unable to determine',
        confidence: 'low',
        evidence: 'AI did not return an answer for this question',
        pageReferences: [],
        reasoning: 'No analysis available',
        details: ''
      }

      const match = compareAnswers(uq.userAnswer, aiResult.aiAnswer)

      return {
        questionNumber: uq.number,
        question: uq.question,
        userAnswer: uq.userAnswer,
        aiAnswer: aiResult.aiAnswer,
        match,
        confidence: aiResult.confidence || 'low',
        evidence: aiResult.evidence || '',
        pageReferences: aiResult.pageReferences || [],
        reasoning: aiResult.reasoning || '',
        details: aiResult.details || ''
      }
    })

    // 7. Summary
    const totalQuestions = comparisonResults.length
    const matchCount = comparisonResults.filter(r => r.match === 'agree').length
    const disagreeCount = comparisonResults.filter(r => r.match === 'disagree').length
    const uncertainCount = comparisonResults.filter(r => r.match === 'uncertain').length
    const agreementRate = totalQuestions > 0 ? Math.round((matchCount / totalQuestions) * 100) : 0

    const summary = { totalQuestions, matchCount, disagreeCount, uncertainCount, agreementRate }

    console.log(`📊 Standard Checklist Summary: ${matchCount} agree, ${disagreeCount} disagree, ${uncertainCount} uncertain (${agreementRate}%)`)
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

/**
 * Compare user answer vs AI answer
 */
function compareAnswers(userAnswer, aiAnswer) {
  const u = (userAnswer || '').toLowerCase().trim()
  const a = (aiAnswer || '').toLowerCase().trim()

  if (u === 'not answered' || u === 'not determined' || a === 'unable to determine') {
    return 'uncertain'
  }

  // Normalize
  const normalizeAnswer = (ans) => {
    if (ans.includes('yes')) return 'yes'
    if (ans.includes('no') && !ans.includes('not')) return 'no'
    if (ans.includes('n/a') || ans.includes('not applicable')) return 'n/a'
    return ans
  }

  const nu = normalizeAnswer(u)
  const na = normalizeAnswer(a)

  if (nu === na) return 'agree'
  return 'disagree'
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
 * Build a compressed summary of the application data for AI consumption.
 * Strips bounding boxes, polygons, word-level data — sends only essential text content.
 */
function buildApplicationSummary(applicationData) {
  const parts = []

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
