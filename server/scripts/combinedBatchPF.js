/**
 * Prefunding Review batch functions for the combined batch processor.
 * Handles: compliance validation via Azure OpenAI + dashboard cache generation.
 *
 * Cache format matches what the Prefunding dashboard expects:
 * {
 *   fileHash: md5 of extracted content,
 *   manualVersion: 'v1.0',
 *   timestamp: ISO string,
 *   applicationName: 'Application-242645',
 *   extractedContent: full extracted text,
 *   results: { 'Section Name': { compliantItems:[], nonCompliantItems:[], notApplicableItems:[] } }
 * }
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import axios from 'axios'
import crypto from 'crypto'

// PF_SECTIONS is passed via ctx from combinedBatchProcess.js
// Do NOT define a local copy here — the main script is the single source of truth.

/**
 * Run Prefunding validation for a single application and cache for dashboard.
 */
export async function prefundingValidate(pfText, appName, baseName, yearCode, appPath, appResult, ctx) {
  const { CONFIG, log, logS, logE, logW, md5,
    PREFUNDING_DATA_DIR, PREFUNDING_CACHE_DIR } = ctx

  // Load compliance rules for the detected year
  const yearRulesPath = path.join(PREFUNDING_DATA_DIR, yearCode, 'compliance-rules.json')
  const defaultRulesPath = path.join(PREFUNDING_DATA_DIR, 'compliance-rules.json')

  let rules = null
  if (fsSync.existsSync(yearRulesPath)) {
    rules = JSON.parse(fsSync.readFileSync(yearRulesPath, 'utf-8'))
    log(`  📂 Using 20${yearCode} prefunding rules: ${rules.length} chapters`)
  } else if (fsSync.existsSync(defaultRulesPath)) {
    rules = JSON.parse(fsSync.readFileSync(defaultRulesPath, 'utf-8'))
    logW(`  Year ${yearCode} rules not found, using default rules: ${rules.length} chapters`)
  } else {
    logE('No prefunding compliance rules found')
    appResult.pfError = 'No compliance rules found'
    return
  }

  // Run AI validation
  const sectionResults = await runValidation(pfText, rules, ctx)

  // Count results
  let comp = 0, nonComp = 0, na = 0
  Object.values(sectionResults).forEach(s => {
    comp += s.compliantItems?.length || 0
    nonComp += s.nonCompliantItems?.length || 0
    na += s.notApplicableItems?.length || 0
  })
  appResult.pfCompliant = comp
  appResult.pfNonCompliant = nonComp
  appResult.pfNA = na
  logS(`Prefunding: ${comp} compliant, ${nonComp} non-compliant, ${na} N/A`)

  // Cache for Prefunding dashboard
  await cachePrefundingResults(pfText, appName, baseName, appPath, sectionResults, ctx)
}

/**
 * Run all-sections validation via Azure OpenAI in a single call.
 * Matches the prompt structure and response format from batch-processor-optimized.js.
 */
