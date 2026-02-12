import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { promises as fs } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const router = express.Router()

// Default checklist file locations (fallback)
const DEFAULT_PSQ_PATH = join(__dirname, '../../data/ProgramSpecificQuestions.json')
const DEFAULT_STD_PATH = join(__dirname, '../../data/CE Standard Checklist_structured.json')

/**
 * Resolve a checklist file path dynamically:
 * 1. If an explicit path is provided, use it
 * 2. If a filename pattern is provided, search extractions/ and data/ folders
 * 3. Fall back to the default path
 */
async function resolveChecklistPath(explicitPath, filenamePattern, defaultPath) {
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

  // Option 2: Search by filename pattern in extractions/ and data/ folders
  if (filenamePattern) {
    const searchDirs = [
      join(__dirname, '../../data'),
      join(__dirname, '../../extractions'),
      join(__dirname, '../../stored-checklists')
    ]
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

      // Clean up question text - remove answer markers and suggested resources from the question
      questionText = questionText
        .replace(/\[\s*X?\s*_?\s*\]\s*(Yes|No|N\/A)/gi, '')
        .replace(/Suggested Resource\(s\):[^\[]*\[[\"\?]*/gi, '')
        .replace(/\s+/g, ' ')
        .trim()

      // Extract the user's answer from title + content
      const userAnswer = extractAnswer(combined)

      // Also check for sub-questions embedded in content
      const subQuestions = extractSubQuestions(content, questionNum)

      questions.push({
        number: questionNum,
        question: questionText,
        userAnswer: userAnswer,
        rawTitle: title,
        rawContent: content
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

    // 1. Parse user-provided answers (dynamic path resolution)
    const dataPath = await resolveChecklistPath(req.body.checklistPath, req.body.checklistFilename || 'ProgramSpecificQuestions', DEFAULT_PSQ_PATH)
    const raw = await fs.readFile(dataPath, 'utf-8')
    const psqData = JSON.parse(raw)
    const userQuestions = parseUserAnswers(psqData)

    console.log(`📋 Parsed ${userQuestions.length} questions from ${dataPath}`)

    // 2. Prepare application evidence summary for AI
    const applicationSummary = buildApplicationSummary(applicationData)

    // 3. Build AI prompt
    const questionsForAI = userQuestions.map(q =>
      `Question ${q.number}: ${q.question}`
    ).join('\n')

    const systemPrompt = `You are an expert HRSA grant application reviewer. You will be given:
1. A set of program-specific eligibility/completeness questions
2. Evidence extracted from a grant application document

Your task is to INDEPENDENTLY determine the answer to each question based SOLELY on the application evidence.
For each question, you must:
- Answer "Yes", "No", or "N/A" based on what the application evidence shows
- Provide a brief explanation citing specific evidence from the application
- Reference page numbers where the evidence was found

IMPORTANT RULES:
- Base your answers ONLY on the application evidence provided
- If the evidence is insufficient to determine an answer, say "Unable to determine" and explain why
- Be thorough - search all sections, tables, and form data for relevant evidence
- For questions about whether forms/attachments are included, look for those specific forms in the application data
- For questions about patient projections or funding, look for specific numbers in the tables
- For questions about service areas or sites, look for Form 5B and related data

Return your analysis as a JSON array with this exact structure:
[
  {
    "questionNumber": 1,
    "aiAnswer": "Yes" | "No" | "N/A" | "Unable to determine",
    "confidence": "high" | "medium" | "low",
    "evidence": "Brief description of evidence found",
    "pageReferences": [26, 135],
    "reasoning": "Why this answer was determined"
  }
]

Return ONLY the JSON array, no other text.`

    const userPrompt = `PROGRAM-SPECIFIC QUESTIONS TO ANSWER:
${questionsForAI}

APPLICATION EVIDENCE:
${applicationSummary}`

    console.log(`📝 Sending ${userQuestions.length} questions to AI for analysis...`)
    console.log(`📄 Application summary length: ${applicationSummary.length} chars`)

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
      results: comparisonResults
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

    // 1. Parse standard checklist (dynamic path resolution)
    const dataPath = await resolveChecklistPath(req.body.checklistPath, req.body.checklistFilename || 'Standard Checklist', DEFAULT_STD_PATH)
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
 * Build a summary of the application data for AI consumption
 */
function buildApplicationSummary(applicationData) {
  const parts = []

  // Include page text (truncated for token limits)
  if (applicationData.pages) {
    const pageTexts = applicationData.pages
      .filter(p => p.text && p.text.length > 0)
      .slice(0, 30) // First 30 pages should cover most eligibility info
      .map(p => `--- Page ${p.pageNumber || p.page} ---\n${p.text.substring(0, 2000)}`)
    parts.push('APPLICATION PAGE TEXT:\n' + pageTexts.join('\n\n'))
  }

  // Include sections
  if (applicationData.sections) {
    const sectionTexts = applicationData.sections
      .slice(0, 50)
      .map(s => {
        const content = s.content?.map(c => c.text).join('\n') || ''
        return `[Section ${s.sectionNumber || ''}: ${s.title}]\n${content.substring(0, 1000)}`
      })
    parts.push('\nAPPLICATION SECTIONS:\n' + sectionTexts.join('\n\n'))
  }

  // Include tables
  if (applicationData.tables) {
    const tableSummaries = applicationData.tables
      .slice(0, 30)
      .map(t => {
        const headers = t.headers || Object.keys(t.structuredData?.[0] || {})
        const rows = (t.structuredData || []).slice(0, 5)
        const rowTexts = rows.map(r =>
          headers.map(h => `${h}: ${r[h] || ''}`).join(' | ')
        )
        return `[Table on Page ${t.pageNumber || '?'}] Headers: ${headers.join(', ')}\n${rowTexts.join('\n')}`
      })
    parts.push('\nAPPLICATION TABLES:\n' + tableSummaries.join('\n\n'))
  }

  // Include key-value pairs
  if (applicationData.keyValuePairs) {
    const kvTexts = applicationData.keyValuePairs
      .slice(0, 50)
      .map(kv => `${kv.key}: ${kv.value}`)
    parts.push('\nKEY-VALUE PAIRS:\n' + kvTexts.join('\n'))
  }

  // Include TOC
  if (applicationData.tableOfContents) {
    const tocTexts = applicationData.tableOfContents
      .map(t => `${t.title} (Page ${t.pageNumber})`)
    parts.push('\nTABLE OF CONTENTS:\n' + tocTexts.join('\n'))
  }

  const summary = parts.join('\n\n')
  // Truncate to stay within token limits (~120k chars ≈ 30k tokens)
  return summary.substring(0, 120000)
}

export default router
