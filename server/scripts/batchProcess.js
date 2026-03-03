#!/usr/bin/env node
/**
 * CE Review Batch Processing Script
 * 
 * Processes multiple applications against their respective user guides and checklist
 * questions documents. Resolves documents automatically by folder structure:
 * 
 * Applications:     <applicationsFolder>/*.pdf
 * User Guides:      <userGuidesRoot>/<FundingOpportunityNumber>/*.pdf
 *                   e.g., userGuides/HRSA-26-004/UserGuide.pdf
 * Checklist Questions: <checklistQuestionsRoot>/<Year>/*.json
 *                      e.g., checklistQuestions/2026/CE Standard Checklist_structured.json
 *                      and   checklistQuestions/2026/ProgramSpecificQuestions.json
 * 
 * Usage:
 *   node server/scripts/batchProcess.js
 *   (Interactive prompts will ask for folder paths)
 * 
 *   Or with arguments:
 *   node server/scripts/batchProcess.js \
 *     --applications "C:/path/to/applications" \
 *     --userguides "C:/path/to/userGuides" \
 *     --checklists "C:/path/to/checklistQuestions" \
 *     --funding-opp "HRSA-26-004" \
 *     --year "2026"
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import readline from 'readline'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

// ---- Configuration ----
const SERVER_URL = process.env.BATCH_SERVER_URL || 'http://localhost:3001'
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 2000
const CHUNK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes per chunk

// ---- Helpers ----

function log(msg) { console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`) }
function logError(msg) { console.error(`[${new Date().toISOString().substring(11, 19)}] ❌ ${msg}`) }
function logSuccess(msg) { console.log(`[${new Date().toISOString().substring(11, 19)}] ✅ ${msg}`) }
function logWarn(msg) { console.log(`[${new Date().toISOString().substring(11, 19)}] ⚠️  ${msg}`) }

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true } catch { return false }
}

async function findPDFs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map(e => path.join(dir, e.name))
}

async function findJSONFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map(e => path.join(dir, e.name))
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url, options, timeoutMs = CHUNK_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return response
  } finally {
    clearTimeout(timer)
  }
}

async function retryFetch(url, options, label = '', maxRetries = MAX_RETRIES) {
  let lastError = null
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`  ⏳ Attempt ${attempt}/${maxRetries}${label ? ` for ${label}` : ''}`)
      const response = await fetchWithTimeout(url, options)
      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorBody.substring(0, 200)}`)
      }
      return await response.json()
    } catch (err) {
      lastError = err
      logWarn(`  Attempt ${attempt} failed: ${err.message}`)
      if (attempt < maxRetries) {
        const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 30000)
        log(`  ⏱️  Retrying in ${delay / 1000}s...`)
        await sleep(delay)
      }
    }
  }
  throw new Error(`All ${maxRetries} attempts failed${label ? ` for ${label}` : ''}: ${lastError?.message}`)
}

// ---- Document Upload ----

async function uploadDocument(filePath) {
  const fileName = path.basename(filePath)
  log(`📤 Uploading: ${fileName}`)

  const fileBuffer = await fs.readFile(filePath)
  const formData = new FormData()
  formData.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), fileName)

  const result = await retryFetch(
    `${SERVER_URL}/api/upload`,
    { method: 'POST', body: formData },
    `upload ${fileName}`
  )

  logSuccess(`Uploaded & analyzed: ${fileName} (id: ${result.id})`)
  return result
}

// ---- Chunked Compliance Comparison ----

async function runChunkedComparison(applicationData, checklistData) {
  const allSections = checklistData.sections || []
  
  // Step 1: Identify LEAF sections only (no children = actual requirements)
  const allTitles = allSections.map(s => s.title || '')
  const leafSections = allSections.filter(section => {
    const title = section.title || ''
    const match = title.match(/^(\d+(?:\.\d+)*)/)
    if (!match) return true
    const sectionNum = match[1]
    const hasChildren = allTitles.some(t => {
      if (t === title) return false
      const tMatch = t.match(/^(\d+(?:\.\d+)*)/)
      if (!tMatch) return false
      return tMatch[1].startsWith(sectionNum + '.')
    })
    return !hasChildren
  })

  log(`📊 Total sections: ${allSections.length}, Leaf sections: ${leafSections.length} (skipping ${allSections.length - leafSections.length} parent/informational)`)

  // Step 2: Group leaf sections by second-level parent (3.1, 3.2, etc.)
  const chunkGroups = {}
  leafSections.forEach(section => {
    const title = section.title || ''
    const match = title.match(/^(\d+)\.(\d+)/)
    const groupKey = match ? `${match[1]}.${match[2]}` : title.match(/^(\d+)/) ? title.match(/^(\d+)/)[1] : 'other'
    if (!chunkGroups[groupKey]) chunkGroups[groupKey] = []
    chunkGroups[groupKey].push(section)
  })

  // Sort chunk keys numerically so processing follows proper sequence (3.1, 3.2, ..., 4)
  const sortedKeys = Object.keys(chunkGroups).sort((a, b) => {
    const aParts = a.split('.').map(Number)
    const bParts = b.split('.').map(Number)
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0
      const bVal = bParts[i] || 0
      if (aVal !== bVal) return aVal - bVal
    }
    return 0
  })

  const chunks = sortedKeys.map(subKey => ({
    label: `Section ${subKey}`,
    subKey,
    sections: chunkGroups[subKey]
  }))

  log(`📦 Processing ${chunks.length} section chunks for compliance comparison`)

  const allChunkSections = []
  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  const complianceStart = Date.now()

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const chunkStart = Date.now()
    log(`\n🔄 Chunk ${i + 1}/${chunks.length}: ${chunk.label} (${chunk.sections.length} subsections)`)

    const chunkChecklistData = {
      ...checklistData,
      sections: chunk.sections,
      tableOfContents: checklistData.tableOfContents || [],
      content: chunk.sections
        .map(s => {
          const text = s.content?.map(c => c.text).join('\n') || ''
          return `\n=== ${s.title} ===\n${text}`
        })
        .join('\n\n'),
      selectedSectionNumbers: [chunk.subKey]
    }

    try {
      const result = await retryFetch(
        `${SERVER_URL}/api/compare`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applicationData, checklistData: chunkChecklistData })
        },
        chunk.label
      )

      const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(1)
      if (result.comparison?.sections) {
        allChunkSections.push(...result.comparison.sections)
        logSuccess(`${chunk.label}: ${result.comparison.sections.length} sections validated in ${chunkElapsed}s`)
      }
      if (result.usage) {
        totalUsage.promptTokens += result.usage.promptTokens || 0
        totalUsage.completionTokens += result.usage.completionTokens || 0
        totalUsage.totalTokens += result.usage.totalTokens || 0
      }
    } catch (err) {
      const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(1)
      logError(`${chunk.label} failed permanently after ${chunkElapsed}s: ${err.message}`)
      allChunkSections.push({
        checklistSection: chunk.label,
        requirement: 'Processing failed for this section group',
        status: 'not_met',
        applicationSection: '',
        pageReferences: [],
        evidence: '',
        explanation: `Failed after ${MAX_RETRIES} attempts: ${err.message}`,
        recommendation: 'Re-run this section individually.',
        missingFields: []
      })
    }

    // Small delay between chunks to avoid rate limiting
    if (i < chunks.length - 1) await sleep(1000)
  }

  const totalElapsed = ((Date.now() - complianceStart) / 1000).toFixed(1)
  log(`⏱️  Total compliance processing time: ${totalElapsed}s`)

  // Deduplicate sections by checklistSection title — AI sometimes returns duplicates
  const seenSections = new Map()
  allChunkSections.forEach(section => {
    const key = (section.checklistSection || '').trim().toLowerCase()
    if (!key) return
    const existing = seenSections.get(key)
    if (!existing || (section.evidence || '').length > (existing.evidence || '').length) {
      seenSections.set(key, section)
    }
  })
  const dedupedSections = [...seenSections.values()]
  if (dedupedSections.length < allChunkSections.length) {
    logWarn(`Deduplicated: ${allChunkSections.length} → ${dedupedSections.length} sections (removed ${allChunkSections.length - dedupedSections.length} duplicates)`)
  }

  // Merge results
  const applicableSections = dedupedSections.filter(s => s.status !== 'not_applicable')
  const metSections = applicableSections.filter(s => s.status === 'met')
  const overallCompliance = applicableSections.length > 0
    ? Math.round((metSections.length / applicableSections.length) * 100)
    : 0

  return {
    success: true,
    comparison: {
      overallCompliance,
      summary: `Batch compliance analysis: ${chunks.length} section groups, ${dedupedSections.length} total entries.`,
      sections: dedupedSections,
      criticalIssues: dedupedSections.filter(s => s.status === 'not_met').map(s => `${s.checklistSection}: ${s.requirement}`),
      recommendations: dedupedSections.filter(s => s.recommendation && s.status !== 'met').map(s => s.recommendation)
    },
    usage: totalUsage,
    metadata: {
      model: 'chunked-batch-processing',
      comparedAt: new Date().toISOString(),
      chunksProcessed: chunks.length,
      totalSections: dedupedSections.length,
      rawSections: allChunkSections.length,
      duplicatesRemoved: allChunkSections.length - dedupedSections.length
    }
  }
}

// ---- Checklist Comparison (Standard + Program-Specific) ----

async function runChecklistComparison(applicationData) {
  log('📋 Running checklist comparison (Standard + Program-Specific)...')

  const results = {}

  // Standard checklist comparison
  try {
    const stdResult = await retryFetch(
      `${SERVER_URL}/api/qa-comparison/standard-analyze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationData })
      },
      'Standard Checklist'
    )
    results.standard = stdResult
    logSuccess(`Standard checklist: ${stdResult.summary?.agreementRate || 0}% agreement`)
  } catch (err) {
    logError(`Standard checklist comparison failed: ${err.message}`)
    results.standard = { error: err.message }
  }

  // Program-specific comparison
  try {
    const psqResult = await retryFetch(
      `${SERVER_URL}/api/qa-comparison/analyze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationData })
      },
      'Program-Specific'
    )
    results.programSpecific = psqResult
    logSuccess(`Program-specific: ${psqResult.summary?.agreementRate || 0}% agreement`)
  } catch (err) {
    logError(`Program-specific comparison failed: ${err.message}`)
    results.programSpecific = { error: err.message }
  }

  return results
}

// ---- Cache Results ----

async function cacheResults(applicationName, checklistName, comparisonResult, selectedSections, applicationId, checklistComparisonResults) {
  log('💾 Caching results to processed-applications...')

  // Save compliance report
  try {
    await retryFetch(
      `${SERVER_URL}/api/processed-applications/save`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationName,
          checklistName,
          comparisonResult,
          selectedSections,
          applicationId
        })
      },
      'cache compliance report'
    )
    logSuccess('Compliance report cached')
  } catch (err) {
    logError(`Failed to cache compliance report: ${err.message}`)
  }

  // Save checklist comparison results alongside the compliance report
  if (checklistComparisonResults) {
    const cacheDir = join(__dirname, '../../processed-applications')
    // Derive FY/NOFO subdir from application name (e.g. "FY26/HRSA-26-006")
    const subdir = deriveProcessedSubdir(applicationName)
    const targetDir = subdir ? join(cacheDir, subdir) : cacheDir
    await fs.mkdir(targetDir, { recursive: true })
    const sanitizedName = applicationName.replace(/[^a-zA-Z0-9.-]/g, '_')
    const checklistCachePath = join(targetDir, `${sanitizedName}_checklist_comparison.json`)
    try {
      await fs.writeFile(checklistCachePath, JSON.stringify({
        applicationName,
        generatedAt: new Date().toISOString(),
        ...checklistComparisonResults
      }, null, 2))
      logSuccess(`Checklist comparison cached: ${checklistCachePath}`)
    } catch (err) {
      logError(`Failed to cache checklist comparison: ${err.message}`)
    }
  }
}

/**
 * Derive FY/NOFO subdirectory from an application name.
 * e.g. "HRSA-26-006_SomeName_Application-243164.pdf" → "FY26/HRSA-26-006"
 */
