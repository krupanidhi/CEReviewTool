import express from 'express'
import { analyzeWithAI, validateWithChecklist } from '../services/openAI.js'

const router = express.Router()

/**
 * POST /api/analyze
 * Analyze document data with Azure OpenAI
 */
router.post('/', async (req, res) => {
  try {
    const { documentData, prompt, checklist } = req.body

    if (!documentData) {
      return res.status(400).json({ error: 'Document data is required' })
    }

    console.log('🤖 Starting AI analysis...')

    let result

    if (checklist && Array.isArray(checklist)) {
      // Use checklist validation if provided
      result = await validateWithChecklist(documentData, checklist)
    } else {
      // General AI analysis
      result = await analyzeWithAI(documentData, prompt)
    }

    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('❌ Analysis error:', error)
    res.status(500).json({
      error: 'Failed to analyze document',
      message: error.message
    })
  }
})

/**
 * POST /api/analyze/validate
 * Validate document against specific checklist
 */
router.post('/validate', async (req, res) => {
  try {
    const { documentData, checklist } = req.body

    if (!documentData) {
      return res.status(400).json({ error: 'Document data is required' })
    }

    if (!checklist || !Array.isArray(checklist)) {
      return res.status(400).json({ error: 'Valid checklist array is required' })
    }

    console.log(`✅ Validating against ${checklist.length} checklist items...`)

    const result = await validateWithChecklist(documentData, checklist)

    res.json({
      success: true,
      ...result
    })
  } catch (error) {
    console.error('❌ Validation error:', error)
    res.status(500).json({
      error: 'Failed to validate document',
      message: error.message
    })
  }
})

export default router
