#!/usr/bin/env node
/**
 * migratePfResults.js
 *
 * Migrates flat pf-results/ JSON files into FY/NOFO/ subdirectories,
 * mirroring the applications/ folder structure.
 *
 * 3-pass detection:
 *   Pass 1: NOFO regex in filename (e.g., HRSA-26-002_..._Application-242744.json)
 *   Pass 2: Tracking number lookup — scan applications/ PDFs to map tracking# → FY/NOFO
 *   Pass 3: applicationNumber field inside JSON — read file and look up tracking# from content
 *
 * Usage:
 *   node server/scripts/migratePfResults.js            # dry run (preview only)
 *   node server/scripts/migratePfResults.js --apply     # actually move files
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CE_ROOT = path.resolve(__dirname, '../..')
const PF_RESULTS_DIR = path.join(CE_ROOT, 'pf-results')
const APPLICATIONS_DIR = path.join(CE_ROOT, 'applications')

const APPLY = process.argv.includes('--apply')

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractNOFO(name) {
  const m = String(name).match(/HRSA[-_\s](\d{2})[-_\s](\d{3})/i)
  return m ? { nofo: `HRSA-${m[1]}-${m[2]}`, fy: `FY${m[1]}` } : null
}

function extractTrackingNo(name) {
  const m = String(name).match(/Application[-_](\d{6})(?=[_.\-\s]|$)/i)
  return m ? m[1] : null
}

/**
 * Build a map: trackingNumber → { fy, nofo, subdir }
 * by scanning applications/<FY>/<NOFO>/*.pdf
 */
async function buildTrackingMap() {
  const map = new Map()
  let fyDirs
  try {
    fyDirs = await fs.readdir(APPLICATIONS_DIR)
  } catch { return map }

  for (const fy of fyDirs) {
    if (!fy.startsWith('FY')) continue
    const fyPath = path.join(APPLICATIONS_DIR, fy)
    const stat = await fs.stat(fyPath).catch(() => null)
    if (!stat?.isDirectory()) continue

    let nofoDirs
    try { nofoDirs = await fs.readdir(fyPath) } catch { continue }

    for (const nofo of nofoDirs) {
      if (!nofo.startsWith('HRSA-')) continue
      const nofoPath = path.join(fyPath, nofo)
      const nStat = await fs.stat(nofoPath).catch(() => null)
      if (!nStat?.isDirectory()) continue

      let files
      try { files = await fs.readdir(nofoPath) } catch { continue }

      for (const file of files) {
        const trackNo = extractTrackingNo(file)
        if (trackNo) {
          map.set(trackNo, { fy, nofo, subdir: `${fy}/${nofo}` })
        }
      }
    }
  }
  return map
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📂 PF-Results Migration ${APPLY ? '(APPLY MODE)' : '(DRY RUN)'}`)
  console.log(`   Source: ${PF_RESULTS_DIR}`)
  console.log(`   Reference: ${APPLICATIONS_DIR}\n`)

  // Read all JSON files in pf-results root (skip subdirs)
  let allFiles
  try {
    const entries = await fs.readdir(PF_RESULTS_DIR, { withFileTypes: true })
    allFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json')).map(e => e.name)
  } catch (err) {
    console.error(`❌ Cannot read pf-results: ${err.message}`)
    process.exit(1)
  }

  console.log(`📋 Found ${allFiles.length} JSON files in pf-results root\n`)

  if (allFiles.length === 0) {
    console.log('✅ Nothing to migrate.')
    return
  }

  // Build tracking number map from applications/
  console.log('🔍 Building tracking number map from applications/ ...')
  const trackingMap = await buildTrackingMap()
  console.log(`   ${trackingMap.size} tracking numbers mapped\n`)

  const results = { moved: 0, unresolved: 0, byNofo: 0, byTracking: 0, byContent: 0 }
  const unresolvedFiles = []

  for (const file of allFiles) {
    let subdir = null
    let method = ''

    // Pass 1: NOFO regex in filename
    const nofoInfo = extractNOFO(file)
    if (nofoInfo) {
      subdir = `${nofoInfo.fy}/${nofoInfo.nofo}`
      method = 'nofo'
    }

    // Pass 2: Tracking number lookup
    if (!subdir) {
      const trackNo = extractTrackingNo(file)
      if (trackNo && trackingMap.has(trackNo)) {
        subdir = trackingMap.get(trackNo).subdir
        method = 'tracking'
      }
    }

    // Pass 3: Read applicationNumber from JSON content
    if (!subdir) {
      try {
        const content = JSON.parse(await fs.readFile(path.join(PF_RESULTS_DIR, file), 'utf-8'))
        const appNum = content.applicationNumber
        if (appNum && trackingMap.has(appNum)) {
          subdir = trackingMap.get(appNum).subdir
          method = 'content'
        }
      } catch { /* skip unreadable files */ }
    }

    if (!subdir) {
      results.unresolved++
      unresolvedFiles.push(file)
      console.log(`   ⚠️  UNRESOLVED: ${file}`)
      continue
    }

    // Count by method
    if (method === 'nofo') results.byNofo++
    else if (method === 'tracking') results.byTracking++
    else if (method === 'content') results.byContent++

    const destDir = path.join(PF_RESULTS_DIR, subdir)
    const srcPath = path.join(PF_RESULTS_DIR, file)
    const destPath = path.join(destDir, file)

    if (APPLY) {
      await fs.mkdir(destDir, { recursive: true })
      await fs.rename(srcPath, destPath)
    }

    results.moved++
    const tag = method === 'nofo' ? '[via NOFO]' : method === 'tracking' ? '[via tracking#]' : '[via content]'
    console.log(`   ✅ ${tag} ${file} → ${subdir}/`)
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`📊 Summary:`)
  console.log(`   Total files:     ${allFiles.length}`)
  console.log(`   Moved:           ${results.moved} (NOFO: ${results.byNofo}, tracking#: ${results.byTracking}, content: ${results.byContent})`)
  console.log(`   Unresolved:      ${results.unresolved}`)
  console.log(`${'═'.repeat(60)}`)

  if (unresolvedFiles.length > 0) {
    console.log(`\n⚠️  Unresolved files (${unresolvedFiles.length}):`)
    for (const f of unresolvedFiles) console.log(`   - ${f}`)
  }

  if (!APPLY && results.moved > 0) {
    console.log(`\n💡 This was a DRY RUN. To apply, run:`)
    console.log(`   node server/scripts/migratePfResults.js --apply`)
  }

  if (APPLY && results.moved > 0) {
    console.log(`\n✅ Migration complete. ${results.moved} files moved.`)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
