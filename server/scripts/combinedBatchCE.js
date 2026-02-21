/**
 * CE Review batch functions for the combined batch processor.
 * Handles: user guide upload, compliance comparison, checklist Q&A, and dashboard caching.
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { analyzeDocumentEnhanced } from '../services/enhancedDocumentIntelligence.js'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'
import { extractTocLinks } from '../services/pdfLinkExtractor.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Run CE Review for a single application.
 * Uploads user guide (if needed), runs compliance + checklist, caches results for dashboard.
 */
export async function ceReview(ceData, appName, appPath, yearCode, fyLabel, fundingOpp, appResult, ctx) {
  const { CONFIG, retryF, log, logS, logE, logW, sleep, exists,
    USER_GUIDES_ROOT, CHECKLISTS_ROOT, SAAT_ROOT, PROCESSED_APPS_DIR, findPDFs,
    ceScope = 'both' } = ctx
  const runCompliance = ceScope !== 'checklist-only'
  const runChecklist = ceScope !== 'compliance-only'

  // Step 0: Register the application PDF in documents/ so the page viewer can serve it
  // Also saves ceData as analysis.data so the Chat panel has context for this application
  let applicationId = null
  if (appPath) {
    applicationId = await registerApplicationPDF(appPath, appName, ctx, ceData)
  }

  // Resolve user guide folder: userGuides/FYxx/
  const userGuideFolder = path.join(USER_GUIDES_ROOT, fyLabel)
  if (!(await exists(userGuideFolder))) {
    logW(`User guide folder not found: ${userGuideFolder}`)
    appResult.ceError = `User guide folder missing: ${fyLabel}`
    return
  }

  const ugPDFs = await findPDFs(userGuideFolder)
  if (!ugPDFs.length) {
    logW(`No user guide PDF in: ${userGuideFolder}`)
    appResult.ceError = 'No user guide PDF found'
    return
  }

  const userGuidePath = ugPDFs[0]
  const userGuideName = path.basename(userGuidePath)
  log(`📗 User Guide: ${userGuideName}`)

  // Resolve user guide: load cached extraction or extract from PDF and cache
  const checklistData = await resolveUserGuide(userGuidePath, userGuideFolder, ctx)
  if (!checklistData?.sections?.length) {
    logW('User guide returned no sections')
    appResult.ceError = 'User guide analysis returned no sections'
    return
  }
  logS(`User guide: ${checklistData.sections.length} sections`)

  // Run compliance comparison (if scope includes it)
  let ceResult = { success: true, comparison: { overallCompliance: 0, sections: [], summary: 'Skipped (ce-scope)' } }
  let mainSectionNumbers = []
  if (runCompliance) {
    const compResult = await runCECompliance(ceData, checklistData, ctx)
    ceResult = compResult.result
    mainSectionNumbers = compResult.mainSectionNumbers
    appResult.ceCompliance = ceResult.comparison?.overallCompliance
    appResult.ceSections = ceResult.comparison?.sections?.length
  } else {
    log('⏭️  Skipping compliance report (ce-scope: checklist-only)')
  }

  // Extract TOC links from the application PDF and attach to ceData.
  // This ensures the checklist endpoints build the same formPageMap as the UI path
  // (which extracts tocLinks during upload). Without this, the endpoint falls back
  // to text-based TOC parsing, which can resolve different pages and cause
  // inconsistent answers (e.g., Q21/Q22 mismatch between batch and UI).
  if (appPath && !ceData.tocLinks) {
    try {
      const pdfBuffer = await fs.readFile(appPath)
      const tocLinks = await extractTocLinks(pdfBuffer)
      if (tocLinks.length > 0) {
        ceData.tocLinks = tocLinks
        logS(`Extracted ${tocLinks.length} TOC links from PDF for checklist analysis`)
      }
    } catch (err) {
      logW(`TOC link extraction skipped: ${err.message}`)
    }
  }

  // Run checklist Q&A (if scope includes it)
  let qaResults = {}
  if (runChecklist) {
    qaResults = await runCEChecklist(ceData, ctx)
    const stdSummary = qaResults.standard?.summary
    const psqSummary = qaResults.programSpecific?.summary
    appResult.ceStdSummary = stdSummary ? `Y:${stdSummary.yesCount || 0}/N:${stdSummary.noCount || 0}` : 'N/A'
    appResult.cePsqSummary = psqSummary ? `Y:${psqSummary.yesCount || 0}/N:${psqSummary.noCount || 0}` : 'N/A'
  } else {
    log('⏭️  Skipping checklist comparison (ce-scope: compliance-only)')
  }

  // Embed checklist comparison results inside the comparisonResult so the
  // ChecklistComparison tab can load them from cache (reads results[0].checklistComparison)
  if (qaResults && (qaResults.standard || qaResults.programSpecific)) {
    if (!ceResult.checklistComparison) ceResult.checklistComparison = {}
    if (qaResults.standard && !qaResults.standard.error) ceResult.checklistComparison.standard = qaResults.standard
    if (qaResults.programSpecific && !qaResults.programSpecific.error) ceResult.checklistComparison.programSpecific = qaResults.programSpecific
  }

  // Cache results for CE dashboard tiles
  const selSections = mainSectionNumbers.map(n => ({ sectionTitle: `${n}.`, checklistName: userGuideName }))
  await cacheCEResults(appName, userGuideName, ceResult, selSections, runChecklist ? qaResults : null, applicationId, appResult, ctx)
}

