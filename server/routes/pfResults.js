import express from 'express'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = express.Router()

const PF_RESULTS_DIR = join(__dirname, '../../pf-results')

/**
 * Recursively find a JSON file matching a pattern in a directory tree.
 * Returns { filePath, filename } or null.
 */
async function findJsonRecursive(dir, matchFn) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isFile() && entry.name.endsWith('.json') && matchFn(entry.name)) {
      return { filePath: fullPath, filename: entry.name }
    }
    if (entry.isDirectory()) {
      const found = await findJsonRecursive(fullPath, matchFn)
      if (found) return found
    }
  }
  return null
}

/**
 * Recursively collect all JSON result files with metadata.
 */
async function collectAllResults(dir, relBase) {
  const results = []
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return results }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      results.push(...await collectAllResults(fullPath, relPath))
    } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('Consolidated')) {
      try {
        const stat = await fs.stat(fullPath)
        // Read just enough to get applicationNumber and filename
        const raw = await fs.readFile(fullPath, 'utf-8')
        const data = JSON.parse(raw)

        // Count compliance stats
        let compliant = 0, nonCompliant = 0, notApplicable = 0
        if (data.results) {
          Object.values(data.results).forEach(s => {
            compliant += s.compliantItems?.length || 0
            nonCompliant += s.nonCompliantItems?.length || 0
            notApplicable += s.notApplicableItems?.length || 0
          })
        }
        const total = compliant + nonCompliant + notApplicable

        results.push({
          filename: entry.name,
          relPath,
          applicationNumber: data.applicationNumber || '',
          applicationName: data.filename || entry.name.replace('.json', ''),
          timestamp: data.timestamp || stat.mtime.toISOString(),
          compliant,
          nonCompliant,
          notApplicable,
          total,
          complianceRate: total > 0 ? ((compliant / total) * 100).toFixed(1) : '0.0'
        })
      } catch { /* skip unreadable files */ }
    }
  }
  return results
}

/**
 * GET /list
 * List all cached PF results from pf-results/ FY/NOFO subdirs.
 * Returns summary metadata for each result (no full data).
 */
router.get('/list', async (req, res) => {
  try {
    const results = await collectAllResults(PF_RESULTS_DIR, '')
    // Sort by timestamp descending (most recent first)
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    res.json({ success: true, results, count: results.length })
  } catch (err) {
    console.error('Error listing PF results:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /:applicationNumber
 * Load pre-funding review results for a given application number.
 * Searches pf-results/ recursively (FY/NOFO subdirs) for a JSON file
 * whose name contains "Application-<number>".
 */
router.get('/:applicationNumber', async (req, res) => {
  try {
    const { applicationNumber } = req.params
    if (!applicationNumber || !/^\d+$/.test(applicationNumber)) {
      return res.status(400).json({ success: false, error: 'Invalid application number' })
    }

    const matchFn = f => !f.includes('Consolidated') && f.includes(`Application-${applicationNumber}`)
    const found = await findJsonRecursive(PF_RESULTS_DIR, matchFn)

    if (!found) {
      return res.json({ success: false, error: 'No pre-funding review results found for this application' })
    }

    const data = JSON.parse(await fs.readFile(found.filePath, 'utf-8'))
    return res.json({ success: true, data, filename: found.filename })
  } catch (err) {
    console.error('Error loading PF results:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
})

export default router
