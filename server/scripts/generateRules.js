/**
 * Generate ProgramSpecificRules.json from User Guide + Checklist Questions
 * 
 * Usage:
 *   node server/scripts/generateRules.js FY26
 *   node server/scripts/generateRules.js FY25
 * 
 * This reads:
 *   1. userGuides/<FY>/*_extraction.json  (User Guide raw text from DI)
 *   2. checklistQuestions/<FY>/ProgramSpecificQuestions_questions.json (extracted questions)
 * 
 * And produces:
 *   checklistQuestions/<FY>/ProgramSpecificRules.json
 * 
 * The rules are grounded in the User Guide's compliance guidance — not just word matching.
 */

import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '../..')

dotenv.config({ path: join(ROOT, '.env') })

const endpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const key = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

if (!endpoint || !key || !deployment) {
  console.error('❌ Missing Azure OpenAI env vars (VITE_AZURE_OPENAI_ENDPOINT, VITE_AZURE_OPENAI_KEY, VITE_AZURE_OPENAI_DEPLOYMENT)')
  process.exit(1)
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(key))

// ─── Main ────────────────────────────────────────────────────────────────────

const fiscalYear = process.argv[2]
if (!fiscalYear || !/^FY\d{2}$/.test(fiscalYear)) {
  console.error('Usage: node server/scripts/generateRules.js FY26')
  process.exit(1)
}

