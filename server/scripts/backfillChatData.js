#!/usr/bin/env node
/**
 * Backfill Chat Data — One-time script
 * 
 * Populates analysis.data in documents/*.json from existing extraction files
 * in extractions/ so the Chat panel can use them. 
 * 
 * ZERO COST — no API calls, no re-extraction. Pure disk I/O.
 * 
 * Matching: by Application ID number (e.g., "243650" from "Application-243650")
 * 
 * Usage:
 *   node server/scripts/backfillChatData.js          # dry-run (shows what would change)
 *   node server/scripts/backfillChatData.js --apply   # actually write changes
 */

import fs from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { convertToCEFormat } from './sharedExtraction.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CE_ROOT = path.resolve(__dirname, '../..')
const DOCUMENTS_DIR = path.join(CE_ROOT, 'documents')
const EXTRACTIONS_DIR = path.join(CE_ROOT, 'extractions')

const dryRun = !process.argv.includes('--apply')

function getApplicationNumber(name) {
  const m = name.match(/Application-(\d+)/i)
  return m ? m[1] : null
}

async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log('  Backfill Chat Data from Existing Extractions')
  console.log('═'.repeat(60))
  if (dryRun) console.log('  🔍 DRY RUN — pass --apply to write changes\n')
  else console.log('  ✏️  APPLY MODE — will write to documents/*.json\n')

  // 1. Find all document records missing analysis.data
  const docFiles = (await fs.readdir(DOCUMENTS_DIR)).filter(f => f.endsWith('.json'))
  const needsBackfill = []

  for (const file of docFiles) {
    const content = JSON.parse(await fs.readFile(path.join(DOCUMENTS_DIR, file), 'utf-8'))
    if (!content.analysis || !content.analysis.data) {
      needsBackfill.push({ file, doc: content })
    }
  }
  console.log(`📄 Documents without analysis.data: ${needsBackfill.length}`)

  // 2. Build extraction map: Application ID → latest extraction file
  const extFiles = (await fs.readdir(EXTRACTIONS_DIR)).filter(f => f.endsWith('_extraction.json'))
  const extMap = new Map()
  for (const f of extFiles) {
    const appNum = getApplicationNumber(f)
    if (appNum) {
      // Keep the latest extraction (files are timestamped, lexicographic sort works)
      if (!extMap.has(appNum) || f > extMap.get(appNum)) {
        extMap.set(appNum, f)
      }
    }
  }
  console.log(`📦 Unique extraction files available: ${extMap.size}`)

  // 3. Match and backfill
  let matched = 0, skipped = 0, errors = 0

  for (const { file, doc } of needsBackfill) {
    const appNum = getApplicationNumber(doc.originalName)
    if (!appNum || !extMap.has(appNum)) {
      skipped++
      continue
    }

    const extFile = extMap.get(appNum)
    const extPath = path.join(EXTRACTIONS_DIR, extFile)

    try {
      console.log(`\n  🔗 ${doc.originalName}`)
      console.log(`     ← ${extFile}`)

      // Load raw Azure DI result and convert to CE format
      const rawExtraction = JSON.parse(await fs.readFile(extPath, 'utf-8'))
      const analyzeResult = rawExtraction.analyzeResult || rawExtraction
      const ceData = convertToCEFormat(analyzeResult)

      if (!ceData.pages || ceData.pages.length === 0) {
        console.log(`     ⚠️  Conversion produced 0 pages — skipping`)
        skipped++
        continue
      }

      console.log(`     ✅ ${ceData.pages.length} pages, ${ceData.tables.length} tables, ${ceData.sections.length} sections`)

      if (!dryRun) {
        // Write analysis.data into the document record
        doc.analysis = {
          success: true,
          data: ceData,
          metadata: {
            pageCount: ceData.pages.length,
            analyzedAt: new Date().toISOString(),
            source: 'backfill_from_extraction'
          }
        }
        doc.extractionFilePath = extPath

        // Also link the structured file if it exists
        const structFile = extFile.replace('_extraction.json', '_structured.json')
        const structPath = path.join(EXTRACTIONS_DIR, structFile)
        if (existsSync(structPath)) {
          doc.structuredFilePath = structPath
        }

        await fs.writeFile(path.join(DOCUMENTS_DIR, file), JSON.stringify(doc, null, 2))
        console.log(`     💾 Written to documents/${file}`)
      }

      matched++
    } catch (err) {
      console.log(`     ❌ Error: ${err.message}`)
      errors++
    }
  }

  // Summary
  console.log('\n' + '─'.repeat(60))
  console.log(`  ✅ Backfilled: ${matched}`)
  console.log(`  ⏭️  Skipped (no extraction): ${skipped}`)
  console.log(`  ❌ Errors: ${errors}`)
  console.log(`  📊 Total docs without analysis: ${needsBackfill.length}`)
  if (dryRun && matched > 0) {
    console.log(`\n  💡 Run with --apply to write changes:`)
    console.log(`     node server/scripts/backfillChatData.js --apply`)
  }
  console.log('')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
