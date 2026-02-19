/**
 * Generate StandardRules.json and/or ProgramSpecificRules.json from User Guide + Checklist Questions
 * 
 * Usage:
 *   node server/scripts/generateRules.js FY26                        # generates both
 *   node server/scripts/generateRules.js FY26 --type standard        # standard only
 *   node server/scripts/generateRules.js FY26 --type programspecific # program-specific only
 *   node server/scripts/generateRules.js FY26 --type both            # both (default)
 * 
 * This reads:
 *   1. userGuides/<FY>/*_extraction.json  (User Guide raw text from DI — one-time extraction)
 *   2. checklistQuestions/<FY>/*_questions.json (extracted checklist questions)
 * 
 * And produces (cached per FY — reused for all subsequent applications):
 *   checklistQuestions/<FY>/ProgramSpecificRules.json
 *   checklistQuestions/<FY>/StandardRules.json
 * 
 * The rules are grounded in the User Guide's actual compliance guidance — not just word matching.
 * For Standard Q1 (completeness_check), the AI derives the per-application-type attachment
 * requirement matrix directly from User Guide section 2.3.2.
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

// ─── CLI Arguments ───────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const fiscalYear = args[0]
if (!fiscalYear || !/^FY\d{2}$/.test(fiscalYear)) {
  console.error('Usage: node server/scripts/generateRules.js FY26 [--type standard|programspecific|both]')
  process.exit(1)
}

const typeIdx = args.indexOf('--type')
const ruleType = typeIdx >= 0 && args[typeIdx + 1] ? args[typeIdx + 1].toLowerCase() : 'both'
const runStandard = ruleType === 'both' || ruleType === 'standard'
const runProgramSpecific = ruleType === 'both' || ruleType === 'programspecific'

// ─── Shared: Load User Guide ─────────────────────────────────────────────────

async function loadUserGuideText() {
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
  const text = ugData.content || ''
  console.log(`📖 User Guide: ${ugExtractionFile} (${text.length} chars, ${ugData.pages?.length || 0} pages)`)
  return text
}

// ─── Shared: Load Checklist Questions ────────────────────────────────────────

async function loadChecklistQuestions(checklistType) {
  const fileName = checklistType === 'standard'
    ? 'StandardChecklist_questions.json'
    : 'ProgramSpecificQuestions_questions.json'
  const questionsPath = join(ROOT, 'checklistQuestions', fiscalYear, fileName)
  const qRaw = await fs.readFile(questionsPath, 'utf-8')
  const qData = JSON.parse(qRaw)
  const questions = qData.questions || []
  console.log(`📋 ${checklistType} checklist: ${questions.length} questions loaded from ${fileName}`)
  return questions
}

// ─── Shared: Build Questions Summary ─────────────────────────────────────────

function buildQuestionsSummary(questions) {
  return questions.map(q => {
    let line = `Q${q.number}: ${q.question}`
    if (q.suggestedResources) line += `\n   Suggested Resource(s): ${q.suggestedResources}`
    if (q.requiresSAAT) line += `\n   [Requires SAAT data]`
    if (q.section) line += `\n   Section: ${q.section}`
    return line
  }).join('\n\n')
}

// ─── Shared: Call AI and Parse Response ──────────────────────────────────────

async function callAIForRules(systemPrompt, userPrompt, label, debugFileName) {
  console.log(`\n🤖 Sending to OpenAI for ${label} rule generation...`)

  const response = await client.getChatCompletions(deployment, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], {
    temperature: 0,
    maxTokens: 16000
  })

  const aiText = response.choices[0]?.message?.content || ''
  console.log(`📝 AI response: ${aiText.length} chars, finishReason: ${response.choices[0]?.finishReason}`)

  let cleaned = aiText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()

  let rules
  try {
    rules = JSON.parse(cleaned)
  } catch (parseErr) {
    console.error(`❌ Failed to parse AI response as JSON: ${parseErr.message}`)
    console.error(`   First 500 chars: ${cleaned.substring(0, 500)}`)
    const debugPath = join(ROOT, 'checklistQuestions', fiscalYear, debugFileName)
    await fs.writeFile(debugPath, aiText, 'utf-8')
    console.error(`   Raw response saved to ${debugPath}`)
    throw new Error(`JSON parse failed for ${label}`)
  }

  if (!Array.isArray(rules)) {
    throw new Error(`Expected JSON array for ${label}, got: ${typeof rules}`)
  }

  return rules
}

// ─── Shared: Validate and Enrich Rules ───────────────────────────────────────

function validateRules(rules, questions) {
  const validated = []
  for (const rule of rules) {
    if (!rule.questionNumber) {
      console.warn(`⚠️ Skipping rule without questionNumber`)
      continue
    }
    if (!rule.answerStrategy) rule.answerStrategy = 'document_review'
    if (!rule.lookFor) rule.lookFor = []
    if (!rule.complianceGuidance) rule.complianceGuidance = ''
    if (!rule.description) rule.description = `Rule for question ${rule.questionNumber}`
    if (!rule.condition) rule.condition = null
    if (!rule.dependsOn) rule.dependsOn = null
    if (!rule.suggestedResources) rule.suggestedResources = ''

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
  return validated
}

// ─── Shared: Log Rule Summary ────────────────────────────────────────────────

function logRuleSummary(rules) {
  for (const r of rules) {
    const strategy = r.answerStrategy.padEnd(20)
    const cond = r.condition ? `[${r.condition.type}=${r.condition.value}]` : ''
    const dep = r.dependsOn ? `[depends Q${r.dependsOn.question}]` : ''
    console.log(`   Q${String(r.questionNumber).padStart(2)}: ${strategy} ${cond} ${dep} — ${(r.description || '').substring(0, 60)}`)
  }
}

// ─── Shared: Save Rules ─────────────────────────────────────────────────────

async function saveRules(rules, outputFileName) {
  const outputPath = join(ROOT, 'checklistQuestions', fiscalYear, outputFileName)
  await fs.writeFile(outputPath, JSON.stringify(rules, null, 2), 'utf-8')
  console.log(`💾 Saved to ${outputPath}`)
  return outputPath
}

// ─── Validation: Attachment Requirement Matrix ───────────────────────────────

function logAttachmentMatrix(rules) {
  const completenessRule = rules.find(r => r.answerStrategy === 'completeness_check')
  if (!completenessRule) return

  const alwaysRequired = completenessRule.lookFor || []
  const conditional = completenessRule.conditionalAttachments || []

  console.log(`\n📋 ATTACHMENT REQUIREMENT MATRIX (verify against User Guide section 2.3.2):`)
  console.log('─'.repeat(90))
  console.log(`  ${'Attachment'.padEnd(50)} ${'Type 1'.padEnd(12)} ${'Type 2'.padEnd(12)} ${'Type 3'.padEnd(12)}`)
  console.log(`  ${''.padEnd(50)} ${'(New)'.padEnd(12)} ${'(CC)'.padEnd(12)} ${'(Supp)'.padEnd(12)}`)
  console.log('─'.repeat(90))

  // Always-required: required for all types
  for (const att of alwaysRequired) {
    const shortName = att.length > 48 ? att.substring(0, 45) + '...' : att
    console.log(`  ${shortName.padEnd(50)} ${'Required'.padEnd(12)} ${'Required'.padEnd(12)} ${'Required'.padEnd(12)}`)
  }

  // Conditional: depends on condition
  for (const ca of conditional) {
    const shortName = ca.name.length > 48 ? ca.name.substring(0, 45) + '...' : ca.name
    const cond = ca.condition || {}

    let type1 = 'Required', type2 = 'Required', type3 = 'Required'

    if (cond.type === 'applicant_status') {
      if (cond.value === 'new') {
        type1 = 'Required'; type2 = 'NOT req'; type3 = 'NOT req'
      } else if (cond.value === 'new_or_supplemental') {
        type1 = 'Required'; type2 = 'NOT req'; type3 = 'Required'
      } else if (cond.value === 'new_or_competing') {
        type1 = 'Required'; type2 = 'NOT req'; type3 = 'Required'
      }
    } else if (cond.type === 'applicant_type') {
      if (cond.value === 'public_agency') {
        type1 = 'If PA'; type2 = 'If PA'; type3 = 'If PA'
      }
    }

    console.log(`  ${shortName.padEnd(50)} ${type1.padEnd(12)} ${type2.padEnd(12)} ${type3.padEnd(12)}`)
  }

  console.log('─'.repeat(90))
  console.log(`  PA = Public Agency only. Review the matrix above against User Guide section 2.3.2.`)
  console.log(`  If correct, the rules are ready. If not, re-run or manually adjust the JSON.\n`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDARD RULES GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

const STANDARD_SYSTEM_PROMPT = `You are an expert at HRSA grant application review. You have deep knowledge of the Health Center Program, SAC (Service Area Competition) applications, and compliance review processes.

Your task: Given a User Guide document and a set of STANDARD REVIEW CHECKLIST questions, generate a JSON array of COMPLIANCE RULES. These rules will be used by an automated system to evaluate grant applications.

CRITICAL: Your rules must be grounded in the User Guide's actual compliance guidance.

RULE SCHEMA — each rule object must have ALL of these fields:
{
  "questionNumber": <integer>,
  "question": "<full question text>",
  "section": "Standard Review Checklist",
  "answerStrategy": "<strategy>",
  "suggestedResources": "",
  "lookFor": ["<always-required attachment/form names>"],
  "complianceGuidance": "<DETAILED compliance criteria from the User Guide>",
  "condition": <null or object>,
  "dependsOn": <null or object>,
  "description": "<short human-readable summary>"
}

ANSWER STRATEGIES for Standard Checklist:

1. "completeness_check" — For the question about whether ALL required attachments are present.
   This is the MOST IMPORTANT strategy for the Standard Checklist.
   
   For this strategy, you MUST also include these ADDITIONAL fields:
   
   a) "lookFor": An array of attachment/form names that are ALWAYS required for ALL application types
      (Type 1 New, Type 2 Competing Continuation, Type 3 Supplemental).
      ONLY include attachments that are marked "required" for ALL three types in the User Guide.
   
   b) "conditionalAttachments": An array of attachments that are required ONLY for certain application types.
      Each entry must have:
      {
        "name": "Attachment X: Full Name",
        "lookFor": ["Attachment X: Full Name", "alternate search name"],
        "condition": { "type": "<condition_type>", "value": "<condition_value>" },
        "description": "Human-readable explanation of when this is required"
      }
      
      CONDITION VALUES for conditionalAttachments:
      - { "type": "applicant_status", "value": "new" } — Required ONLY for Type 1 (New) applicants
      - { "type": "applicant_status", "value": "new_or_supplemental" } — Required for Type 1 (New) AND Type 3 (Supplemental), but NOT Type 2 (Competing Continuation)
      - { "type": "applicant_type", "value": "public_agency" } — Required only for public agency applicants
      
      CRITICAL: Read User Guide section 2.3.2 ("Completing the Appendices") carefully.
      For each attachment, the User Guide lists:
        a. New Application - Type 1 (required/not required)
        b. Competing Continuation Application - Type 2 (required/not required)
        c. Supplemental Application - Type 3 (required/not required)
      
      Use this EXACT information to determine the correct condition:
      - If required for Type 1 only → "new"
      - If required for Type 1 and Type 3 but NOT Type 2 → "new_or_supplemental"
      - If required for ALL types → put it in "lookFor" (always-required), not here
      - If required only for public agencies → "applicant_type": "public_agency"

2. "eligibility_check" — For questions about applicant eligibility (entity type, etc.)
   The complianceGuidance should explain the eligibility requirements from the User Guide.

3. "prior_answers_summary" — For a final summary question that asks about overall eligibility
   based on all prior answers. This is evaluated AFTER all other questions are answered.

Return ONLY a valid JSON array. No markdown fences, no explanation text.`

async function generateStandardRules(userGuideText) {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  Generating StandardRules.json for ${fiscalYear}`)
  console.log(`${'═'.repeat(70)}`)

  const questions = await loadChecklistQuestions('standard')
  const questionsSummary = buildQuestionsSummary(questions)

  const userPrompt = `USER GUIDE DOCUMENT (${fiscalYear} SAC Application User Guide):

${userGuideText}

---

STANDARD REVIEW CHECKLIST QUESTIONS TO GENERATE RULES FOR:

${questionsSummary}

---

IMPORTANT: For Q1 (completeness check), you MUST read User Guide section 2.3.2 ("Completing the Appendices") 
to determine which attachments are always required vs. conditionally required by application type.
The section lists each attachment with requirements per Type 1 (New), Type 2 (Competing Continuation), 
and Type 3 (Supplemental). Use this to build the lookFor and conditionalAttachments arrays.

Generate a compliance rule for EVERY question listed above.`

  const rawRules = await callAIForRules(STANDARD_SYSTEM_PROMPT, userPrompt, 'standard', 'StandardRules_debug.txt')
  const validated = validateRules(rawRules, questions)

  console.log(`\n✅ Generated ${validated.length} standard rules (from ${rawRules.length} raw)`)
  logRuleSummary(validated)

  // Validation: print attachment matrix for human review
  logAttachmentMatrix(validated)

  await saveRules(validated, 'StandardRules.json')
  return validated
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRAM-SPECIFIC RULES GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

const PROGRAM_SPECIFIC_SYSTEM_PROMPT = `You are an expert at HRSA grant application review. You have deep knowledge of the Health Center Program, SAC (Service Area Competition) applications, and compliance review processes.

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

4. "prior_answers_summary" — For a final summary question that asks about overall eligibility
   based on all prior answers. This is evaluated AFTER all other questions are answered.

CONDITION — for questions that only apply to certain applicant types:
- null if the question applies to ALL applicants
- { "type": "applicant_type", "value": "public_agency", "naIfNot": true } — only for public agencies
- { "type": "applicant_status", "value": "new", "naIfNot": true } — only for new applicants (Type 1)
- { "type": "applicant_status", "value": "new_or_supplemental", "naIfNot": true } — new (Type 1) or supplemental (Type 3)
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

async function generateProgramSpecificRules(userGuideText) {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  Generating ProgramSpecificRules.json for ${fiscalYear}`)
  console.log(`${'═'.repeat(70)}`)

  const questions = await loadChecklistQuestions('programspecific')
  const questionsSummary = buildQuestionsSummary(questions)

  const userPrompt = `USER GUIDE DOCUMENT (${fiscalYear} SAC Application User Guide):

${userGuideText}

---

CHECKLIST QUESTIONS TO GENERATE RULES FOR:

${questionsSummary}

---

Generate a compliance rule for EVERY question listed above. Ground each rule's complianceGuidance in the specific guidance from the User Guide document above.`

  const rawRules = await callAIForRules(PROGRAM_SPECIFIC_SYSTEM_PROMPT, userPrompt, 'program-specific', 'ProgramSpecificRules_debug.txt')
  const validated = validateRules(rawRules, questions)

  console.log(`\n✅ Generated ${validated.length} program-specific rules (from ${rawRules.length} raw)`)
  logRuleSummary(validated)

  await saveRules(validated, 'ProgramSpecificRules.json')
  return validated
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  Rule Generation — ${fiscalYear} (type: ${ruleType})`)
  console.log(`${'═'.repeat(70)}`)

  // 1. Load User Guide text (shared — one-time DI extraction, already cached)
  const userGuideText = await loadUserGuideText()

  // 2. Generate rules
  if (runStandard) {
    try {
      await generateStandardRules(userGuideText)
    } catch (err) {
      console.error(`❌ Standard rules generation failed: ${err.message}`)
      if (!runProgramSpecific) process.exit(1)
    }
  }

  if (runProgramSpecific) {
    try {
      await generateProgramSpecificRules(userGuideText)
    } catch (err) {
      console.error(`❌ Program-specific rules generation failed: ${err.message}`)
      process.exit(1)
    }
  }

  console.log(`\n🎉 Done! Rules are ready for ${fiscalYear}.`)
}

main().catch(err => {
  console.error('❌ Fatal error:', err)
  process.exit(1)
})
