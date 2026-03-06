/**
 * One-time migration script: Upload existing local documents/ PDFs and
 * metadata to Azure Blob Storage.
 *
 * Prerequisites:
 *   - STORAGE_MODE=blob in .env
 *   - AZURE_STORAGE_CONNECTION_STRING set in .env
 *   - AZURE_STORAGE_CONTAINER set in .env (default: pfcereviewtoolstorage)
 *
 * Usage:
 *   node server/scripts/migrateToBlob.js [--category documents|extractions|all] [--dry-run]
 *
 * This script reads files from the local directories and uploads them
 * to the configured Azure Blob container. It skips files that already
 * exist in blob (by checking existence first).
 */

import dotenv from 'dotenv'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

// Force blob mode for this script
process.env.STORAGE_MODE = 'blob'

const { default: storageService } = await import('../services/storageService.js')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const categoryArg = args.find(a => !a.startsWith('--')) || 'all'
const categories = categoryArg === 'all' ? ['documents', 'extractions'] : [categoryArg]

console.log(`\n📦 Migrate to Azure Blob Storage`)
console.log(`   Categories: ${categories.join(', ')}`)
console.log(`   Dry run: ${dryRun}`)
console.log('')

await storageService.initialize()

for (const category of categories) {
  const localDir = storageService.getLocalDir(category)
  console.log(`\n── ${category}/ ──`)
  console.log(`   Local dir: ${localDir}`)

  let files
  try {
    files = await walkDir(localDir)
  } catch {
    console.log(`   Directory not found, skipping`)
    continue
  }

  console.log(`   Found ${files.length} local files`)

  let uploaded = 0, skipped = 0, failed = 0

  for (let i = 0; i < files.length; i++) {
    const { relativePath, fullPath, size } = files[i]
    const sizeMB = (size / 1024 / 1024).toFixed(1)

    // Check if already in blob
    const alreadyExists = await storageService.exists(category, relativePath)
    if (alreadyExists) {
      skipped++
      continue
    }

    if (dryRun) {
      console.log(`   [DRY] Would upload: ${relativePath} (${sizeMB} MB)`)
      uploaded++
      continue
    }

    try {
      const buf = await fs.readFile(fullPath)
      const contentType = relativePath.endsWith('.json') ? 'application/json'
        : relativePath.endsWith('.pdf') ? 'application/pdf'
        : 'application/octet-stream'

      await storageService.saveFile(category, relativePath, buf, { contentType })
      uploaded++

      if (uploaded % 50 === 0 || size > 10 * 1024 * 1024) {
        console.log(`   [${i + 1}/${files.length}] Uploaded: ${relativePath} (${sizeMB} MB)`)
      }
    } catch (err) {
      console.error(`   ❌ Failed: ${relativePath} — ${err.message}`)
      failed++
    }
  }

  console.log(`\n   ✅ ${category}: ${uploaded} uploaded, ${skipped} already in blob, ${failed} failed`)
}

console.log(`\n🏁 Migration complete.`)

async function walkDir(dir, basePath = '') {
  const results = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    if (entry.isFile()) {
      const stat = await fs.stat(fullPath)
      results.push({ relativePath, fullPath, size: stat.size })
    } else if (entry.isDirectory()) {
      results.push(...await walkDir(fullPath, relativePath))
    }
  }
  return results
}