function deriveProcessedSubdir(name) {
  if (!name) return null
  const m = String(name).match(/HRSA[-_\s](\d{2})[-_\s](\d{3})/i)
  if (!m) return null
  return `FY${m[1]}/HRSA-${m[1]}-${m[2]}`
}

// ---- Main Batch Processing ----

async function main() {
  console.log('\n' + '='.repeat(70))
  console.log('  CE Review — Batch Processing Script')
  console.log('='.repeat(70) + '\n')

  // Parse CLI arguments
  const args = process.argv.slice(2)
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
  }

  let applicationsFolder = getArg('applications')
  let userGuidesRoot = getArg('userguides')
  let checklistsRoot = getArg('checklists')
  let fundingOpp = getArg('funding-opp')
  let year = getArg('year')

  // Interactive prompts for missing values
  if (!applicationsFolder) {
    applicationsFolder = await prompt('📁 Applications folder path (all PDFs in this folder): ')
  }
  if (!userGuidesRoot) {
    userGuidesRoot = await prompt('📁 User Guides root folder (contains subfolders by Funding Opportunity Number, e.g., HRSA-26-004/): ')
  }
  if (!checklistsRoot) {
    checklistsRoot = await prompt('📁 Checklist Questions root folder (contains subfolders by year, e.g., 2026/): ')
  }
  if (!fundingOpp) {
    fundingOpp = await prompt('🔢 Funding Opportunity Number (e.g., HRSA-26-004): ')
  }
  if (!year) {
    year = await prompt('📅 Checklist year (e.g., 2026): ')
  }

  // Validate paths
  const userGuideFolder = path.join(userGuidesRoot, fundingOpp)
  const checklistFolder = path.join(checklistsRoot, year)

  log('\n📂 Resolved paths:')
  log(`  Applications:       ${applicationsFolder}`)
  log(`  User Guide folder:  ${userGuideFolder}`)
  log(`  Checklist folder:   ${checklistFolder}`)

  // Verify folders exist
  for (const [label, folder] of [
    ['Applications', applicationsFolder],
    ['User Guides', userGuideFolder],
    ['Checklists', checklistFolder]
  ]) {
    if (!(await fileExists(folder))) {
      logError(`${label} folder not found: ${folder}`)
      process.exit(1)
    }
  }

  // Find application PDFs
  const applicationPDFs = await findPDFs(applicationsFolder)
  if (applicationPDFs.length === 0) {
    logError(`No PDF files found in: ${applicationsFolder}`)
    process.exit(1)
  }
  log(`\n📄 Found ${applicationPDFs.length} application(s):`)
  applicationPDFs.forEach(f => log(`  - ${path.basename(f)}`))

  // Find user guide PDF
  const userGuidePDFs = await findPDFs(userGuideFolder)
  if (userGuidePDFs.length === 0) {
    logError(`No user guide PDF found in: ${userGuideFolder}`)
    process.exit(1)
  }
  const userGuidePath = userGuidePDFs[0] // Use first PDF as user guide
  log(`\n📗 User Guide: ${path.basename(userGuidePath)}`)

  // Find checklist question files
  const checklistJSONs = await findJSONFiles(checklistFolder)
  log(`\n📋 Checklist files in ${checklistFolder}:`)
  checklistJSONs.forEach(f => log(`  - ${path.basename(f)}`))

  // Confirm
  const confirm = await prompt(`\n🚀 Process ${applicationPDFs.length} application(s)? (y/n): `)
  if (confirm.toLowerCase() !== 'y') {
    log('Aborted.')
    process.exit(0)
  }

  // ---- Step 1: Upload & analyze the user guide (checklist) ----
  log('\n' + '─'.repeat(50))
  log('STEP 1: Upload & analyze User Guide')
  log('─'.repeat(50))

  let userGuideDoc
  try {
    userGuideDoc = await uploadDocument(userGuidePath)
  } catch (err) {
    logError(`Failed to upload user guide: ${err.message}`)
    process.exit(1)
  }

  const checklistData = userGuideDoc.analysis?.data || userGuideDoc.data
  if (!checklistData) {
    logError('User guide analysis returned no data')
    process.exit(1)
  }

  // Get all section numbers from the checklist for selectedSections
  const allSectionTitles = checklistData.sections?.map(s => s.title).filter(Boolean) || []
  const mainSectionNumbers = [...new Set(
    allSectionTitles.map(t => {
      const match = t.match(/^(\d+)/)
      return match ? match[1] : null
    }).filter(Boolean)
  )]
  const selectedSections = mainSectionNumbers.map(num => ({
    sectionTitle: `${num}.`,
    checklistId: userGuideDoc.id,
    checklistName: path.basename(userGuidePath)
  }))

  log(`📊 User guide has ${checklistData.sections?.length || 0} sections across ${mainSectionNumbers.length} main groups`)

  // ---- Step 2: Process each application ----
  const totalApps = applicationPDFs.length
  const batchResults = []

  const processedAppsDir = join(__dirname, '../../processed-applications')

  for (let appIdx = 0; appIdx < totalApps; appIdx++) {
    const appPath = applicationPDFs[appIdx]
    const appName = path.basename(appPath)

    log('\n' + '═'.repeat(70))
    log(`APPLICATION ${appIdx + 1}/${totalApps}: ${appName}`)
    log('═'.repeat(70))

    // Check if already processed — skip if cached result exists (check subdir first, then root)
    try {
      const sanitizedName = appName.replace(/[^a-zA-Z0-9.-]/g, '_')
      const subdir = deriveProcessedSubdir(appName)
      let alreadyProcessed = false
      if (subdir) {
        const subdirPath = join(processedAppsDir, subdir)
        const subdirFiles = await fs.readdir(subdirPath).catch(() => [])
        alreadyProcessed = subdirFiles.some(f => f.includes(sanitizedName) && f.endsWith('.json'))
      }
      if (!alreadyProcessed) {
        const rootFiles = await fs.readdir(processedAppsDir).catch(() => [])
        alreadyProcessed = rootFiles.some(f => f.includes(sanitizedName) && f.endsWith('.json'))
      }
      if (alreadyProcessed) {
        logSuccess(`${appName} — ALREADY PROCESSED (skipping). Delete cached file to re-process.`)
        batchResults.push({ application: appName, status: 'skipped', reason: 'Already processed' })
        continue
      }
    } catch { /* processed-applications dir may not exist yet, continue */ }

    // Step 2a: Upload application
    log('\n── Step 2a: Upload & analyze application ──')
    let appDoc
    try {
      appDoc = await uploadDocument(appPath)
    } catch (err) {
      logError(`Failed to upload ${appName}: ${err.message}`)
      batchResults.push({ application: appName, status: 'failed', error: `Upload failed: ${err.message}` })
      continue
    }

    const applicationData = appDoc.analysis?.data || appDoc.data
    if (!applicationData) {
      logError(`${appName}: Analysis returned no data`)
      batchResults.push({ application: appName, status: 'failed', error: 'No analysis data' })
      continue
    }

    // Step 2b: Run chunked compliance comparison
    log('\n── Step 2b: Compliance comparison (chunked) ──')
    let comparisonResult
    try {
      comparisonResult = await runChunkedComparison(applicationData, checklistData)
      logSuccess(`Compliance: ${comparisonResult.comparison.overallCompliance}% overall, ${comparisonResult.comparison.sections.length} sections`)
    } catch (err) {
      logError(`Compliance comparison failed for ${appName}: ${err.message}`)
      batchResults.push({ application: appName, status: 'partial', error: `Compliance failed: ${err.message}` })
      continue
    }

    // Step 2c: Run checklist comparison (Standard + Program-Specific)
    log('\n── Step 2c: Checklist Q&A comparison ──')
    let checklistComparisonResults
    try {
      checklistComparisonResults = await runChecklistComparison(applicationData)
    } catch (err) {
      logWarn(`Checklist comparison failed for ${appName}: ${err.message}`)
      checklistComparisonResults = { error: err.message }
    }

    // Step 2d: Cache everything
    log('\n── Step 2d: Cache results ──')
    try {
      await cacheResults(
        appName,
        path.basename(userGuidePath),
        comparisonResult,
        selectedSections,
        appDoc.id,
        checklistComparisonResults
      )
    } catch (err) {
      logWarn(`Caching failed for ${appName}: ${err.message}`)
    }

    batchResults.push({
      application: appName,
      status: 'completed',
      compliance: comparisonResult.comparison.overallCompliance,
      sectionsValidated: comparisonResult.comparison.sections.length,
      standardAgreement: checklistComparisonResults?.standard?.summary?.agreementRate || 'N/A',
      programSpecificAgreement: checklistComparisonResults?.programSpecific?.summary?.agreementRate || 'N/A'
    })

    logSuccess(`${appName} — COMPLETE`)

    // Delay between applications to avoid overwhelming the server
    if (appIdx < totalApps - 1) {
      log('\n⏱️  Waiting 3s before next application...')
      await sleep(3000)
    }
  }

  // ---- Summary ----
  console.log('\n' + '═'.repeat(70))
  console.log('  BATCH PROCESSING COMPLETE')
  console.log('═'.repeat(70))
  console.log('')

  const completed = batchResults.filter(r => r.status === 'completed')
  const failed = batchResults.filter(r => r.status === 'failed')
  const partial = batchResults.filter(r => r.status === 'partial')
  const skipped = batchResults.filter(r => r.status === 'skipped')

  console.log(`  ✅ Completed: ${completed.length}/${totalApps}`)
  if (skipped.length > 0) console.log(`  ⏭️  Skipped:   ${skipped.length}/${totalApps} (already processed)`)
  if (failed.length > 0) console.log(`  ❌ Failed:    ${failed.length}/${totalApps}`)
  if (partial.length > 0) console.log(`  ⚠️  Partial:   ${partial.length}/${totalApps}`)
  console.log('')

  if (completed.length > 0) {
    console.log('  Results:')
    console.log('  ' + '-'.repeat(66))
    console.log('  Application                          | Compliance | Std Q&A | PSQ Q&A')
    console.log('  ' + '-'.repeat(66))
    completed.forEach(r => {
      const name = r.application.substring(0, 38).padEnd(38)
      const comp = `${r.compliance}%`.padEnd(10)
      const std = `${r.standardAgreement}%`.padEnd(7)
      const psq = `${r.programSpecificAgreement}%`
      console.log(`  ${name} | ${comp} | ${std} | ${psq}`)
    })
    console.log('  ' + '-'.repeat(66))
  }

  if (failed.length > 0) {
    console.log('\n  Failed applications:')
    failed.forEach(r => console.log(`  ❌ ${r.application}: ${r.error}`))
  }

  console.log('\n  All results are cached and available in the CE Review dashboard.')
  console.log('')
}

// Run
main().catch(err => {
  logError(`Fatal error: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