async function runValidation(applicationText, rules, ctx) {
  const { CONFIG, log, logS } = ctx

  const PF_SECTIONS = ctx.PF_SECTIONS
  log(`🚀 Prefunding: ALL ${PF_SECTIONS.length} sections in ONE call...`)

  // Build per-section prompt with fuzzy rule matching (matching optimized script)
  const allChaptersPrompt = []
  for (let si = 0; si < PF_SECTIONS.length; si++) {
    const section = PF_SECTIONS[si]
    const chapter = rules.find(r => {
      if (r.section === section) return true
      if (section.includes(r.section) || r.section.includes(section)) return true
      return false
    })

    if (!chapter || !chapter.elements) {
      allChaptersPrompt.push(`\n[SECTION ${si + 1}: ${section} - NO RULES FOUND]\n`)
      continue
    }

    const elementsPrompt = chapter.elements.map((el, ei) => `
REQUIREMENT #${si + 1}.${ei + 1}
SECTION: ${section}
ELEMENT: ${el.element || 'Compliance Requirement'}
REQUIREMENT: ${el.requirementText}
${el.requirementDetails?.length ? `MUST ADDRESS: ${el.requirementDetails.join('; ')}` : ''}
${el.footnotes ? `NOTES: ${el.footnotes}` : ''}`).join('\n')

    allChaptersPrompt.push(`
═══════════════════════════════════════════════════════════════
SECTION ${si + 1}: ${section}
═══════════════════════════════════════════════════════════════
CHAPTER: ${chapter.chapter || chapter.section}
AUTHORITY: ${chapter.authority || 'N/A'}
ELEMENTS TO VALIDATE: ${chapter.elements.length}

${elementsPrompt}`)
  }

  const totalReqs = PF_SECTIONS.reduce((sum, section) => {
    const ch = rules.find(r => r.section === section || section.includes(r.section) || r.section.includes(section))
    return sum + (ch?.elements?.length || 0)
  }, 0)

  const promptText = `You are validating HRSA compliance for a health center application.

You will validate ${totalReqs} requirements across ${PF_SECTIONS.length} sections in ONE analysis.

${allChaptersPrompt.join('\n')}

═══════════════════════════════════════════════════════════════
VALIDATION INSTRUCTIONS
═══════════════════════════════════════════════════════════════

⚠️ CRITICAL - NO HALLUCINATION:
- ONLY use information EXPLICITLY in the application
- NEVER assume, infer, or guess
- If no explicit evidence found, mark NON_COMPLIANT
- Same application = same result

VALIDATION STEPS:
1. For EACH requirement, search ENTIRE application
2. Check N/A conditions FIRST (only if NOTE says "Select 'N/A' if...")
3. Find direct quotes proving compliance
4. Validate ALL "Must Address" items
5. Document findings concisely

STATUS RULES:
- COMPLIANT: Clear explicit proof found
- NON_COMPLIANT: No evidence or incomplete
- NOT_APPLICABLE: Only if NOTE says "N/A if..." AND condition met

EVIDENCE:
- Quote 1-3 KEY sentences in "quotation marks"
- Include page numbers
- 3-4 sentence reasoning

APPLICATION CONTENT:
${applicationText}

═══════════════════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════════════════

Return JSON with validations array containing ${totalReqs} results:

{
  "validations": [
    {
      "section": "Section name",
      "requirementNumber": "1.1",
      "element": "Element name",
      "status": "COMPLIANT|NON_COMPLIANT|NOT_APPLICABLE",
      "evidence": "Direct quotes or 'Not found'",
      "evidenceLocation": "Page X or 'Not found'",
      "evidenceSection": "REQUIRED: Specific document/attachment/section name where evidence was found (e.g., 'Attachment D: Sliding Fee Schedule', 'Project Narrative - Section 3', 'Form 5A'). Use 'Not found' only if no evidence exists.",
      "reasoning": "3-4 sentences"
    }
    // ... ${totalReqs} total validations
  ]
}

CRITICAL: Return exactly ${totalReqs} validation objects.`

  const endpoint = `${CONFIG.AZURE_OPENAI_ENDPOINT}openai/deployments/${CONFIG.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`
  log(`  🌐 OpenAI Endpoint: ${endpoint}`)
  const start = Date.now()

  const response = await axios.post(endpoint, {
    messages: [{ role: 'user', content: promptText }],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 16000
  }, {
    headers: { 'Content-Type': 'application/json', 'api-key': CONFIG.AZURE_OPENAI_KEY },
    timeout: 5 * 60 * 1000
  })

  let content = response.data.choices[0].message.content
  const result = JSON.parse(content)
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  logS(`Prefunding AI validation done in ${elapsed}s`)

  // Organize results by section (matching optimized script's flat-array parsing)
  const sectionResults = {}
  PF_SECTIONS.forEach(section => {
    sectionResults[section] = { compliantItems: [], nonCompliantItems: [], notApplicableItems: [] }
  })

  if (result.validations && Array.isArray(result.validations)) {
    result.validations.forEach(v => {
      const section = v.section || 'Unknown'
      if (!sectionResults[section]) {
        sectionResults[section] = { compliantItems: [], nonCompliantItems: [], notApplicableItems: [] }
      }

      // Look up original requirementText from rules (matching optimized script)
      const chapter = rules.find(r => r.section === section || section.includes(r.section) || r.section.includes(section))
      const element = chapter?.elements?.find(e => e.element === v.element)

      const item = {
        element: v.element || 'Unknown',
        requirement: element?.requirementText || v.element || 'Not specified',
        status: v.status,
        whatWasChecked: v.whatWasChecked || 'Not specified',
        evidence: v.evidence || 'Not found',
        evidenceLocation: v.evidenceLocation || 'Not found',
        evidenceSection: v.evidenceSection || 'Not found',
        reasoning: v.reasoning || 'No reasoning provided',
        sectionsReferenced: 'Not specified',
        contentTypes: 'Not specified'
      }

      if (v.status === 'COMPLIANT') sectionResults[section].compliantItems.push(item)
      else if (v.status === 'NOT_APPLICABLE') sectionResults[section].notApplicableItems.push(item)
      else sectionResults[section].nonCompliantItems.push(item)
    })
  }

  PF_SECTIONS.forEach(section => {
    const r = sectionResults[section]
    log(`  ✓ ${section}: ${r.compliantItems.length} compliant, ${r.nonCompliantItems.length} non-compliant, ${r.notApplicableItems.length} N/A`)
  })

  return sectionResults
}