/**
 * Resolve user guide: load cached extraction JSON or extract from PDF and cache.
 * Caches two files alongside the PDF:
 *   - <name>_extraction.json  (raw Azure DI output — used by /api/compare as checklistData)
 *   - <name>_structured.json  (clean section-based format — for reference)
 *
 * @param {string} pdfPath - Full path to the user guide PDF
 * @param {string} folder  - Folder containing the PDF (userGuides/HRSA-xx-004/)
 * @param {object} ctx     - Batch context (log, logS, etc.)
 * @returns {object} The raw extraction data (checklistData for /api/compare)
 */
async function resolveUserGuide(pdfPath, folder, ctx) {
  const { log, logS } = ctx
  const baseName = path.basename(pdfPath, '.pdf')
  const extractionPath = path.join(folder, `${baseName}_extraction.json`)
  const structuredPath = path.join(folder, `${baseName}_structured.json`)

  // 1. Check for cached extraction JSON
  try {
    await fs.access(extractionPath)
    log(`📋 Loading cached user guide extraction: ${path.basename(extractionPath)}`)
    const raw = await fs.readFile(extractionPath, 'utf-8')
    const data = JSON.parse(raw)
    logS(`User guide loaded from cache (${(raw.length / 1024).toFixed(0)} KB, ${data.sections?.length || 0} sections)`)
    return data
  } catch {
    // Not cached yet — extract from PDF
  }

  // 2. Extract from PDF via Azure DI (one-time cost)
  log(`📡 Extracting user guide via Azure DI (one-time, will be cached)...`)
  const pdfBuffer = await fs.readFile(pdfPath)
  log(`  📄 ${baseName} (${(pdfBuffer.length / 1024).toFixed(0)} KB)`)

  const analysisResult = await analyzeDocumentEnhanced(pdfBuffer, 'application/pdf')
  const extractionData = analysisResult.data

  // 3. Cache the raw extraction JSON (this is what /api/compare needs)
  await fs.writeFile(extractionPath, JSON.stringify(extractionData, null, 2))
  logS(`Cached raw extraction: ${path.basename(extractionPath)} (${(JSON.stringify(extractionData).length / 1024).toFixed(0)} KB)`)

  // 4. Also cache the structured version for reference
  try {
    const structuredData = transformToStructured(extractionData)
    await fs.writeFile(structuredPath, JSON.stringify(structuredData, null, 2))
    logS(`Cached structured JSON: ${path.basename(structuredPath)}`)
  } catch (err) {
    log(`  ⚠️ Structured transform failed (non-critical): ${err.message}`)
  }

  return extractionData
}

