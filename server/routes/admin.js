import express from 'express'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = express.Router()

const CONFIG_DIR = join(__dirname, '../../admin-config')
const MAPPINGS_FILE = join(CONFIG_DIR, 'document-mappings.json')

// Ensure config directory exists
async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
}

// Load mappings from disk
async function loadMappings() {
  try {
    const data = await fs.readFile(MAPPINGS_FILE, 'utf-8')
    return JSON.parse(data)
  } catch {
    return { applicationTypes: [], mappings: [] }
  }
}

// Save mappings to disk
async function saveMappings(data) {
  await ensureConfigDir()
  await fs.writeFile(MAPPINGS_FILE, JSON.stringify(data, null, 2))
}

/**
 * GET /api/admin/mappings
 * Get all document mappings (application type -> required checklists)
 */
router.get('/mappings', async (req, res) => {
  try {
    const data = await loadMappings()
    res.json({ success: true, ...data })
  } catch (error) {
    console.error('❌ Load mappings error:', error)
    res.status(500).json({ error: 'Failed to load mappings', message: error.message })
  }
})

/**
 * POST /api/admin/application-types
 * Add a new application type
 * Body: { name, description }
 */
router.post('/application-types', async (req, res) => {
  try {
    const { name, description } = req.body
    if (!name) return res.status(400).json({ error: 'Application type name is required' })

    const data = await loadMappings()
    const id = `type_${name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}_${Date.now()}`

    // Check for duplicate
    if (data.applicationTypes.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'Application type already exists' })
    }

    data.applicationTypes.push({
      id,
      name,
      description: description || '',
      createdAt: new Date().toISOString()
    })

    await saveMappings(data)
    res.json({ success: true, applicationTypes: data.applicationTypes })
  } catch (error) {
    console.error('❌ Add application type error:', error)
    res.status(500).json({ error: 'Failed to add application type', message: error.message })
  }
})

/**
 * DELETE /api/admin/application-types/:id
 * Delete an application type and its mappings
 */
router.delete('/application-types/:id', async (req, res) => {
  try {
    const data = await loadMappings()
    data.applicationTypes = data.applicationTypes.filter(t => t.id !== req.params.id)
    data.mappings = data.mappings.filter(m => m.applicationTypeId !== req.params.id)
    await saveMappings(data)
    res.json({ success: true, applicationTypes: data.applicationTypes })
  } catch (error) {
    console.error('❌ Delete application type error:', error)
    res.status(500).json({ error: 'Failed to delete application type', message: error.message })
  }
})

/**
 * PUT /api/admin/application-types/:id
 * Update an application type
 * Body: { name, description }
 */
router.put('/application-types/:id', async (req, res) => {
  try {
    const { name, description } = req.body
    const data = await loadMappings()
    const appType = data.applicationTypes.find(t => t.id === req.params.id)
    if (!appType) return res.status(404).json({ error: 'Application type not found' })

    if (name) appType.name = name
    if (description !== undefined) appType.description = description

    await saveMappings(data)
    res.json({ success: true, applicationTypes: data.applicationTypes })
  } catch (error) {
    console.error('❌ Update application type error:', error)
    res.status(500).json({ error: 'Failed to update application type', message: error.message })
  }
})

/**
 * POST /api/admin/mappings
 * Add a checklist requirement mapping
 * Body: { applicationTypeId, checklistId, checklistName, required }
 */
router.post('/mappings', async (req, res) => {
  try {
    const { applicationTypeId, checklistId, checklistName, required } = req.body
    if (!applicationTypeId || !checklistId) {
      return res.status(400).json({ error: 'applicationTypeId and checklistId are required' })
    }

    const data = await loadMappings()

    // Check for duplicate mapping
    const existing = data.mappings.find(
      m => m.applicationTypeId === applicationTypeId && m.checklistId === checklistId
    )
    if (existing) {
      // Update existing
      existing.required = required !== false
      existing.checklistName = checklistName || existing.checklistName
    } else {
      const id = `map_${Date.now()}`
      data.mappings.push({
        id,
        applicationTypeId,
        checklistId,
        checklistName: checklistName || 'Unknown Checklist',
        required: required !== false,
        createdAt: new Date().toISOString()
      })
    }

    await saveMappings(data)
    res.json({ success: true, mappings: data.mappings })
  } catch (error) {
    console.error('❌ Add mapping error:', error)
    res.status(500).json({ error: 'Failed to add mapping', message: error.message })
  }
})

/**
 * DELETE /api/admin/mappings/:id
 * Remove a checklist requirement mapping
 */
router.delete('/mappings/:id', async (req, res) => {
  try {
    const data = await loadMappings()
    data.mappings = data.mappings.filter(m => m.id !== req.params.id)
    await saveMappings(data)
    res.json({ success: true, mappings: data.mappings })
  } catch (error) {
    console.error('❌ Delete mapping error:', error)
    res.status(500).json({ error: 'Failed to delete mapping', message: error.message })
  }
})

/**
 * GET /api/admin/mappings/:applicationTypeId
 * Get required checklists for a specific application type
 */
router.get('/mappings/:applicationTypeId', async (req, res) => {
  try {
    const data = await loadMappings()
    const mappings = data.mappings.filter(m => m.applicationTypeId === req.params.applicationTypeId)
    res.json({ success: true, mappings })
  } catch (error) {
    console.error('❌ Get mappings error:', error)
    res.status(500).json({ error: 'Failed to get mappings', message: error.message })
  }
})

export default router
