import express from 'express'
import { loadSAATData, buildSAATSummary, deriveFiscalYear } from '../services/saatService.js'

const router = express.Router()

/**
 * GET /api/saat/data
 * Load SAAT data for a given fiscal year and announcement number.
 * Query params:
 *   - fiscalYear: e.g., "FY26" (optional if fundingOpp is provided)
 *   - fundingOpp: e.g., "HRSA-26-004" (used to derive fiscal year and filter data)
 */
router.get('/data', async (req, res) => {
  try {
    let { fiscalYear, fundingOpp } = req.query

    // Derive fiscal year from funding opportunity number if not explicitly provided
    if (!fiscalYear && fundingOpp) {
      fiscalYear = deriveFiscalYear(fundingOpp)
    }

    if (!fiscalYear) {
      return res.status(400).json({
        error: 'fiscalYear or fundingOpp is required',
        example: '/api/saat/data?fundingOpp=HRSA-26-004'
      })
    }

    const saatData = await loadSAATData(fiscalYear, fundingOpp)

    res.json({
      success: true,
      ...saatData,
      summary: saatData.found ? buildSAATSummary(saatData) : null
    })
  } catch (error) {
    console.error('❌ SAAT data error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/saat/fiscal-year
 * Derive fiscal year from a Funding Opportunity Number.
 * Query params:
 *   - fundingOpp: e.g., "HRSA-26-004"
 */
router.get('/fiscal-year', (req, res) => {
  const { fundingOpp } = req.query
  if (!fundingOpp) {
    return res.status(400).json({ error: 'fundingOpp query param is required' })
  }

  const fiscalYear = deriveFiscalYear(fundingOpp)
  if (!fiscalYear) {
    return res.status(400).json({ error: `Cannot derive fiscal year from: ${fundingOpp}` })
  }

  res.json({ success: true, fundingOpp, fiscalYear })
})

export default router