async function runCECompliance(applicationData, checklistData, ctx) {
  const { CONFIG, retryF, log, logS, logW, sleep } = ctx

  const allSections = checklistData.sections || []
  const allTitles = allSections.map(s => s.title || '')
  const leafSections = allSections.filter(section => {
    const title = section.title || ''
    const match = title.match(/^(\d+(?:\.\d+)*)/)
    if (!match) return true
    const sectionNum = match[1]
    return !allTitles.some(t => {
      if (t === title) return false
      const tMatch = t.match(/^(\d+(?:\.\d+)*)/)
      return tMatch ? tMatch[1].startsWith(sectionNum + '.') : false
    })
  })

  const mainSectionNumbers = [...new Set(
    allTitles.map(t => { const m = t.match(/^(\d+)/); return m ? m[1] : null }).filter(Boolean)
  )]

  log(`📊 CE: ${leafSections.length} leaf sections, sending in ONE API call...`)

  const singleCallData = {
    ...checklistData, sections: leafSections,
    tableOfContents: checklistData.tableOfContents || [],
    content: leafSections.map(s => `\n=== ${s.title} ===\n${s.content?.map(c => c.text).join('\n') || ''}`).join('\n\n'),
    selectedSectionNumbers: mainSectionNumbers
  }

  let result = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await retryF(`${CONFIG.CE_SERVER_URL}/api/compare`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applicationData, checklistData: singleCallData }) }, 'CE single-call')
      if (result?.comparison?.sections?.length > 0) {
        logS(`CE single-call: ${result.comparison.sections.length} sections`)
        return { result, mainSectionNumbers }
      }
    } catch (err) { logW(`CE single-call attempt ${attempt} failed: ${err.message}`) }
    if (attempt < 2) await sleep(3000)
  }

  // Fallback: chunked
  log('  Falling back to chunked CE processing...')
  const chunkGroups = {}
  leafSections.forEach(s => {
    const title = s.title || ''
    const match = title.match(/^(\d+)\.(\d+)/)
    const key = match ? `${match[1]}.${match[2]}` : title.match(/^(\d+)/) ? title.match(/^(\d+)/)[1] : 'other'
    if (!chunkGroups[key]) chunkGroups[key] = []
    chunkGroups[key].push(s)
  })
  const sortedKeys = Object.keys(chunkGroups).sort((a, b) => {
    const ap = a.split('.').map(Number), bp = b.split('.').map(Number)
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) { if ((ap[i]||0) !== (bp[i]||0)) return (ap[i]||0) - (bp[i]||0) }
    return 0
  })

  const allChunkSections = []
  for (let i = 0; i < sortedKeys.length; i++) {
    const subKey = sortedKeys[i], sections = chunkGroups[subKey]
    const chunkData = { ...checklistData, sections, tableOfContents: checklistData.tableOfContents || [],
      content: sections.map(s => `\n=== ${s.title} ===\n${s.content?.map(c => c.text).join('\n') || ''}`).join('\n\n'),
      selectedSectionNumbers: [subKey] }
    try {
      const r = await retryF(`${CONFIG.CE_SERVER_URL}/api/compare`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applicationData, checklistData: chunkData }) }, `Section ${subKey}`)
      if (r?.comparison?.sections) allChunkSections.push(...r.comparison.sections)
    } catch (err) {
      allChunkSections.push({ checklistSection: `Section ${subKey}`, status: 'not_met', requirement: 'Failed',
        explanation: err.message, evidence: '', pageReferences: [], missingFields: [] })
    }
    if (i < sortedKeys.length - 1) await sleep(1000)
  }

  const seenSections = new Map()
  allChunkSections.forEach(s => {
    const k = (s.checklistSection||'').trim().toLowerCase()
    if (k) { const e = seenSections.get(k); if (!e || (s.evidence||'').length > (e.evidence||'').length) seenSections.set(k, s) }
  })
  const deduped = [...seenSections.values()]
  const applicable = deduped.filter(s => s.status !== 'not_applicable')
  const met = applicable.filter(s => s.status === 'met')
  const compliance = applicable.length > 0 ? Math.round((met.length / applicable.length) * 100) : 0

  return {
    result: { success: true, comparison: { overallCompliance: compliance, sections: deduped, summary: `Chunked: ${deduped.length} entries` } },
    mainSectionNumbers
  }
}