/**
 * Cache results in the Prefunding dashboard format.
 * 1. Writes JSON to AIPrefundingReview/data/cache/<hash>_v1.0.json
 * 2. Saves to backend via POST /api/cache/save (matching batch-processor-optimized.js)
 *
 * Hash is computed from base64 of the original PDF buffer (matching optimized script).
 */
async function cachePrefundingResults(pfText, appName, baseName, appPath, sectionResults, ctx) {
  const { CONFIG, logS, logE, logW, PREFUNDING_CACHE_DIR } = ctx

  try {
    // Hash from PDF buffer base64 (matching batch-processor-optimized.js)
    const pdfBuffer = await fs.readFile(appPath)
    const base64Content = pdfBuffer.toString('base64')
    const fileHash = crypto.createHash('md5').update(base64Content).digest('hex')
    const manualVersion = 'v1.0'
    const cacheKey = `${fileHash}_${manualVersion}`
    const cacheFile = path.join(PREFUNDING_CACHE_DIR, `${cacheKey}.json`)

    const applicationName = baseName.replace(/\.pdf$/i, '')

    const cacheData = {
      fileHash,
      manualVersion,
      timestamp: new Date().toISOString(),
      applicationName,
      extractedContent: pfText,
      results: sectionResults
    }

    // 1. Write cache file
    await fs.mkdir(PREFUNDING_CACHE_DIR, { recursive: true })
    await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2))
    logS(`Prefunding file cached → ${cacheFile}`)

    // 2. Save to backend cache (matching batch-processor-optimized.js)
    try {
      await axios.post(`${CONFIG.BACKEND_URL || 'http://localhost:3001'}/api/cache/save`, {
        fileHash,
        manualVersion,
        data: {
          applicationName: appName,
          extractedContent: pfText,
          results: sectionResults
        }
      })
      logS(`Prefunding backend cached (hash: ${fileHash.substring(0, 8)}...)`)
    } catch (backendErr) {
      logW(`Prefunding backend cache skipped: ${backendErr.message}`)
    }
  } catch (err) {
    logE(`Prefunding cache failed: ${err.message}`)
  }
}

export { cachePrefundingResults as cachePrefunding }
