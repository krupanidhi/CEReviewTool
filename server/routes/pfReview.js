import express from 'express'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import crypto from 'crypto'
import axios from 'axios'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '../../.env') })

const router = express.Router()

const PF_DATA_DIR = join(__dirname, '../../pf-data')
const PF_RULES_DIR = join(PF_DATA_DIR, 'rules')
const PF_CACHE_DIR = join(PF_DATA_DIR, 'cache')

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || process.env.VITE_AZURE_OPENAI_ENDPOINT || ''
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || process.env.VITE_AZURE_OPENAI_KEY || ''
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.VITE_AZURE_OPENAI_DEPLOYMENT || 'gpt-4o'

async function ensureDirs() {
  await fs.mkdir(PF_DATA_DIR, { recursive: true })
  await fs.mkdir(PF_RULES_DIR, { recursive: true })
  await fs.mkdir(PF_CACHE_DIR, { recursive: true })
}

const PF_SECTIONS = [
  'Sliding Fee Discount Program',
  'Key Management Staff',
  'Contracts and Subawards',
  'Collaborative Relationships',
  'Billing and Collections',
  'Budget',
  'Board Authority',
  'Board Composition'
]

// ============================================================
// Rules Management
// ============================================================

// Save compliance rules for a specific year
router.post('/save-rules/:year', async (req, res) => {
  try {
    await ensureDirs()
    const { year } = req.params
    const yearDir = join(PF_RULES_DIR, year)
    await fs.mkdir(yearDir, { recursive: true })
    const rulesFile = join(yearDir, 'compliance-rules.json')
    const rules = req.body.rules
    await fs.writeFile(rulesFile, JSON.stringify(rules, null, 2))
    console.log(`✅ PF: Saved ${rules.length} compliance rules for year ${year}`)
    res.json({ success: true, message: `Rules saved for year ${year}`, year })
  } catch (error) {
    console.error('Error saving PF rules:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// Load compliance rules for a specific year
router.get('/load-rules/:year', async (req, res) => {
  try {
    const { year } = req.params
    const rulesFile = join(PF_RULES_DIR, year, 'compliance-rules.json')
    const data = await fs.readFile(rulesFile, 'utf-8')
    const rules = JSON.parse(data)
    console.log(`✅ PF: Loaded ${rules.length} compliance rules for year ${year}`)
    res.json({ success: true, rules, year })
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({ success: false, message: `No rules found for year ${req.params.year}` })
    } else {
      res.status(500).json({ success: false, error: error.message })
    }
  }
})

// List all available rule years
router.get('/rule-years', async (req, res) => {
  try {
    await ensureDirs()
    let entries
    try {
      entries = await fs.readdir(PF_RULES_DIR, { withFileTypes: true })
    } catch {
      return res.json({ success: true, years: [] })
    }
    const years = []
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d{2}$/.test(entry.name)) {
        const rulesFile = join(PF_RULES_DIR, entry.name, 'compliance-rules.json')
        try {
          await fs.access(rulesFile)
          const data = await fs.readFile(rulesFile, 'utf-8')
          const rules = JSON.parse(data)
          years.push({ year: entry.name, fullYear: `20${entry.name}`, chaptersCount: rules.length })
        } catch { /* no rules file */ }
      }
    }
    years.sort((a, b) => parseInt(a.year) - parseInt(b.year))
    res.json({ success: true, years })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================================
// Extract rules from manual PDF text using Azure OpenAI
// ============================================================
router.post('/extract-rules', async (req, res) => {
  try {
    const { content, year } = req.body
    if (!content) return res.status(400).json({ success: false, error: 'Missing content' })

    console.log(`🤖 PF: Extracting compliance rules from manual (${(content.length / 1024).toFixed(0)}KB)...`)

    const prompt = `You are analyzing the HRSA SAC and RD PAR Guiding Principles document. This document contains compliance requirements for Health Center Programs.

IMPORTANT: Look for sections starting with "Chapter" followed by a number and title. Each chapter contains:
- Authority: Legal citations
- Element: Starts with "Element" followed by a letter
- Requirement description with bullet points
- "Section of the Application to review"
- "Items within the Application"

Extract ALL compliance requirements from these chapters:
- Chapter 9: Sliding Fee Discount Program
- Chapter 11: Key Management Staff
- Chapter 12: Contracts and Subawards
- Chapter 14: Collaborative Relationships
- Chapter 16: Billing and Collections
- Chapter 17: Budget
- Chapter 19: Board Authority
- Chapter 20: Board Composition

For EACH Element, extract into this JSON structure (ONE object per chapter with ALL elements grouped inside):
{
  "requirements": [
    {
      "chapter": "Chapter 9: Sliding Fee Discount Program",
      "section": "Sliding Fee Discount Program",
      "authority": "Full authority text from the document",
      "elements": [
        {
          "element": "Element a - Sliding Fee Discount Program",
          "requirementText": "Main requirement paragraph",
          "requirementDetails": ["First bullet point", "Second bullet point"],
          "applicationSection": "Project Narrative - Need section, items 2a - c",
          "applicationItems": ["a) Item text", "b) Item text"],
          "footnotes": "Any footnote text or NOTE text"
        }
      ]
    }
  ]
}

CRITICAL: Return exactly 8 objects in the requirements array - one for each chapter. Group ALL elements found in each chapter together.
Search through the ENTIRE document below. All chapters may be spread throughout the document.

Document content:
${content.substring(0, 200000)}`

    const response = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`,
      {
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1
      },
      {
        headers: { 'api-key': AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
        timeout: 120000
      }
    )

    const aiContent = response.data.choices[0].message.content
    const result = JSON.parse(aiContent)
    const requirements = result.requirements || []
    console.log(`✅ PF: Extracted ${requirements.length} chapters from manual`)

    // Auto-save if year provided
    if (year) {
      await ensureDirs()
      const shortYear = year.toString().slice(-2)
      const yearDir = join(PF_RULES_DIR, shortYear)
      await fs.mkdir(yearDir, { recursive: true })
      await fs.writeFile(join(yearDir, 'compliance-rules.json'), JSON.stringify(requirements, null, 2))
      console.log(`✅ PF: Auto-saved rules for year ${year}`)
    }

    res.json({ success: true, rules: requirements, usage: response.data.usage })
  } catch (error) {
    console.error('Error extracting PF rules:', error.response?.data || error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================================
// Analyze Application against rules
// ============================================================
router.post('/analyze', async (req, res) => {
  try {
    const { applicationContent, rules, applicationName } = req.body
    if (!applicationContent || !rules) {
      return res.status(400).json({ success: false, error: 'Missing applicationContent or rules' })
    }

    console.log(`🤖 PF: Analyzing application "${applicationName}" against ${rules.length} chapters...`)

    const totalRequirements = rules.reduce((sum, ch) => sum + (ch.elements?.length || 0), 0)

    // Build prompt with ALL chapters
    const allChaptersPrompt = rules.map((chapter, sIdx) => {
      const elementsPrompt = (chapter.elements || []).map((el, eIdx) => `
REQUIREMENT #${sIdx + 1}.${eIdx + 1}
SECTION: ${chapter.section}
ELEMENT: ${el.element || 'Compliance Requirement'}
REQUIREMENT: ${el.requirementText}
${el.requirementDetails?.length > 0 ? `MUST ADDRESS: ${el.requirementDetails.join('; ')}` : ''}
${el.footnotes ? `NOTES: ${el.footnotes}` : ''}
`).join('\n')

      return `
═══ SECTION ${sIdx + 1}: ${chapter.section} ═══
CHAPTER: ${chapter.chapter || chapter.section}
AUTHORITY: ${chapter.authority || 'N/A'}
ELEMENTS TO VALIDATE: ${chapter.elements?.length || 0}

${elementsPrompt}`
    }).join('\n')

    const prompt = `You are validating HRSA compliance for a health center application.
You will validate ${totalRequirements} requirements across ${rules.length} sections in ONE analysis.

${allChaptersPrompt}

═══ VALIDATION INSTRUCTIONS ═══

⚠️ CRITICAL - NO HALLUCINATION:
- ONLY use information EXPLICITLY in the application
- NEVER assume, infer, or guess
- If no explicit evidence found, mark NON_COMPLIANT

STATUS RULES:
- COMPLIANT: Clear explicit proof found
- NON_COMPLIANT: No evidence or incomplete
- NOT_APPLICABLE: Only if NOTE says "N/A if..." AND condition met

EVIDENCE:
- Quote 1-3 KEY sentences in "quotation marks"
- Include page numbers
- 3-4 sentence reasoning
- For each requirement with "MUST ADDRESS" items, validate each item individually

APPLICATION CONTENT:
${applicationContent.substring(0, 200000)}

═══ RESPONSE FORMAT ═══

Return JSON with validations array containing ${totalRequirements} results:
{
  "validations": [
    {
      "section": "Section name",
      "requirementNumber": "1.1",
      "element": "Element name",
      "status": "COMPLIANT|NON_COMPLIANT|NOT_APPLICABLE",
      "evidence": "Direct quotes or 'Not found'",
      "evidenceLocation": "Page X or 'Not found'",
      "evidenceSection": "Specific document/section name where evidence was found",
      "reasoning": "3-4 sentences",
      "mustAddressValidation": [{"item": "item text", "status": "found|not_found", "evidence": "quote", "page": "Page X"}]
    }
  ]
}

CRITICAL: Return exactly ${totalRequirements} validation objects.`

    const response = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`,
      {
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 16000
      },
      {
        headers: { 'api-key': AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
        timeout: 180000
      }
    )

    const aiContent = response.data.choices[0].message.content
    const result = JSON.parse(aiContent)

    // Organize results by section
    const sectionResults = {}
    PF_SECTIONS.forEach(s => {
      sectionResults[s] = { compliantItems: [], nonCompliantItems: [], notApplicableItems: [] }
    })

    if (result.validations && Array.isArray(result.validations)) {
      result.validations.forEach(v => {
        const section = v.section || 'Unknown'
        if (!sectionResults[section]) {
          sectionResults[section] = { compliantItems: [], nonCompliantItems: [], notApplicableItems: [] }
        }

        const chapter = rules.find(r => r.section === section || section.includes(r.section) || r.section.includes(section))
        const element = chapter?.elements?.find(e => e.element === v.element)

        const item = {
          element: v.element || 'Unknown',
          requirement: element?.requirementText || v.element || 'Not specified',
          requirementDetails: element?.requirementDetails || [],
          status: v.status,
          evidence: v.evidence || 'Not found',
          evidenceLocation: v.evidenceLocation || 'Not found',
          evidenceSection: v.evidenceSection || 'Not found',
          reasoning: v.reasoning || 'No reasoning provided',
          mustAddressValidation: v.mustAddressValidation || []
        }

        if (v.status === 'COMPLIANT') sectionResults[section].compliantItems.push(item)
        else if (v.status === 'NOT_APPLICABLE') sectionResults[section].notApplicableItems.push(item)
        else sectionResults[section].nonCompliantItems.push(item)
      })
    }

    // Save to cache
    if (applicationName) {
      await ensureDirs()
      const cacheFile = join(PF_CACHE_DIR, `${applicationName.replace(/[^a-zA-Z0-9.-]/g, '_')}.json`)
      await fs.writeFile(cacheFile, JSON.stringify({
        applicationName,
        results: sectionResults,
        timestamp: new Date().toISOString(),
        usage: response.data.usage
      }, null, 2))
    }

    console.log(`✅ PF: Analysis complete for "${applicationName}"`)
    res.json({ success: true, results: sectionResults, usage: response.data.usage })
  } catch (error) {
    console.error('Error in PF analysis:', error.response?.data || error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

// ============================================================
// Manual Review Comparison (Compare with PO Review)
// ============================================================
router.post('/parse-manual-review', async (req, res) => {
  try {
    const { content } = req.body
    if (!content) return res.status(400).json({ success: false, error: 'Missing content' })

    console.log(`🤖 PF: Parsing manual review content (${(content.length / 1024).toFixed(0)}KB)...`)

    const response = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`,
      {
        messages: [
          {
            role: 'system',
            content: 'You are an expert at parsing HRSA compliance review documents. Extract structured data from manual review content. For each element found, return: section name, element letter, element name, compliance status (Yes/No/Not Applicable), and reviewer comments. Return as JSON array.'
          },
          {
            role: 'user',
            content: `Parse this manual review content and extract all compliance elements with their section context:\n\n${content.substring(0, 50000)}\n\nReturn JSON array with format: [{"section": "Sliding Fee Discount Program", "letter": "b", "name": "Sliding Fee Discount Program Policies", "status": "Yes", "comments": "Compliance was demonstrated..."}]\n\nMake sure each element includes the correct section name it belongs to.`
          }
        ],
        temperature: 0.1,
        max_tokens: 4000
      },
      {
        headers: { 'api-key': AZURE_OPENAI_KEY, 'Content-Type': 'application/json' },
        timeout: 60000
      }
    )

    const aiResponse = response.data.choices[0].message.content
    const jsonMatch = aiResponse.match(/\[[\s\S]*\]/)
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : []

    console.log(`✅ PF: Parsed ${parsed.length} elements from manual review`)
    res.json({ success: true, elements: parsed, usage: response.data.usage })
  } catch (error) {
    console.error('Error parsing manual review:', error.response?.data || error.message)
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