async function runCEChecklist(applicationData, ctx) {
  const { CONFIG, retryF, log, logS, logE } = ctx
  log('📋 CE: Checklist comparison...')
  const results = {}
  try {
    results.standard = await retryF(`${CONFIG.CE_SERVER_URL}/api/qa-comparison/standard-analyze`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applicationData }) }, 'Standard')
    const stdS = results.standard.summary
    logS(`  Standard: ${stdS?.totalQuestions || 0} Qs — Yes: ${stdS?.yesCount || 0}, No: ${stdS?.noCount || 0}, N/A: ${stdS?.naCount || 0}`)
  } catch (err) { logE(`  Standard failed: ${err.message}`); results.standard = { error: err.message } }
  try {
    results.programSpecific = await retryF(`${CONFIG.CE_SERVER_URL}/api/qa-comparison/analyze`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applicationData }) }, 'PSQ')
    const psqS = results.programSpecific.summary
    logS(`  PSQ: ${psqS?.totalQuestions || 0} Qs — Yes: ${psqS?.yesCount || 0}, No: ${psqS?.noCount || 0}, N/A: ${psqS?.naCount || 0}`)
  } catch (err) { logE(`  PSQ failed: ${err.message}`); results.programSpecific = { error: err.message } }
  return results
}

/**
 * Cache CE results so the dashboard shows tiles.
 * POST /api/processed-applications/save → writes to processed-applications/ + index.json
 */
/**
 * Register the application PDF in the CE server's documents/ folder so the
 * page viewer can serve it via GET /api/documents/:id/file.
 * Returns the documentId (UUID prefix).
 */
async function registerApplicationPDF(appPath, appName, ctx, ceData = null) {
  const { log, logS, logE } = ctx
  try {
    const ceRoot = path.resolve(path.dirname(path.dirname(__dirname)))
    const documentsDir = path.join(ceRoot, 'documents')
    await fs.mkdir(documentsDir, { recursive: true })

    const docId = crypto.randomUUID().split('-')[0]
    const destFileName = `${docId}-${appName}`
    const destPath = path.join(documentsDir, destFileName)

    // Copy the PDF
    await fs.copyFile(appPath, destPath)

    // Write metadata JSON (same format the upload route creates)
    const metadata = {
      id: docId,
      originalName: appName,
      fileName: destFileName,
      filePath: destPath,
      mimeType: 'application/pdf',
      size: (await fs.stat(appPath)).size,
      uploadedAt: new Date().toISOString()
    }

    // Include extraction data so the Chat panel can use it (no extra API calls needed)
    if (ceData && ceData.pages) {
      metadata.analysis = {
        success: true,
        data: ceData,
        metadata: {
          pageCount: ceData.pages.length,
          analyzedAt: new Date().toISOString(),
          source: 'batch_process'
        }
      }
    }

    await fs.writeFile(destPath + '.json', JSON.stringify(metadata, null, 2))
    logS(`PDF registered for page viewer: documents/${destFileName} (id: ${docId})${ceData ? ' [+chat data]' : ''}`)
    return docId
  } catch (err) {
    logE(`Failed to register PDF for page viewer: ${err.message}`)
    return null
  }
}

async function cacheCEResults(appName, checklistName, compResult, selectedSections, qaResults, applicationId, appResult, ctx) {
  const { CONFIG, retryF, logS, logE, PROCESSED_APPS_DIR } = ctx
  try {
    await retryF(`${CONFIG.CE_SERVER_URL}/api/processed-applications/save`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationName: appName, checklistName, comparisonResult: compResult, selectedSections, applicationId }) }, 'cache CE')
    logS('CE compliance cached → dashboard tile')
  } catch (err) { logE(`CE cache failed: ${err.message}`) }

  if (qaResults) {
    await fs.mkdir(PROCESSED_APPS_DIR, { recursive: true })
    const sanitized = appName.replace(/[^a-zA-Z0-9.-]/g, '_')
    const ceChecklistFile = `${sanitized}_checklist_comparison.json`
    await fs.writeFile(path.join(PROCESSED_APPS_DIR, ceChecklistFile),
      JSON.stringify({ applicationName: appName, generatedAt: new Date().toISOString(), ...qaResults }, null, 2)).catch(() => {})
    appResult.ceOutputFile = ceChecklistFile
  }
}

export { cacheCEResults as cacheCE }
