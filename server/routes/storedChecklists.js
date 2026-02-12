import express from 'express'
import checklistStorageService from '../services/checklistStorageService.js'

const router = express.Router()

/**
 * GET /api/stored-checklists
 * List all stored checklists (metadata only)
 */
router.get('/', async (req, res) => {
  try {
    const checklists = await checklistStorageService.list()
    res.json({
      success: true,
      count: checklists.length,
      checklists
    })
  } catch (error) {
    console.error('❌ Error listing stored checklists:', error)
    res.status(500).json({ error: 'Failed to list stored checklists', message: error.message })
  }
})

/**
 * GET /api/stored-checklists/:id
 * Load a stored checklist by ID (full data for comparison)
 */
router.get('/:id', async (req, res) => {
  try {
    const checklist = await checklistStorageService.load(req.params.id)
    if (!checklist) {
      return res.status(404).json({ error: 'Checklist not found' })
    }

    res.json({
      success: true,
      id: checklist.id,
      originalName: checklist.originalName,
      displayName: checklist.displayName,
      savedAt: checklist.savedAt,
      metadata: checklist.metadata,
      analysis: { data: checklist.data },
      data: checklist.data,
      structuredData: checklist.structuredData
    })
  } catch (error) {
    console.error('❌ Error loading stored checklist:', error)
    res.status(500).json({ error: 'Failed to load stored checklist', message: error.message })
  }
})

/**
 * POST /api/stored-checklists/save
 * Save a checklist from an already-uploaded document
 * Body: { originalName, data, structuredData, label }
 */
router.post('/save', async (req, res) => {
  try {
    const { originalName, data, structuredData, label } = req.body

    if (!originalName || !data) {
      return res.status(400).json({ error: 'originalName and data are required' })
    }

    // Check if this checklist already exists
    const existing = await checklistStorageService.findByContent(data)
    if (existing) {
      return res.json({
        success: true,
        message: 'Checklist already stored',
        alreadyExists: true,
        checklist: existing
      })
    }

    const result = await checklistStorageService.save(originalName, data, structuredData, label)

    res.json({
      success: true,
      message: 'Checklist stored successfully',
      alreadyExists: false,
      checklist: result
    })
  } catch (error) {
    console.error('❌ Error saving checklist:', error)
    res.status(500).json({ error: 'Failed to save checklist', message: error.message })
  }
})

/**
 * PUT /api/stored-checklists/:id/rename
 * Rename a stored checklist
 * Body: { displayName }
 */
router.put('/:id/rename', async (req, res) => {
  try {
    const { displayName } = req.body
    if (!displayName) {
      return res.status(400).json({ error: 'displayName is required' })
    }

    const result = await checklistStorageService.rename(req.params.id, displayName)
    if (!result) {
      return res.status(404).json({ error: 'Checklist not found' })
    }

    res.json({ success: true, checklist: result })
  } catch (error) {
    console.error('❌ Error renaming checklist:', error)
    res.status(500).json({ error: 'Failed to rename checklist', message: error.message })
  }
})

/**
 * DELETE /api/stored-checklists/:id
 * Delete a stored checklist
 */
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await checklistStorageService.delete(req.params.id)
    if (!deleted) {
      return res.status(404).json({ error: 'Checklist not found' })
    }

    res.json({ success: true, message: 'Checklist deleted' })
  } catch (error) {
    console.error('❌ Error deleting checklist:', error)
    res.status(500).json({ error: 'Failed to delete checklist', message: error.message })
  }
})

export default router