async function main() {
  console.log(`\n🔧 Generating ProgramSpecificRules.json for ${fiscalYear}...\n`)

  // 1. Load User Guide text
  const userGuideDir = join(ROOT, 'userGuides', fiscalYear)
  const ugFiles = await fs.readdir(userGuideDir)
  const ugExtractionFile = ugFiles.find(f => f.endsWith('_extraction.json'))
  if (!ugExtractionFile) {
    console.error(`❌ No User Guide _extraction.json found in ${userGuideDir}`)
    console.error('   Run DI extraction on the User Guide PDF first.')
    process.exit(1)
  }

  const ugRaw = await fs.readFile(join(userGuideDir, ugExtractionFile), 'utf-8')
  const ugData = JSON.parse(ugRaw)
  const userGuideText = ugData.content || ''
  console.log(`📖 User Guide: ${ugExtractionFile} (${userGuideText.length} chars, ${ugData.pages?.length || 0} pages)`)

  // 2. Load checklist questions
  const questionsPath = join(ROOT, 'checklistQuestions', fiscalYear, 'ProgramSpecificQuestions_questions.json')
  const qRaw = await fs.readFile(questionsPath, 'utf-8')
  const qData = JSON.parse(qRaw)
  const questions = qData.questions || []
  console.log(`📋 Checklist: ${questions.length} questions loaded`)

  // 3. Build the questions summary for the prompt
  const questionsSummary = questions.map(q => {
    let line = `Q${q.number}: ${q.question}`
    if (q.suggestedResources) line += `\n   Suggested Resource(s): ${q.suggestedResources}`
    if (q.requiresSAAT) line += `\n   [Requires SAAT data]`
    if (q.section) line += `\n   Section: ${q.section}`
    return line
  }).join('\n\n')

  // 4. Generate rules using OpenAI — send User Guide + questions
  // The User Guide is large (~138K chars). We need to chunk it or send the most relevant parts.
  // Strategy: send the full User Guide text (it fits within GPT-4 context) along with all questions.
  
  console.log(`\n🤖 Sending to OpenAI for rule generation...`)
  console.log(`   User Guide: ${userGuideText.length} chars`)
  console.log(`   Questions: ${questions.length}`)

  const systemPrompt = `You are an expert at HRSA grant application review. You have deep knowledge of the Health Center Program, SAC (Service Area Competition) applications, and compliance review processes.

Your task: Given a User Guide document and a set of checklist questions, generate a JSON array of COMPLIANCE RULES for each question. These rules will be used by an automated system to evaluate grant applications.

CRITICAL: Your rules must be grounded in the User Guide's actual compliance guidance — not just checking if a word appears in the application. The User Guide explains WHAT each form/attachment should contain, HOW to evaluate compliance, and WHAT criteria must be met.

RULE SCHEMA — each rule object must have ALL of these fields:
{
  "questionNumber": <integer>,
  "question": "<full question text>",
  "section": "<section name from checklist>",
  "answerStrategy": "<strategy>",
  "suggestedResources": "<from the checklist question>",
  "lookFor": ["<form/attachment names to locate in the application TOC>"],
  "complianceGuidance": "<DETAILED compliance criteria from the User Guide that explain HOW to evaluate this question. This is the most important field — it tells the AI reviewer exactly what to look for and how to determine Yes/No/N/A. Include specific requirements, thresholds, conditions, and evaluation criteria from the User Guide.>",
  "condition": <null or object>,
  "dependsOn": <null or object>,
  "description": "<short human-readable summary>"
}

ANSWER STRATEGY — choose ONE:
1. "document_review" — The question asks whether a specific document/form/attachment is included AND meets specific requirements from the User Guide. The AI must read the relevant pages and evaluate against the compliance criteria.
   - Use for questions about Project Narrative, Attachments, Forms, etc.
   - The complianceGuidance should explain what the document must contain per the User Guide.

2. "saat_compare" — The question requires cross-referencing SAAT (Service Area Analysis Tool) data with application data.
   - Use for questions about service areas, patient targets, funding amounts, zip codes, service types, population types.
   - Add "saatCheck" field with one of: "nofo_match", "patient_target_75pct", "service_types_match", "funding_not_exceed", "funding_distribution", "population_types", "zip_codes_75pct"
   - The complianceGuidance should explain the specific SAAT comparison criteria from the User Guide.

3. "eligibility_check" — The question checks applicant eligibility criteria (entity type, substantive role, etc.)
   - The complianceGuidance should explain the eligibility requirements from the User Guide.

CONDITION — for questions that only apply to certain applicant types:
- null if the question applies to ALL applicants
- { "type": "applicant_type", "value": "public_agency", "naIfNot": true } — only for public agencies
- { "type": "applicant_status", "value": "new", "naIfNot": true } — only for new applicants
- { "type": "applicant_status", "value": "new_or_competing", "naIfNot": true } — new or competing supplement
- { "type": "funding_type", "value": "rph", "naIfNot": true } — only if requesting RPH funding
- { "type": "funding_type", "value": "hp_or_rph", "naIfNot": true } — only if requesting HP and/or RPH

Look for phrases in the question like "Public Agencies:", "New applicant:", "New and Competing Supplement applicants:", "requesting RPH funding:", "requesting HP and/or RPH funding:" to determine conditions.

DEPENDENCY — for questions that depend on another question's answer:
- null if no dependency
- { "question": 10, "requiredAnswer": "Yes" } — only applicable if Q10 is "Yes"
- Look for phrases like 'If the answer to Question 10 is "No", select "N/A"'

COMPLIANCE GUIDANCE — THIS IS THE MOST IMPORTANT FIELD:
For each question, extract the relevant compliance criteria from the User Guide. Examples:
- For Q1 (Project Narrative): What does the User Guide say the Project Narrative must contain? What are the page limits? What sections are required?
- For Q8 (Form 5A): What does the User Guide say about how to complete Form 5A? What must be in Column I vs Column II?
- For Q11 (SAAT Patient Target): What does the User Guide say about the 75% threshold? How is it calculated?

The complianceGuidance field should be 2-5 sentences of specific, actionable criteria that an AI reviewer can use to evaluate the application.

Return ONLY a valid JSON array. No markdown fences, no explanation text.`

  const userPrompt = `USER GUIDE DOCUMENT (${fiscalYear} SAC Application User Guide):

${userGuideText}

---

CHECKLIST QUESTIONS TO GENERATE RULES FOR:

${questionsSummary}

---

Generate a compliance rule for EVERY question listed above. Ground each rule's complianceGuidance in the specific guidance from the User Guide document above.`

  try {
    const response = await client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0,
      maxTokens: 16000
    })

    const aiText = response.choices[0]?.message?.content || ''
    console.log(`\n📝 AI response: ${aiText.length} chars, finishReason: ${response.choices[0]?.finishReason}`)

    // Parse the response
    let cleaned = aiText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
    
    let rules
    try {
      rules = JSON.parse(cleaned)
    } catch (parseErr) {
      console.error(`❌ Failed to parse AI response as JSON: ${parseErr.message}`)
      console.error(`   First 500 chars: ${cleaned.substring(0, 500)}`)
      // Save raw response for debugging
      const debugPath = join(ROOT, 'checklistQuestions', fiscalYear, 'ProgramSpecificRules_debug.txt')
      await fs.writeFile(debugPath, aiText, 'utf-8')
      console.error(`   Raw response saved to ${debugPath}`)
      process.exit(1)
    }

    if (!Array.isArray(rules)) {
      console.error('❌ Expected JSON array, got:', typeof rules)
      process.exit(1)
    }

    // Validate and enrich each rule
    const validated = []
    for (const rule of rules) {
      if (!rule.questionNumber) {
        console.warn(`⚠️ Skipping rule without questionNumber`)
        continue
      }
      // Ensure required fields
      if (!rule.answerStrategy) rule.answerStrategy = 'document_review'
      if (!rule.lookFor) rule.lookFor = []
      if (!rule.complianceGuidance) rule.complianceGuidance = ''
      if (!rule.description) rule.description = `Rule for question ${rule.questionNumber}`
      if (!rule.condition) rule.condition = null
      if (!rule.dependsOn) rule.dependsOn = null
      if (!rule.suggestedResources) rule.suggestedResources = ''

      // Match back to original question to fill in any missing fields
      const origQ = questions.find(q => q.number === rule.questionNumber)
      if (origQ) {
        if (!rule.question) rule.question = origQ.question
        if (!rule.section) rule.section = origQ.section
        if (!rule.suggestedResources && origQ.suggestedResources) {
          rule.suggestedResources = origQ.suggestedResources
        }
      }

      validated.push(rule)
    }

    console.log(`\n✅ Generated ${validated.length} rules (from ${rules.length} raw)`)

    // Log summary
    for (const r of validated) {
      const strategy = r.answerStrategy.padEnd(16)
      const cond = r.condition ? `[${r.condition.type}=${r.condition.value}]` : ''
      const dep = r.dependsOn ? `[depends Q${r.dependsOn.question}]` : ''
      console.log(`   Q${String(r.questionNumber).padStart(2)}: ${strategy} ${cond} ${dep} — ${r.description.substring(0, 60)}`)
    }

    // Save
    const outputPath = join(ROOT, 'checklistQuestions', fiscalYear, 'ProgramSpecificRules.json')
    await fs.writeFile(outputPath, JSON.stringify(validated, null, 2), 'utf-8')
    console.log(`\n💾 Saved to ${outputPath}`)
    console.log(`\n🎉 Done! Rules are ready for ${fiscalYear}.`)

  } catch (err) {
    console.error(`❌ OpenAI error: ${err.message}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err)
  process.exit(1)
})
