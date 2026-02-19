#!/usr/bin/env node
/**
 * Combined Batch Processing Script — CE Review + Pre-Funding Review
 *
 * Reads applications from: CEReviewTool/applications/
 * Extracts each PDF ONCE via Azure Document Intelligence, then runs both reviews.
 *
 * Auto-detects Funding Opportunity Number (HRSA-xx-004) from PDF content.
 * Uses xx as year code to resolve all data paths automatically.
 *
 * Usage:
 *   node server/scripts/combinedBatchProcess.js
 *   node server/scripts/combinedBatchProcess.js --mode both|ce-only|prefunding-only
 *   node server/scripts/combinedBatchProcess.js --ce-scope compliance-only|checklist-only|both
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import readline from 'readline'
import dotenv from 'dotenv'
import { extractWithAzureDI, convertToCEFormat, convertToPrefundingFormat, compressText } from './sharedExtraction.js'
import { ceReview, cacheCE } from './combinedBatchCE.js'
import { prefundingValidate, cachePrefunding } from './combinedBatchPF.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

// ---- Fixed Paths (matching ARCHITECTURE.md) ----
const CE_ROOT = join(__dirname, '../..')
const APPLICATIONS_DIR = join(CE_ROOT, 'applications')
const USER_GUIDES_ROOT = join(CE_ROOT, 'userGuides')
const CHECKLISTS_ROOT = join(CE_ROOT, 'checklistQuestions')
const SAAT_ROOT = join(CE_ROOT, 'SAAT')
const DATA_DIR = join(CE_ROOT, 'data')
const PROCESSED_APPS_DIR = join(CE_ROOT, 'processed-applications')
const EXTRACTIONS_DIR = join(CE_ROOT, 'extractions')
const DOCUMENTS_DIR = join(CE_ROOT, 'documents')
const STORED_CHECKLISTS_DIR = join(CE_ROOT, 'stored-checklists')
const LOGS_DIR = join(CE_ROOT, 'logs')
const PREFUNDING_ROOT = 'C:\\Users\\KPeterson\\CascadeProjects\\AIPrefundingReview\\AIPrefundingReview'
const PREFUNDING_DATA_DIR = join(PREFUNDING_ROOT, 'data')
const PREFUNDING_CACHE_DIR = join(PREFUNDING_DATA_DIR, 'cache')
const PF_RESULTS_DIR = join(CE_ROOT, 'pf-results')

const CONFIG = {
  CE_SERVER_URL: process.env.BATCH_SERVER_URL || 'http://localhost:3002',
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3001',
  AZURE_DOC_ENDPOINT: process.env.VITE_AZURE_DOC_ENDPOINT || '',
  AZURE_DOC_KEY: process.env.VITE_AZURE_DOC_KEY || '',
  AZURE_OPENAI_ENDPOINT: process.env.VITE_AZURE_OPENAI_ENDPOINT || '',
  AZURE_OPENAI_KEY: process.env.VITE_AZURE_OPENAI_KEY || '',
  AZURE_OPENAI_DEPLOYMENT: process.env.VITE_AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
  MAX_RETRIES: 3, RETRY_BASE_DELAY_MS: 2000,
  CHUNK_TIMEOUT_MS: 10 * 60 * 1000, DELAY_BETWEEN_APPS_MS: 5000,
}

const PF_SECTIONS = [
  'Sliding Fee Discount Program','Key Management Staff',
  'Contracts and Subawards','Collaborative Relationships','Billing and Collections',
  'Budget','Board Authority','Board Composition'
]

// ---- Helpers ----
const ts = () => new Date().toISOString().substring(11, 19)
const log = m => console.log(`[${ts()}] ${m}`)
const logE = m => console.error(`[${ts()}] ❌ ${m}`)
const logS = m => console.log(`[${ts()}] ✅ ${m}`)
const logW = m => console.log(`[${ts()}] ⚠️  ${m}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const exists = async p => { try { await fs.access(p); return true } catch { return false } }
const findPDFs = async d => (await fs.readdir(d, { withFileTypes: true })).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf')).map(e => path.join(d, e.name))

/**
 * Recursively find all PDFs under a directory (supports FY/NOFO folder structure).
 * e.g., applications/FY26/HRSA-26-002/*.pdf
 */
