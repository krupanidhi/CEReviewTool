import express from 'express'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join, basename } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = express.Router()
const APPLICATIONS_DIR = join(__dirname, '../../applications')

/**
 * GET /api/applications/browse
 * List all applications organized by FY → NOFO → PDF files.
 * Supports the folder structure:
 *   applications/FY26/HRSA-26-002/*.pdf
 *   applications/FY25/HRSA-25-004/*.pdf
 *
 * Also returns any loose PDFs at the root level or NOFO-only level
 * for backward compatibility.
 *
 * Response shape:
 * {
 *   fiscalYears: [
 *     { fy: "FY26", nofos: [
 *       { nofo: "HRSA-26-002", applications: [
 *         { name: "ORG_NAME_Application-242847.pdf", path: "FY26/HRSA-26-002/...", size: 9410910 }
 *       ]}
 *     ]},
 *   ],
 *   ungrouped: [ ... ]  // loose PDFs not in FY/NOFO structure
 * }
 */
router.get('/browse', async (req, res) => {
  try {
    await fs.mkdir(APPLICATIONS_DIR, { recursive: true })
    const entries = await fs.readdir(APPLICATIONS_DIR, { withFileTypes: true })

    const fiscalYears = []
    const ungrouped = []

    for (const entry of entries) {
      const fullPath = join(APPLICATIONS_DIR, entry.name)

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        // Loose PDF at root level
        const stat = await fs.stat(fullPath)
        ungrouped.push({
          name: entry.name,
          path: entry.name,
          size: stat.size,
          fullPath: fullPath
        })
        continue
      }

      if (!entry.isDirectory()) continue

      // Check if this is a FY folder (e.g., FY26, FY25) or a NOFO folder (e.g., HRSA-26-002)
      if (/^FY\d{2}$/i.test(entry.name)) {
        // FY folder — scan for NOFO subfolders and loose PDFs
        const fyEntry = { fy: entry.name.toUpperCase(), nofos: [], loosePdfs: [] }
        const fyContents = await fs.readdir(fullPath, { withFileTypes: true })

        for (const fyItem of fyContents) {
          const fyItemPath = join(fullPath, fyItem.name)

          if (fyItem.isFile() && fyItem.name.toLowerCase().endsWith('.pdf')) {
            const stat = await fs.stat(fyItemPath)
            fyEntry.loosePdfs.push({
              name: fyItem.name,
              path: `${entry.name}/${fyItem.name}`,
              size: stat.size,
              fullPath: fyItemPath
            })
          } else if (fyItem.isDirectory()) {
            // NOFO subfolder
            const nofoEntry = { nofo: fyItem.name, applications: [] }
            const nofoContents = await fs.readdir(fyItemPath, { withFileTypes: true })

            for (const pdfItem of nofoContents) {
              if (pdfItem.isFile() && pdfItem.name.toLowerCase().endsWith('.pdf')) {
                const stat = await fs.stat(join(fyItemPath, pdfItem.name))
                nofoEntry.applications.push({
                  name: pdfItem.name,
                  path: `${entry.name}/${fyItem.name}/${pdfItem.name}`,
                  size: stat.size,
                  fullPath: join(fyItemPath, pdfItem.name)
                })
              }
            }

            // Sort applications by name
            nofoEntry.applications.sort((a, b) => a.name.localeCompare(b.name))
            if (nofoEntry.applications.length > 0) {
              fyEntry.nofos.push(nofoEntry)
            }
          }
        }

        // Sort NOFOs
        fyEntry.nofos.sort((a, b) => a.nofo.localeCompare(b.nofo))
        fiscalYears.push(fyEntry)

      } else if (/^HRSA/i.test(entry.name)) {
        // NOFO folder at root level (backward compat) — treat as ungrouped NOFO
        // Detect FY from NOFO number: HRSA-26-002 → FY26
        const fyMatch = entry.name.match(/HRSA-(\d{2})/i)
        const inferredFY = fyMatch ? `FY${fyMatch[1]}` : null

        const nofoEntry = { nofo: entry.name, applications: [], inferredFY }
        const nofoContents = await fs.readdir(fullPath, { withFileTypes: true })

        for (const pdfItem of nofoContents) {
          if (pdfItem.isFile() && pdfItem.name.toLowerCase().endsWith('.pdf')) {
            const stat = await fs.stat(join(fullPath, pdfItem.name))
            nofoEntry.applications.push({
              name: pdfItem.name,
              path: `${entry.name}/${pdfItem.name}`,
              size: stat.size,
              fullPath: join(fullPath, pdfItem.name)
            })
          }
        }

        nofoEntry.applications.sort((a, b) => a.name.localeCompare(b.name))

        // Try to merge into an existing FY entry or create one
        if (inferredFY && nofoEntry.applications.length > 0) {
          let fyEntry = fiscalYears.find(f => f.fy === inferredFY)
          if (!fyEntry) {
            fyEntry = { fy: inferredFY, nofos: [], loosePdfs: [] }
            fiscalYears.push(fyEntry)
          }
          fyEntry.nofos.push(nofoEntry)
        }
      }
    }

    // Sort FYs descending (FY26 before FY25)
    fiscalYears.sort((a, b) => b.fy.localeCompare(a.fy))

    // Calculate totals
    let totalApps = ungrouped.length
    for (const fy of fiscalYears) {
      totalApps += (fy.loosePdfs || []).length
      for (const nofo of fy.nofos) {
        totalApps += nofo.applications.length
      }
    }

    res.json({
      success: true,
      totalApplications: totalApps,
      applicationsDir: APPLICATIONS_DIR,
      fiscalYears,
      ungrouped
    })
  } catch (error) {
    console.error('❌ Error browsing applications:', error)
    res.status(500).json({ error: 'Failed to browse applications', message: error.message })
  }
})

