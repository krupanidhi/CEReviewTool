import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import crypto from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const CHECKLISTS_DIR = join(__dirname, '../../stored-checklists')

/**
 * Checklist Storage Service
 * 
 * Stores extracted checklist/guide JSON so it only needs to be processed
 * through Azure Document Intelligence once. Subsequent comparisons reuse
 * the stored JSON directly — no re-upload or re-extraction needed.
 */
class ChecklistStorageService {
  constructor() {
    this.initialized = false
  }

  async ensureDir() {
    if (!this.initialized) {
      await fs.mkdir(CHECKLISTS_DIR, { recursive: true })
      this.initialized = true
    }
  }

  /**
   * Generate a content hash for deduplication
   */
  generateHash(data) {
    const content = typeof data === 'string' ? data : JSON.stringify(data)
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 12)
  }

  /**
   * Save a checklist extraction for future reuse
   * @param {string} originalName - Original PDF filename
   * @param {Object} analysisData - The full analysis result (from Azure Doc Intelligence)
   * @param {Object} structuredData - The structured transformation output
   * @param {string} label - Optional user-friendly label (e.g., "FY26 SAC User Guide")
   * @returns {Object} Stored checklist metadata
   */
  async save(originalName, analysisData, structuredData, label = null) {
    await this.ensureDir()

    const contentHash = this.generateHash(analysisData)
    const id = `checklist_${contentHash}`
    const displayName = label || originalName.replace(/\.[^/.]+$/, '')

    const storedChecklist = {
      id,
      originalName,
      displayName,
      contentHash,
      savedAt: new Date().toISOString(),
      metadata: {
        pageCount: analysisData.metadata?.pageCount || analysisData.pages?.length || 0,
        sectionCount: analysisData.sections?.length || 0,
        tocCount: analysisData.tableOfContents?.length || 0
      },
      data: analysisData,
      structuredData: structuredData
    }

    const filePath = join(CHECKLISTS_DIR, `${id}.json`)
    await fs.writeFile(filePath, JSON.stringify(storedChecklist, null, 2))

    console.log(`📋 Checklist stored: ${displayName} (${id})`)
    console.log(`   Sections: ${storedChecklist.metadata.sectionCount}, Pages: ${storedChecklist.metadata.pageCount}`)

    return {
      id,
      originalName,
      displayName,
      contentHash,
      savedAt: storedChecklist.savedAt,
      metadata: storedChecklist.metadata
    }
  }

  /**
   * Load a stored checklist by ID
   * @param {string} id - Checklist ID
   * @returns {Object|null} Full checklist data or null if not found
   */
  async load(id) {
    await this.ensureDir()

    const filePath = join(CHECKLISTS_DIR, `${id}.json`)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const checklist = JSON.parse(content)
      console.log(`📋 Checklist loaded: ${checklist.displayName} (${id})`)
      return checklist
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  /**
   * List all stored checklists (metadata only, no full data)
   * @returns {Array} List of stored checklist summaries
   */
  async list() {
    await this.ensureDir()

    const files = await fs.readdir(CHECKLISTS_DIR)
    const checklists = []

    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const filePath = join(CHECKLISTS_DIR, file)
        const content = await fs.readFile(filePath, 'utf-8')
        const checklist = JSON.parse(content)

        checklists.push({
          id: checklist.id,
          originalName: checklist.originalName,
          displayName: checklist.displayName,
          contentHash: checklist.contentHash,
          savedAt: checklist.savedAt,
          metadata: checklist.metadata
        })
      } catch (error) {
        console.error(`Failed to read checklist file ${file}:`, error.message)
      }
    }

    // Sort by savedAt descending (most recent first)
    checklists.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))

    return checklists
  }

  /**
   * Delete a stored checklist
   * @param {string} id - Checklist ID
   * @returns {boolean} True if deleted, false if not found
   */
  async delete(id) {
    await this.ensureDir()

    const filePath = join(CHECKLISTS_DIR, `${id}.json`)
    try {
      await fs.unlink(filePath)
      console.log(`🗑️ Checklist deleted: ${id}`)
      return true
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false
      }
      throw error
    }
  }

  /**
   * Update the display name of a stored checklist
   * @param {string} id - Checklist ID
   * @param {string} newDisplayName - New display name
   * @returns {Object|null} Updated metadata or null if not found
   */
  async rename(id, newDisplayName) {
    const checklist = await this.load(id)
    if (!checklist) return null

    checklist.displayName = newDisplayName
    const filePath = join(CHECKLISTS_DIR, `${id}.json`)
    await fs.writeFile(filePath, JSON.stringify(checklist, null, 2))

    console.log(`📋 Checklist renamed: ${id} → ${newDisplayName}`)
    return {
      id: checklist.id,
      originalName: checklist.originalName,
      displayName: newDisplayName,
      savedAt: checklist.savedAt,
      metadata: checklist.metadata
    }
  }

  /**
   * Check if a checklist with the same content already exists
   * @param {Object} analysisData - The analysis data to check
   * @returns {Object|null} Existing checklist metadata or null
   */
  async findByContent(analysisData) {
    const contentHash = this.generateHash(analysisData)
    const id = `checklist_${contentHash}`
    
    const existing = await this.load(id)
    if (existing) {
      return {
        id: existing.id,
        originalName: existing.originalName,
        displayName: existing.displayName,
        savedAt: existing.savedAt,
        metadata: existing.metadata
      }
    }
    return null
  }
}

const checklistStorageService = new ChecklistStorageService()
export default checklistStorageService