const findPDFsRecursive = async (dir, maxDepth = 3, currentDepth = 0) => {
  if (currentDepth > maxDepth) return []
  const results = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        results.push(fullPath)
      } else if (entry.isDirectory()) {
        const subResults = await findPDFsRecursive(fullPath, maxDepth, currentDepth + 1)
        results.push(...subResults)
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results
}
const md5 = c => crypto.createHash('md5').update(c).digest('hex')

function extractFundingOpp(text) {
  const m = text.match(/HRSA[-\s](\d{2})[-\s](\d{3})/i)
  return m ? { full: `HRSA-${m[1]}-${m[2]}`, year: m[1] } : null
}

async function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(r => { rl.question(q, a => { rl.close(); r(a.trim()) }) })
}

async function fetchT(url, opts, tms = CONFIG.CHUNK_TIMEOUT_MS) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), tms)
  try { return await fetch(url, { ...opts, signal: c.signal }) } finally { clearTimeout(t) }
}

async function retryF(url, opts, label = '') {
  let last = null
  for (let a = 1; a <= CONFIG.MAX_RETRIES; a++) {
    try {
      log(`  ⏳ Attempt ${a}/${CONFIG.MAX_RETRIES}${label ? ` for ${label}` : ''}`)
      const r = await fetchT(url, opts)
      if (!r.ok) { const b = await r.text(); throw new Error(`HTTP ${r.status}: ${b.substring(0, 200)}`) }
      return await r.json()
    } catch (e) {
      last = e; logW(`  Attempt ${a} failed: ${e.message}`)
      if (a < CONFIG.MAX_RETRIES) await sleep(Math.min(CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, a-1), 30000))
    }
  }
  throw new Error(`All attempts failed${label ? ` for ${label}` : ''}: ${last?.message}`)
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('\n' + '═'.repeat(70))
  console.log('  Combined Batch — CE Review + Pre-Funding Review')
  console.log('═'.repeat(70) + '\n')

  // ---- External Endpoints (logged once at startup) ----
  log('── Azure Endpoints ──')
  log(`  🌐 Document Intelligence: ${CONFIG.AZURE_DOC_ENDPOINT || '(not set)'}`)
  log(`  🌐 OpenAI Endpoint:       ${CONFIG.AZURE_OPENAI_ENDPOINT || '(not set)'}`)
  log(`  🤖 OpenAI Deployment:     ${CONFIG.AZURE_OPENAI_DEPLOYMENT}`)

  // ---- API Endpoints ----
  log('── API Endpoints ──')
  log(`  🔗 CE Review Server:     ${CONFIG.CE_SERVER_URL}`)
  log(`  🔗 Prefunding Backend:   ${CONFIG.BACKEND_URL}`)

  // ---- CE Review Folder Paths ----
  log('── CE Review Folders ──')
  log(`  📂 Applications:         ${APPLICATIONS_DIR}`)
  log(`  📂 User Guides:          ${USER_GUIDES_ROOT}`)
  log(`  📂 Checklist Questions:  ${CHECKLISTS_ROOT}`)
  log(`  📂 SAAT Data:            ${SAAT_ROOT}`)
  log(`  📂 Default Data:         ${DATA_DIR}`)
  log(`  📂 Processed Output:     ${PROCESSED_APPS_DIR}`)
  log(`  📂 Extractions:          ${EXTRACTIONS_DIR}`)
  log(`  📂 Documents:            ${DOCUMENTS_DIR}`)
  log(`  📂 Stored Checklists:    ${STORED_CHECKLISTS_DIR}`)
  log(`  📂 Logs:                 ${LOGS_DIR}`)

  // ---- Prefunding Review Folder Paths ----
  log('── Prefunding Review Folders ──')
  log(`  📂 PF Root:              ${PREFUNDING_ROOT}`)
  log(`  📂 PF Data:              ${PREFUNDING_DATA_DIR}`)
  log(`  📂 PF Cache:             ${PREFUNDING_CACHE_DIR}`)
  log(`  📂 PF Results (JSON):    ${PF_RESULTS_DIR}`)

  const args = process.argv.slice(2)
  const getArg = n => { const i = args.indexOf(`--${n}`); return i >= 0 && i+1 < args.length ? args[i+1] : null }
  let mode = getArg('mode') || await prompt('🔄 Mode (both|ce-only|prefunding-only) [both]: ') || 'both'
  const runCE = mode !== 'prefunding-only'
  const runPF = mode !== 'ce-only'
  let ceScope = 'both'
  if (runCE) {
    ceScope = getArg('ce-scope') || await prompt('📋 CE Scope (both|compliance-only|checklist-only) [both]: ') || 'both'
  }
  log(`🔄 Mode: ${mode} (CE: ${runCE ? 'YES' : 'NO'}, Prefunding: ${runPF ? 'YES' : 'NO'})`)
  if (runCE) log(`📋 CE Scope: ${ceScope} (Compliance: ${ceScope !== 'checklist-only' ? 'YES' : 'NO'}, Checklist: ${ceScope !== 'compliance-only' ? 'YES' : 'NO'})`)

  // Verify applications folder — support --folder arg for targeting a subfolder
  // e.g., --folder FY26/HRSA-26-002  or  --folder HRSA-26-002
  const folderArg = getArg('folder')
  const targetDir = folderArg ? path.join(APPLICATIONS_DIR, folderArg) : APPLICATIONS_DIR
  if (!(await exists(targetDir))) { logE(`Applications folder not found: ${targetDir}`); process.exit(1) }

  // Use recursive search to find PDFs in FY/NOFO subfolders
  const appPDFs = await findPDFsRecursive(targetDir)
  if (!appPDFs.length) { logE(`No PDFs found in ${targetDir}`); process.exit(1) }
  log(`📄 ${appPDFs.length} application(s) in ${targetDir}`)
  // Show relative paths for clarity
  appPDFs.forEach(f => log(`  - ${path.relative(APPLICATIONS_DIR, f)}`))

  const confirm = await prompt(`\n🚀 Process ${appPDFs.length} app(s) in "${mode}" mode${runCE ? ` (ce-scope: ${ceScope})` : ''}? (y/n): `)
  if (confirm.toLowerCase() !== 'y') { log('Aborted.'); process.exit(0) }

  const batchResults = []

  for (let i = 0; i < appPDFs.length; i++) {
    const appPath = appPDFs[i], appName = path.basename(appPath), baseName = appName.replace('.pdf', '')
    console.log('\n' + '═'.repeat(70))
    log(`APP ${i+1}/${appPDFs.length}: ${appName}`)
    console.log('═'.repeat(70))

    // ---- STEP 1: Extract with Azure DI (ONCE) ----
    log('── Step 1: Azure DI Extraction (shared) ──')
    let analyzeResult
    try {
      analyzeResult = await extractWithAzureDI(await fs.readFile(appPath), appName, CONFIG)
    } catch (err) {
      logE(`Extraction failed: ${err.message}`)
      batchResults.push({ application: appName, status: 'failed', error: err.message }); continue
    }

    // ---- STEP 2: Convert to both formats ----
    log('── Step 2: Format conversion ──')
    const ceData = convertToCEFormat(analyzeResult)
    const pfText = convertToPrefundingFormat(analyzeResult)
    logS(`CE JSON: ${(JSON.stringify(ceData).length/1024).toFixed(0)}KB, PF text: ${(pfText.length/1024).toFixed(0)}KB`)

    // Auto-detect funding opportunity from extracted text
    const firstPageText = ceData.pages?.slice(0, 3).map(p => p.lines?.map(l => l.content).join(' ')).join(' ') || ''
    const fundingOpp = extractFundingOpp(firstPageText) || extractFundingOpp(pfText)
    if (fundingOpp) {
      logS(`Detected: ${fundingOpp.full} → year code ${fundingOpp.year} (FY${fundingOpp.year})`)
    } else {
      logW('Could not detect Funding Opportunity Number from PDF')
    }
    const yearCode = fundingOpp?.year || '26'
    const fyLabel = `FY${yearCode}`

    // Log resolved per-app folder paths
    const resolvedUserGuide = join(USER_GUIDES_ROOT, fyLabel)
    const resolvedChecklists = join(CHECKLISTS_ROOT, fyLabel)
    const resolvedSAAT = join(SAAT_ROOT, fyLabel)
    const resolvedPFRules = join(PREFUNDING_DATA_DIR, yearCode, 'compliance-rules.json')
    log(`  📁 Resolved paths for ${fyLabel}:`)
    log(`     User Guide:     ${resolvedUserGuide}`)
    log(`     Checklists:     ${resolvedChecklists}`)
    log(`     SAAT:           ${resolvedSAAT}`)
    log(`     PF Rules:       ${resolvedPFRules}`)

    const appResult = { application: appName, status: 'completed', fundingOpp: fundingOpp?.full || 'unknown' }

    // ---- STEP 3: CE Review ----
    if (runCE) {
      log('── Step 3: CE Review ──')
      try {
        await ceReview(ceData, appName, appPath, yearCode, fyLabel, fundingOpp, appResult, {
          CONFIG, retryF, log, logS, logE, logW, sleep, exists,
          USER_GUIDES_ROOT, CHECKLISTS_ROOT, SAAT_ROOT, PROCESSED_APPS_DIR, findPDFs,
          ceScope
        })
      } catch (err) { logE(`CE Review failed: ${err.message}`); appResult.ceError = err.message }
    }

    // ---- STEP 4: Prefunding Review ----
    if (runPF) {
      log('── Step 4: Prefunding Review ──')
      try {
        await prefundingValidate(pfText, appName, baseName, yearCode, appPath, appResult, {
          CONFIG, log, logS, logE, logW, md5,
          PREFUNDING_DATA_DIR, PREFUNDING_CACHE_DIR, PF_RESULTS_DIR, PF_SECTIONS
        })
      } catch (err) { logE(`Prefunding failed: ${err.message}`); appResult.pfError = err.message }
    }

    batchResults.push(appResult)
    if (i < appPDFs.length - 1) { log('⏱️  Waiting 5s...'); await sleep(CONFIG.DELAY_BETWEEN_APPS_MS) }
  }

  // ---- Summary ----
  console.log('\n' + '═'.repeat(70))
  console.log('  BATCH COMPLETE')
  console.log('═'.repeat(70))
  const comp = batchResults.filter(r => r.status === 'completed')
  const skip = batchResults.filter(r => r.status === 'skipped')
  const fail = batchResults.filter(r => r.status === 'failed')
  console.log(`  ✅ Completed: ${comp.length}  ⏭️ Skipped: ${skip.length}  ❌ Failed: ${fail.length}`)
  comp.forEach(r => {
    const parts = [r.application.substring(0, 35).padEnd(35)]
    if (r.ceCompliance !== undefined) parts.push(`CE:${r.ceCompliance}%`)
    if (r.ceStdSummary) parts.push(`Std:${r.ceStdSummary}`)
    if (r.cePsqSummary) parts.push(`PSQ:${r.cePsqSummary}`)
    if (r.pfCompliant !== undefined) parts.push(`PF:${r.pfCompliant}C/${r.pfNonCompliant}NC`)
    console.log(`  ${parts.join(' | ')}`)
  })

  // ---- Output Locations ----
  console.log('\n' + '─'.repeat(70))
  console.log('  OUTPUT LOCATIONS')
  console.log('─'.repeat(70))
  if (runCE) {
    console.log(`  📂 CE Review JSON results:         ${PROCESSED_APPS_DIR}`)
    const ceFiles = comp.filter(r => !r.ceError).map(r => r.ceOutputFile || r.application.replace('.pdf', ''))
    ceFiles.forEach(f => console.log(`     └─ ${f}`))
  }
  if (runPF) {
    console.log(`  📂 Prefunding Review JSON results: ${PF_RESULTS_DIR}`)
    const pfFiles = comp.filter(r => !r.pfError).map(r => r.pfOutputFile || r.application.replace('.pdf', ''))
    pfFiles.forEach(f => console.log(`     └─ ${f}`))
  }
  console.log('')
}

main().catch(err => { logE(`Fatal: ${err.message}`); console.error(err.stack); process.exit(1) })
