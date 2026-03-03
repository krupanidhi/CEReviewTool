import fs from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Derive a FY/NOFO subdirectory from an application name or filename.
 * e.g. "HRSA-26-006_SomeName_Application-243164.pdf" → "FY26/HRSA-26-006"
 *      "Application-242656.pdf"                      → null (no NOFO detected)
 */
function deriveSubdir(name) {
  if (!name) return null
  const m = String(name).match(/HRSA[-_\s](\d{2})[-_\s](\d{3})/i)
  if (!m) return null
  const yearCode = m[1]  // e.g. "26"
  const nofo = `HRSA-${yearCode}-${m[2]}`  // e.g. "HRSA-26-006"
  return `FY${yearCode}/${nofo}`  // e.g. "FY26/HRSA-26-006"
}

/**
 * ApplicationProcessingService
 * Manages background processing of multiple applications against checklists.
 * Stores processed results per-application for dashboard display and cache management.
 */
class ApplicationProcessingService {
  constructor() {
    this.storageDir = join(__dirname, '../../processed-applications')
    this.indexFile = join(this.storageDir, 'index.json')
    this.applications = new Map() // id -> metadata
    this.processingQueue = [] // queue of pending jobs
    this.isProcessing = false
    this.initialized = false
  }

  async initialize() {
    if (this.initialized) return
    try {
      await fs.mkdir(this.storageDir, { recursive: true })
      await this.loadIndex()
      this.initialized = true
      console.log(`✅ Application processing service initialized. ${this.applications.size} cached applications.`)
    } catch (error) {
      console.error('❌ Application processing service init error:', error)
    }
  }

  async loadIndex() {
    try {
      const data = await fs.readFile(this.indexFile, 'utf-8')
      const entries = JSON.parse(data)
      this.applications = new Map(entries.map(e => [e.id, e]))
    } catch {
      this.applications = new Map()
    }
  }

  async saveIndex() {
    const entries = Array.from(this.applications.values())
    await fs.writeFile(this.indexFile, JSON.stringify(entries, null, 2))
  }

  /**
   * Resolve the full file path for an application's data JSON.
   * Uses the subdir field from index metadata if present, otherwise falls back to root.
   */
  _resolveDataPath(id) {
    const meta = this.applications.get(id)
    const subdir = meta?.subdir
    if (subdir) {
      return join(this.storageDir, subdir, `${id}.json`)
    }
    return join(this.storageDir, `${id}.json`)
  }

  async saveApplicationData(id, data) {
    const filePath = this._resolveDataPath(id)
    await fs.mkdir(join(filePath, '..'), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(data, null, 2))
  }

  async loadApplicationData(id) {
    const filePath = this._resolveDataPath(id)
    try {
      const data = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(data)
    } catch {
      // Backward compat: try root if subdir path fails
      const rootPath = join(this.storageDir, `${id}.json`)
      const data = await fs.readFile(rootPath, 'utf-8')
      return JSON.parse(data)
    }
  }

  async deleteApplicationData(id) {
    const filePath = this._resolveDataPath(id)
    try {
      await fs.unlink(filePath)
    } catch { /* file may not exist */ }
    // Also try root (backward compat for old flat files)
    const rootPath = join(this.storageDir, `${id}.json`)
    try {
      await fs.unlink(rootPath)
    } catch { /* file may not exist */ }
  }

