#!/usr/bin/env node
/**
 * migrateProcessedApps.js
 *
 * Moves existing flat files in processed-applications/ into the new
 * FY/NOFO folder structure:
 *
 *   processed-applications/
 *     FY26/HRSA-26-006/app_HRSA_26_006_*.json
 *     FY25/HRSA-25-012/HRSA-25-012_*.json
 *     ...
 *
 * Two-pass detection:
 *   1. NOFO regex in filename (e.g. HRSA-26-006 -> FY26/HRSA-26-006)
 *   2. Tracking number lookup: extracts Application-NNNNNN from filename,
 *      scans applications/FY[xx]/HRSA-[xx]-[nnn]/ for a matching PDF, and
 *      derives the FY/NOFO from the folder path.
 *
 * Files that can't be resolved by either method stay in the root.
 * index.json entries are updated with the new `subdir` field.
 *
 * Usage:
 *   node server/scripts/migrateProcessedApps.js            # dry run (default)
 *   node server/scripts/migrateProcessedApps.js --apply     # actually move files
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CE_ROOT = path.resolve(__dirname, '../..')
const PROCESSED_DIR = path.join(CE_ROOT, 'processed-applications')
const APPLICATIONS_DIR = path.join(CE_ROOT, 'applications')
const INDEX_FILE = path.join(PROCESSED_DIR, 'index.json')
const DRY_RUN = !process.argv.includes('--apply')

function deriveSubdir(name) {
  if (!name) return null
  const m = String(name).match(/HRSA[-_\s](\d{2})[-_\s](\d{3})/i)
  if (!m) return null
  return `FY${m[1]}/HRSA-${m[1]}-${m[2]}`
}

/** Extract tracking number (e.g. 242744) from a filename */
function extractTrackingNo(name) {
  const m = String(name).match(/Application[-_](\d{6})(?=[_.\-\s]|$)/i)
  return m ? m[1] : null
}

/**
 * Build a map: trackingNumber -> "FY26/HRSA-26-006"
 * by scanning applications/FY[xx]/HRSA-[xx]-[nnn]/ for PDFs
 */
