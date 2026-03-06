#!/usr/bin/env node
/**
 * cleanupByChecklist.js
 *
 * Removes processed applications from the dashboard by matching their
 * `checklistName` field in index.json. This is the most reliable way
 * to identify which FY an application belongs to, since older apps
 * may not have a `subdir` or HRSA number in their filename.
 *
 * What it does:
 *   1. Reads processed-applications/index.json
 *   2. Filters entries whose checklistName contains the search term
 *   3. Deletes each matched app's data file (app_*.json)
 *   4. Removes companion _checklist_comparison.json files in subdirs
 *   5. Rewrites index.json without the deleted entries
 *
 * What it does NOT touch:
 *   - Source PDFs in applications/
 *   - Prefunding results in pf-results/
 *   - Any entries not matching the filter
 *
 * Usage:
 *   node server/scripts/cleanupByChecklist.js FY24                # dry run (default)
 *   node server/scripts/cleanupByChecklist.js FY24 --apply        # actually delete
 *   node server/scripts/cleanupByChecklist.js "FY24SACUserGuide"  # more specific match
 *
 * The search is case-insensitive and uses "contains" matching.
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CE_ROOT = path.resolve(__dirname, '../..')
const PROCESSED_DIR = path.join(CE_ROOT, 'processed-applications')
const INDEX_FILE = path.join(PROCESSED_DIR, 'index.json')

const args = process.argv.slice(2)
const DRY_RUN = !args.includes('--apply')
const searchTerm = args.find(a => !a.startsWith('--'))

if (!searchTerm) {
  console.error('Usage: node server/scripts/cleanupByChecklist.js <checklistName-search> [--apply]')
  console.error('Example: node server/scripts/cleanupByChecklist.js FY24')
  console.error('         node server/scripts/cleanupByChecklist.js FY24 --apply')
  process.exit(1)
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  Cleanup Processed Applications by checklistName')
  console.log('═══════════════════════════════════════════════════════════')
  if (DRY_RUN) {
    console.log('  ⚠️  DRY RUN — no files will be deleted. Use --apply to execute.\n')
  } else {
    console.log('  🔧 APPLY MODE — files will be deleted.\n')
  }
  console.log(`  Search term: "${searchTerm}" (case-insensitive contains match)\n`)

  // 1. Load index.json
  let indexData
  try {
    indexData = JSON.parse(await fs.readFile(INDEX_FILE, 'utf-8'))
  } catch (err) {
    console.error(`❌ Could not read ${INDEX_FILE}: ${err.message}`)
    process.exit(1)
  }
  console.log(`📋 Loaded index.json: ${indexData.length} entries`)

  // 2. Partition entries: match vs keep
  const searchLower = searchTerm.toLowerCase()
  const toDelete = []
  const toKeep = []

  for (const entry of indexData) {
    const checklistName = (entry.checklistName || '').toLowerCase()
    if (checklistName.includes(searchLower)) {
      toDelete.push(entry)
    } else {
      toKeep.push(entry)
    }
  }

  console.log(`\n🔍 Matched ${toDelete.length} entries (keeping ${toKeep.length})`)

  if (toDelete.length === 0) {
    console.log('   Nothing to delete. Exiting.')
    process.exit(0)
  }

  // Show distinct checklistNames being matched
  const distinctNames = [...new Set(toDelete.map(e => e.checklistName))].sort()
  console.log(`   Distinct checklistName values matched:`)
  for (const name of distinctNames) {
    const count = toDelete.filter(e => e.checklistName === name).length
    console.log(`     - "${name}" (${count} apps)`)
  }

  // Show sample entries
  console.log(`\n   Sample entries to delete (first 10):`)
  for (const entry of toDelete.slice(0, 10)) {
    const sub = entry.subdir || '(root)'
    console.log(`     ${entry.id}  [${sub}]  ${entry.name}`)
  }
  if (toDelete.length > 10) {
    console.log(`     ... and ${toDelete.length - 10} more`)
  }

  // 3. Backup index.json
  const backupFile = INDEX_FILE.replace('.json', `_backup_${Date.now()}.json`)
  if (!DRY_RUN) {
    await fs.copyFile(INDEX_FILE, backupFile)
    console.log(`\n💾 Backed up index.json → ${path.basename(backupFile)}`)
  }

  // 4. Delete data files for each matched entry
  let deletedFiles = 0
  let missingFiles = 0

  for (const entry of toDelete) {
    // Resolve data file path (same logic as applicationProcessingService)
    const subdirPath = entry.subdir
      ? path.join(PROCESSED_DIR, entry.subdir, `${entry.id}.json`)
      : path.join(PROCESSED_DIR, `${entry.id}.json`)
    const rootPath = path.join(PROCESSED_DIR, `${entry.id}.json`)

    for (const filePath of [subdirPath, rootPath]) {
      try {
        await fs.access(filePath)
        if (DRY_RUN) {
          // Just count it
        } else {
          await fs.unlink(filePath)
        }
        deletedFiles++
      } catch {
        // File doesn't exist at this path — that's OK
      }
    }
  }

  // 5. Clean up companion _checklist_comparison.json files in matched subdirs
  let companionCount = 0
  const subdirs = [...new Set(toDelete.map(e => e.subdir).filter(Boolean))]
  for (const subdir of subdirs) {
    const dirPath = path.join(PROCESSED_DIR, subdir)
    try {
      const files = await fs.readdir(dirPath)
      for (const file of files) {
        if (file.endsWith('_checklist_comparison.json')) {
          if (!DRY_RUN) {
            await fs.unlink(path.join(dirPath, file))
          }
          companionCount++
        }
      }
    } catch { /* dir may not exist */ }
  }

  // 6. Rewrite index.json without the deleted entries
  if (!DRY_RUN) {
    await fs.writeFile(INDEX_FILE, JSON.stringify(toKeep, null, 2))
  }

  // 7. Summary
  console.log('\n' + '─'.repeat(60))
  console.log(`📊 Cleanup Summary:`)
  console.log(`   Entries ${DRY_RUN ? 'to remove' : 'removed'} from index: ${toDelete.length}`)
  console.log(`   Data files ${DRY_RUN ? 'to delete' : 'deleted'}:          ${deletedFiles}`)
  console.log(`   Companion files ${DRY_RUN ? 'to delete' : 'deleted'}:     ${companionCount}`)
  console.log(`   Remaining entries in index:        ${toKeep.length}`)
  if (!DRY_RUN) {
    console.log(`   Backup saved:                      ${path.basename(backupFile)}`)
  }
  console.log('─'.repeat(60))

  if (DRY_RUN) {
    console.log('\n💡 Run with --apply to execute the cleanup.')
  } else {
    console.log('\n✅ Cleanup complete. Restart the server to reload index.json.')
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err)
  process.exit(1)
})