  /**
   * Generate a unique ID for an application
   */
  generateId(applicationName) {
    const sanitized = applicationName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)
    return `app_${sanitized}_${Date.now()}`
  }

  /**
   * List all processed applications (metadata only)
   */
  listApplications() {
    return Array.from(this.applications.values())
      .sort((a, b) => new Date(b.processedAt || b.createdAt) - new Date(a.processedAt || a.createdAt))
  }

  /**
   * Get a single application's full data (metadata + cached results)
   */
  async getApplication(id) {
    const meta = this.applications.get(id)
    if (!meta) return null

    if (meta.status === 'completed') {
      try {
        const data = await this.loadApplicationData(id)
        return { ...meta, data }
      } catch {
        // Data file missing, mark as needs reprocessing
        meta.status = 'error'
        meta.error = 'Cached data file missing'
        await this.saveIndex()
        return meta
      }
    }

    return meta
  }

  /**
   * Queue an application for background processing.
   * Returns immediately with the application ID and 'processing' status.
   */
  async queueApplication({ applicationName, applicationData, checklistData, selectedSections, checklistName }) {
    const id = this.generateId(applicationName)

    const subdir = deriveSubdir(applicationName)

    const meta = {
      id,
      name: applicationName,
      checklistName: checklistName || 'Unknown Checklist',
      subdir: subdir || null,
      status: 'queued', // queued | processing | completed | error
      createdAt: new Date().toISOString(),
      processedAt: null,
      error: null,
      selectedSectionCount: selectedSections?.length || 0,
      complianceScore: null
    }

    this.applications.set(id, meta)
    await this.saveIndex()

    // Add to processing queue
    this.processingQueue.push({
      id,
      applicationData,
      checklistData,
      selectedSections
    })

    // Start processing if not already running
    this._processQueue()

    return meta
  }

  /**
   * Internal: process the queue sequentially
   */
  async _processQueue() {
    if (this.isProcessing) return
    this.isProcessing = true

    while (this.processingQueue.length > 0) {
      const job = this.processingQueue.shift()
      const meta = this.applications.get(job.id)
      if (!meta) continue

      meta.status = 'processing'
      await this.saveIndex()

      try {
        // The actual comparison is done by the caller via the compareFunction
        // We store the job data so the route can call the AI comparison
        const result = await this._runComparison(job)

        meta.status = 'completed'
        meta.processedAt = new Date().toISOString()
        meta.complianceScore = result.comparison?.overallCompliance || null
        meta.error = null

        // Save full result data to disk
        await this.saveApplicationData(job.id, result)
        await this.saveIndex()

        console.log(`✅ Application processed: ${meta.name} (${meta.complianceScore}% compliance)`)
      } catch (error) {
        meta.status = 'error'
        meta.error = error.message
        meta.processedAt = new Date().toISOString()
        await this.saveIndex()
        console.error(`❌ Application processing failed: ${meta.name}`, error.message)
      }
    }

    this.isProcessing = false
  }

  /**
   * Set the comparison function (injected from the compare route)
   */
  setCompareFunction(fn) {
    this._compareFunction = fn
  }

  async _runComparison(job) {
    if (!this._compareFunction) {
      throw new Error('Compare function not set. Call setCompareFunction first.')
    }
    return await this._compareFunction(job.applicationData, job.checklistData, job.selectedSections)
  }

  /**
   * Save an already-completed comparison result directly (no re-processing needed).
   * Used when the normal comparison flow completes and we want to cache the result.
   */
  async saveCompleted({ applicationName, checklistName, comparisonResult, complianceScore, selectedSections, applicationId }) {
    const id = this.generateId(applicationName)

    // Ensure the checklistName is stored in the result metadata for retrieval
    const dataToSave = { ...comparisonResult }
    if (!dataToSave.metadata) dataToSave.metadata = {}
    dataToSave.metadata.checklistName = checklistName || dataToSave.metadata.checklistName || 'Unknown Checklist'
    // Persist the original selectedSections so cached reports match fresh ones
    if (selectedSections) {
      dataToSave.metadata.selectedSections = selectedSections
    }
    // Persist the application document ID so the PDF can be loaded from cache
    if (applicationId) {
      dataToSave.metadata.applicationId = applicationId
    }

    const subdir = deriveSubdir(applicationName)

    const meta = {
      id,
      name: applicationName,
      checklistName: checklistName || 'Unknown Checklist',
      applicationId: applicationId || null,
      subdir: subdir || null,
      status: 'completed',
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      error: null,
      selectedSectionCount: dataToSave?.comparison?.sections?.length || 0,
      complianceScore: complianceScore || dataToSave?.comparison?.overallCompliance || null
    }

    this.applications.set(id, meta)
    await this.saveApplicationData(id, dataToSave)
    await this.saveIndex()

    console.log(`✅ Application result saved: ${meta.name} (${meta.complianceScore}% compliance)`)
    return meta
  }

  /**
   * Delete a processed application and its cached data
   */
  async deleteApplication(id) {
    this.applications.delete(id)
    await this.deleteApplicationData(id)
    await this.saveIndex()
  }

  /**
   * Delete ALL processed applications and their cached data
   * @returns {number} Number of applications deleted
   */
  async deleteAllApplications() {
    const count = this.applications.size
    const ids = Array.from(this.applications.keys())
    for (const id of ids) {
      await this.deleteApplicationData(id)
    }
    this.applications.clear()
    await this.saveIndex()
    console.log(`🗑️ Deleted all ${count} processed applications`)
    return count
  }

  /**
   * Delete processed applications matching a FY and/or NOFO filter.
   * Also removes companion _checklist_comparison.json files from the same subdir.
   * CE-only — does NOT touch pf-results/.
   * @param {{ fy?: string, nofo?: string }} filter
   * @returns {{ deleted: number, companionFiles: number }}
   */
  async deleteByFilter({ fy, nofo } = {}) {
    if (!fy && !nofo) throw new Error('At least one of fy or nofo must be provided')

    // Normalize FY: accept "FY26", "fy26", "26" → "FY26"
    const normalizedFY = fy ? `FY${String(fy).replace(/^fy/i, '').trim()}` : null

    // Build subdir prefix to match: "FY26" or "FY26/HRSA-26-006"
    let subdirPrefix = normalizedFY || ''
    if (nofo) {
      subdirPrefix = subdirPrefix ? `${subdirPrefix}/${nofo}` : nofo
    }

    // Find matching entries in index by subdir or name
    const toDelete = []
    for (const [id, meta] of this.applications) {
      let matches = false
      if (meta.subdir) {
        // Match by subdir prefix (e.g. "FY26" matches "FY26/HRSA-26-006")
        matches = meta.subdir.startsWith(subdirPrefix)
      } else if (meta.name) {
        // For apps without subdir, try matching FY/NOFO from the name
        if (nofo && meta.name.includes(nofo)) matches = true
        if (normalizedFY && !nofo) {
          const yearCode = normalizedFY.replace('FY', '')
          if (meta.name.includes(`HRSA-${yearCode}-`) || meta.name.includes(`HRSA_${yearCode}_`)) matches = true
        }
      }
      if (matches) toDelete.push(id)
    }

    // Delete matching app_*.json data files
    for (const id of toDelete) {
      await this.deleteApplicationData(id)
      this.applications.delete(id)
    }

    // Also clean up companion _checklist_comparison.json files in the target subdir
    let companionCount = 0
    const targetDir = subdirPrefix ? join(this.storageDir, subdirPrefix) : null
    if (targetDir) {
      try {
        const scanDirs = [targetDir]
        // If only FY specified (no NOFO), scan all NOFO subdirs under that FY
        if (normalizedFY && !nofo) {
          try {
            const fyEntries = await fs.readdir(join(this.storageDir, normalizedFY), { withFileTypes: true })
            for (const e of fyEntries) {
              if (e.isDirectory()) scanDirs.push(join(this.storageDir, normalizedFY, e.name))
            }
          } catch { /* FY dir may not exist */ }
        }
        for (const dir of scanDirs) {
          try {
            const entries = await fs.readdir(dir)
            for (const entry of entries) {
              if (entry.endsWith('_checklist_comparison.json')) {
                await fs.unlink(join(dir, entry)).catch(() => {})
                companionCount++
              }
            }
          } catch { /* dir may not exist */ }
        }
      } catch { /* ignore */ }
    }

    await this.saveIndex()
    console.log(`🗑️ Deleted ${toDelete.length} processed apps + ${companionCount} checklist comparison files (filter: ${subdirPrefix})`)
    return { deleted: toDelete.length, companionFiles: companionCount }
  }

  /**
   * Mark an application for reprocessing (clears cached data, sets status to 'pending_reprocess')
   */
  async markForReprocessing(id) {
    const meta = this.applications.get(id)
    if (!meta) return null

    meta.status = 'pending_reprocess'
    meta.complianceScore = null
    meta.error = null
    await this.deleteApplicationData(id)
    await this.saveIndex()
    return meta
  }

  /**
   * Get processing status summary
   */
  getStatus() {
    const all = Array.from(this.applications.values())
    return {
      total: all.length,
      completed: all.filter(a => a.status === 'completed').length,
      processing: all.filter(a => a.status === 'processing').length,
      queued: all.filter(a => a.status === 'queued').length,
      errors: all.filter(a => a.status === 'error').length
    }
  }
}

const applicationProcessingService = new ApplicationProcessingService()

export default applicationProcessingService
