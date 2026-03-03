/**
 * Re-extract checklist questions for a given FY using OpenAI.
 *
 * Usage:
 *   node server/scripts/reextractQuestions.js FY25
 *   node server/scripts/reextractQuestions.js FY24
 *   node server/scripts/reextractQuestions.js FY25 --type programspecific
 *   node server/scripts/reextractQuestions.js FY25 --type standard
 *
 * This script:
 *   1. Deletes the stale _questions.json cache files
 *   2. Reads the existing _extraction.json (raw DI text) and _structured.json
 *   3. Calls parseChecklistQuestions (which uses extractQuestionsWithAI via OpenAI)
 *   4. Saves fresh _questions.json files
 *
 * Prerequisites:
 *   - _extraction.json and _structured.json must already exist (from prior DI extraction)
 *   - Azure OpenAI credentials in .env
 */

import dotenv from 'dotenv'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '../..')

dotenv.config({ path: join(ROOT, '.env') })

// ─── CLI Arguments ───────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const fiscalYear = args[0]
if (!fiscalYear || !/^FY\d{2}$/.test(fiscalYear)) {
  console.error('Usage: node server/scripts/reextractQuestions.js FY25 [--type standard|programspecific|both]')
  process.exit(1)
}

const typeIdx = args.indexOf('--type')
const ruleType = typeIdx >= 0 && args[typeIdx + 1] ? args[typeIdx + 1].toLowerCase() : 'both'
const runStandard = ruleType === 'both' || ruleType === 'standard'
const runProgramSpecific = ruleType === 'both' || ruleType === 'programspecific'

// ─── Dynamic import of parseChecklistQuestions from qaComparison route ────────
// We need to import the function that does the OpenAI-based extraction.
// Since it's defined inside qaComparison.js as a non-exported function,
// we'll replicate the extraction logic here using the same OpenAI call.

import { OpenAIClient, AzureKeyCredential } from '@azure/openai'

const endpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const key = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

if (!endpoint || !key || !deployment) {
  console.error('❌ Missing Azure OpenAI env vars')
  process.exit(1)
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(key))

/**
 * Extract checklist questions using OpenAI — same logic as extractQuestionsWithAI
 * in qaComparison.js
 */
async function extractQuestionsWithAI(rawContent, checklistType) {
  console.log(`🤖 Extracting questions via OpenAI (${checklistType})...`)
  console.log(`   Raw content length: ${rawContent.length} chars`)

  const systemPrompt = `You are a document analysis expert. Your task is to extract ALL checklist questions from a government grant review checklist document.

Rules:
- Extract EVERY numbered question (e.g., "1. Does the applicant...", "2. Public Agencies: Does...")
- Extract EVERY unnumbered question that has Yes/No/N/A checkboxes or answer options
- Include the FULL question text — do not truncate or summarize
- Preserve the original question numbering exactly as it appears
- For unnumbered questions, set originalNumber to null
- Identify which section each question belongs to (e.g., "Completeness Checklist", "Eligibility Checklist", "Patient Projection Funding Reduction Check", "Recommendations")
- Note if a question references SAAT (Service Area Analysis Tool)
- Extract any "Suggested Resource(s)" mentioned near each question
- Do NOT include section headers, metadata, reviewer comments, or instructions as questions
- Do NOT include "As of" dates, "Action Taken", "Completion Status", or "Other comments" fields
- IMPORTANT: Include the "Recommendations" section questions at the end (e.g., "Is the application complete...", "Is the applicant eligible...")

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

  questions.forEach((q, idx) => {
    q.number = idx + 1
    q.source = 'openai_extraction'
    q.pageReference = q.pageReference || null
    q.suggestedResources = q.suggestedResources || ''
    q.requiresSAAT = q.requiresSAAT || false
  })

  console.log(`✅ OpenAI extracted ${questions.length} questions`)
  questions.forEach(q => {
    console.log(`   Q${q.number} [${q.section || '?'}] (orig#${q.originalNumber || 'unnumbered'}): "${q.question.substring(0, 80)}..."`)
  })

  return questions
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function reextract(checklistType) {
  const label = checklistType === 'standard' ? 'Standard' : 'Program-Specific'
  const prefix = checklistType === 'standard' ? 'StandardChecklist' : 'ProgramSpecificQuestions'
  const dir = join(ROOT, 'checklistQuestions', fiscalYear)

  const extractionFile = join(dir, `${prefix}_extraction.json`)
  const questionsFile = join(dir, `${prefix}_questions.json`)

  // 1. Verify extraction JSON exists
  try {
    await fs.access(extractionFile)
  } catch {
    console.error(`❌ ${basename(extractionFile)} not found in ${dir}`)
    console.error('   Run DI extraction on the checklist PDF first.')
    return false
  }

  // 2. Delete stale _questions.json
  try {
    await fs.access(questionsFile)
    await fs.unlink(questionsFile)
    console.log(`🗑️  Deleted stale: ${basename(questionsFile)}`)
  } catch {
    console.log(`   No existing ${basename(questionsFile)} to delete`)
  }

  // 3. Load raw DI text
  const extractionRaw = await fs.readFile(extractionFile, 'utf-8')
  const extractionData = JSON.parse(extractionRaw)
  const rawContent = extractionData.content || ''

  if (!rawContent) {
    console.error(`❌ No content in ${basename(extractionFile)}`)
    return false
  }
  console.log(`📄 Loaded ${basename(extractionFile)} (${(rawContent.length / 1024).toFixed(0)} KB)`)

  // 4. Extract via OpenAI
  const questions = await extractQuestionsWithAI(rawContent, checklistType)

  if (!questions.length) {
    console.error(`❌ OpenAI returned 0 questions for ${label}`)
    return false
  }

  // 5. Save fresh _questions.json
  const cacheData = {
    questions,
    metadata: {},
    parsedAt: new Date().toISOString(),
    source: 'openai_extraction'
  }
  await fs.writeFile(questionsFile, JSON.stringify(cacheData, null, 2), 'utf-8')
  console.log(`💾 Saved ${questions.length} questions to ${basename(questionsFile)}`)

  // Check for Recommendations section
  const recoQs = questions.filter(q => (q.section || '').toLowerCase().includes('recommend'))
  if (recoQs.length > 0) {
    console.log(`✅ Recommendations section found: ${recoQs.length} question(s)`)
  } else {
    console.warn(`⚠️  No "Recommendations" section found — verify the checklist PDF contains it`)
  }

  return true
}

console.log(`\n══════════════════════════════════════════════════════════════`)
console.log(`  Re-extract Checklist Questions — ${fiscalYear}`)
console.log(`══════════════════════════════════════════════════════════════\n`)

let success = true

if (runProgramSpecific) {
  console.log(`\n── Program-Specific Checklist ──────────────────────────────\n`)
  if (!await reextract('programspecific')) success = false
}

if (runStandard) {
  console.log(`\n── Standard Checklist ──────────────────────────────────────\n`)
  if (!await reextract('standard')) success = false
}

if (success) {
  console.log(`\n🎉 Done! Questions re-extracted for ${fiscalYear}.`)
  console.log(`\n⚠️  IMPORTANT: Now re-generate rules to include the new questions:`)
  console.log(`   node server/scripts/generateRules.js ${fiscalYear}`)
} else {
  console.error(`\n❌ Some extractions failed. Check errors above.`)
  process.exit(1)
}