async function buildTrackingMap() {
  const trackMap = new Map()
  try {
    const fyDirs = await fs.readdir(APPLICATIONS_DIR, { withFileTypes: true })
    for (const fyEntry of fyDirs) {
      if (!fyEntry.isDirectory() || !fyEntry.name.startsWith('FY')) continue
      const fyName = fyEntry.name // e.g. "FY26"
      const fyPath = path.join(APPLICATIONS_DIR, fyName)
      const nofoDirs = await fs.readdir(fyPath, { withFileTypes: true })
      for (const nofoEntry of nofoDirs) {
        if (!nofoEntry.isDirectory()) continue
        const nofoName = nofoEntry.name // e.g. "HRSA-26-006"
        const nofoPath = path.join(fyPath, nofoName)
        const subdir = `${fyName}/${nofoName}`
        const files = await fs.readdir(nofoPath).catch(() => [])
        for (const f of files) {
          const trackNo = extractTrackingNo(f)
          if (trackNo) trackMap.set(trackNo, subdir)
        }
      }
    }
  } catch { /* applications dir may not exist */ }
  return trackMap
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Migrate processed-applications/ to FY/NOFO structure')
  console.log('═══════════════════════════════════════════════════════════')
  if (DRY_RUN) {
    console.log('  ⚠️  DRY RUN — no files will be moved. Use --apply to execute.\n')
  } else {
    console.log('  🔧 APPLY MODE — files will be moved.\n')
  }

  // Build tracking number → FY/NOFO map from applications/ folder
  console.log('📂 Building tracking number map from applications/ folder...')
  const trackMap = await buildTrackingMap()
  console.log(`   Found ${trackMap.size} application PDFs with tracking numbers\n`)

  // 1. Scan root-level JSON files (not in subdirs)
  const entries = await fs.readdir(PROCESSED_DIR, { withFileTypes: true })
  const rootJsonFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.json') && e.name !== 'index.json')
    .map(e => e.name)

  console.log(`📂 Root JSON files: ${rootJsonFiles.length}`)

  // Load index.json into a map for Pass 3 (lookup by id)
  let indexMap = null
  try {
    const indexData = JSON.parse(await fs.readFile(INDEX_FILE, 'utf-8'))
    indexMap = new Map(indexData.map(e => [e.id, e]))
    console.log(`📋 Loaded index.json: ${indexMap.size} entries`)
  } catch { /* index may not exist yet */ }

  let movedByNofo = 0
  let movedByTracking = 0
  let movedByIndex = 0
  let skipped = 0
  let unresolved = 0
  const unresolvedFiles = []

  for (const file of rootJsonFiles) {
    // Pass 1: try NOFO regex in filename
    let subdir = deriveSubdir(file)
    let method = 'nofo'

    // Pass 2: try tracking number lookup against applications/ folder
    if (!subdir) {
      const trackNo = extractTrackingNo(file)
      if (trackNo && trackMap.has(trackNo)) {
        subdir = trackMap.get(trackNo)
        method = 'tracking'
      }
    }

    // Pass 3: for app_*.json files with truncated names, look up by id in index.json
    if (!subdir && indexMap) {
      const id = file.replace(/\.json$/, '')
      const entry = indexMap.get(id)
      if (entry?.subdir) {
        subdir = entry.subdir
        method = 'index'
      }
    }

    if (!subdir) {
      unresolved++
      unresolvedFiles.push(file)
      continue
    }

    const srcPath = path.join(PROCESSED_DIR, file)
    const destDir = path.join(PROCESSED_DIR, subdir)
    const destPath = path.join(destDir, file)

    const tag = method === 'nofo' ? '' : ` [via ${method}]`

    if (DRY_RUN) {
      console.log(`  → ${file}  ➜  ${subdir}/${file}${tag}`)
    } else {
      await fs.mkdir(destDir, { recursive: true })
      try {
        await fs.access(destPath)
        console.log(`  ⏭️  ${file} — already exists in ${subdir}/, skipping`)
        skipped++
        continue
      } catch { /* doesn't exist, proceed */ }
      await fs.rename(srcPath, destPath)
      console.log(`  ✅ ${file}  ➜  ${subdir}/${file}${tag}`)
    }
    if (method === 'index') movedByIndex++
    else if (method === 'tracking') movedByTracking++
    else movedByNofo++
  }

  console.log(`\n📊 File Migration Summary:`)
  console.log(`   ${DRY_RUN ? 'Would move' : 'Moved'} by NOFO in filename: ${movedByNofo}`)
  console.log(`   ${DRY_RUN ? 'Would move' : 'Moved'} by tracking# lookup:  ${movedByTracking}`)
  console.log(`   ${DRY_RUN ? 'Would move' : 'Moved'} by index.json lookup: ${movedByIndex}`)
  console.log(`   Skipped (already exists): ${skipped}`)
  console.log(`   Unresolved (stays in root): ${unresolved}`)
  if (unresolvedFiles.length > 0 && unresolvedFiles.length <= 20) {
    console.log('   Unresolved files:')
    unresolvedFiles.forEach(f => console.log(`     - ${f}`))
  } else if (unresolvedFiles.length > 20) {
    console.log(`   First 20 unresolved files:`)
    unresolvedFiles.slice(0, 20).forEach(f => console.log(`     - ${f}`))
  }

  // 2. Update index.json — add subdir field to entries that don't have one
  console.log('\n📋 Updating index.json...')
  try {
    const indexData = JSON.parse(await fs.readFile(INDEX_FILE, 'utf-8'))
    let updatedByNofo = 0
    let updatedByTracking = 0
    let indexUnresolved = 0
    for (const entry of indexData) {
      if (entry.subdir) continue // already has subdir

      // Pass 1: NOFO regex
      let subdir = deriveSubdir(entry.name)
      let method = 'nofo'

      // Pass 2: tracking number lookup
      if (!subdir) {
        const trackNo = extractTrackingNo(entry.name) || extractTrackingNo(entry.id)
        if (trackNo && trackMap.has(trackNo)) {
          subdir = trackMap.get(trackNo)
          method = 'tracking'
        }
      }

      if (subdir) {
        entry.subdir = subdir
        if (method === 'tracking') updatedByTracking++
        else updatedByNofo++
        if (DRY_RUN) {
          const tag = method === 'tracking' ? ' [via tracking#]' : ''
          console.log(`  → ${entry.id}: subdir = ${subdir}${tag}`)
        }
      } else {
        indexUnresolved++
      }
    }

    const totalUpdated = updatedByNofo + updatedByTracking
    if (!DRY_RUN && totalUpdated > 0) {
      await fs.writeFile(INDEX_FILE, JSON.stringify(indexData, null, 2))
      console.log(`  ✅ Updated ${totalUpdated} index entries (${updatedByNofo} by NOFO, ${updatedByTracking} by tracking#)`)
    } else {
      console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'}: ${totalUpdated} (${updatedByNofo} by NOFO, ${updatedByTracking} by tracking#)`)
    }
    if (indexUnresolved > 0) {
      console.log(`  ⚠️  ${indexUnresolved} index entries could not be resolved to a FY/NOFO`)
    }
  } catch (err) {
    console.warn(`  ⚠️  Could not update index.json: ${err.message}`)
  }

  if (DRY_RUN) {
    console.log('\n💡 Run with --apply to execute the migration.')
  } else {
    console.log('\n✅ Migration complete.')
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