/**
 * GET /api/applications/load/:path(*)
 * Load a specific application PDF — extract with Azure DI and return the data.
 * The path is relative to the applications/ folder.
 * e.g., GET /api/applications/load/FY26/HRSA-26-002/filename.pdf
 */
router.get('/load/:path(*)', async (req, res) => {
  try {
    const relPath = req.params.path
    const fullPath = join(APPLICATIONS_DIR, relPath)

    // Security: ensure the resolved path is within APPLICATIONS_DIR
    const resolvedPath = await fs.realpath(fullPath).catch(() => fullPath)
    if (!resolvedPath.startsWith(APPLICATIONS_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Check file exists
    try {
      await fs.access(fullPath)
    } catch {
      return res.status(404).json({ error: `Application not found: ${relPath}` })
    }

    // Return the file path — the UI will use the upload/extract flow
    // or we can read the extraction cache if it exists
    const stat = await fs.stat(fullPath)
    res.json({
      success: true,
      name: basename(fullPath),
      path: relPath,
      fullPath,
      size: stat.size
    })
  } catch (error) {
    console.error('❌ Error loading application:', error)
    res.status(500).json({ error: 'Failed to load application', message: error.message })
  }
})

/**
 * POST /api/applications/extract
 * Extract a PDF from the applications folder using Azure Document Intelligence.
 * Body: { path: "FY26/HRSA-26-002/filename.pdf" }
 * Returns the extracted application data (same format as upload route).
 */
router.post('/extract', async (req, res) => {
  try {
    const { path: relPath } = req.body
    if (!relPath) {
      return res.status(400).json({ error: 'path is required' })
    }

    const fullPath = join(APPLICATIONS_DIR, relPath)

    // Security check
    const resolvedPath = await fs.realpath(fullPath).catch(() => fullPath)
    if (!resolvedPath.startsWith(APPLICATIONS_DIR)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Check file exists
    try {
      await fs.access(fullPath)
    } catch {
      return res.status(404).json({ error: `Application not found: ${relPath}` })
    }

    // Check for cached extraction first
    const extractionsDir = join(__dirname, '../../extractions')
    const appName = basename(fullPath)
    const cachedExtraction = await findCachedExtraction(extractionsDir, appName)

    if (cachedExtraction) {
      console.log(`📦 Using cached extraction for ${appName}`)
      const data = JSON.parse(await fs.readFile(cachedExtraction, 'utf-8'))

      // Also extract TOC links from the PDF
      let tocLinks = data.tocLinks || null
      if (!tocLinks) {
        try {
          const { extractTocLinks } = await import('../services/pdfLinkExtractor.js')
          const pdfBuffer = await fs.readFile(fullPath)
          tocLinks = await extractTocLinks(pdfBuffer)
          if (tocLinks.length > 0) {
            data.tocLinks = tocLinks
          }
        } catch (linkErr) {
          console.warn(`⚠️ TOC link extraction skipped: ${linkErr.message}`)
        }
      }

      return res.json({
        success: true,
        source: 'cache',
        originalName: appName,
        data
      })
    }

    // No cache — extract with Azure DI
    console.log(`📤 Extracting ${appName} with Azure Document Intelligence...`)
    const { analyzeDocumentEnhanced } = await import('../services/enhancedDocumentIntelligence.js')
    const fileBuffer = await fs.readFile(fullPath)
    const analysisResult = await analyzeDocumentEnhanced(fileBuffer, 'application/pdf')

    // Extract TOC links
    try {
      const { extractTocLinks } = await import('../services/pdfLinkExtractor.js')
      const tocLinks = await extractTocLinks(fileBuffer)
      if (tocLinks.length > 0) {
        analysisResult.data.tocLinks = tocLinks
        console.log(`🔗 Stored ${tocLinks.length} TOC links`)
      }
    } catch (linkErr) {
      console.warn(`⚠️ TOC link extraction skipped: ${linkErr.message}`)
    }

    // Cache the extraction
    await fs.mkdir(extractionsDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const sanitizedName = appName.replace(/[^a-zA-Z0-9.-]/g, '_')
    const extractionFileName = `${timestamp}_${sanitizedName}_extraction.json`
    await fs.writeFile(
      join(extractionsDir, extractionFileName),
      JSON.stringify(analysisResult.data, null, 2)
    )
    console.log(`💾 Extraction cached: ${extractionFileName}`)

    res.json({
      success: true,
      source: 'extracted',
      originalName: appName,
      data: analysisResult.data
    })
  } catch (error) {
    console.error('❌ Error extracting application:', error)
    res.status(500).json({ error: 'Failed to extract application', message: error.message })
  }
})

/**
 * Find a cached extraction JSON for a given application PDF name.
 * Searches the extractions/ folder for files matching the app name.
 */
async function findCachedExtraction(extractionsDir, appName) {
  try {
    const files = await fs.readdir(extractionsDir)
    // Match by sanitized app name in the extraction filename
    const sanitized = appName.replace(/[^a-zA-Z0-9.-]/g, '_')
    // Find the most recent extraction for this app
    const matches = files
      .filter(f => f.includes(sanitized) && f.endsWith('_extraction.json'))
      .sort()
      .reverse()

    if (matches.length > 0) {
      return join(extractionsDir, matches[0])
    }
  } catch { /* extractions dir may not exist */ }
  return null
}

export default router
