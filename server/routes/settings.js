import express from 'express'
import cacheService from '../services/cacheService.js'

const router = express.Router()

await cacheService.initialize()

/**
 * GET /api/settings
 * Get current settings
 */
router.get('/', async (req, res) => {
  try {
    const settings = cacheService.getSettings()
    const stats = cacheService.getCacheStats()
    
    res.json({
      success: true,
      settings,
      cacheStats: stats
    })
  } catch (error) {
    console.error('❌ Settings fetch error:', error)
    res.status(500).json({
      error: 'Failed to fetch settings',
      message: error.message
    })
  }
})

/**
 * PUT /api/settings
 * Update settings
 */
router.put('/', async (req, res) => {
  try {
    const updatedSettings = await cacheService.updateSettings(req.body)
    
    console.log('⚙️ Settings updated:', updatedSettings)
    
    res.json({
      success: true,
      settings: updatedSettings
    })
  } catch (error) {
    console.error('❌ Settings update error:', error)
    res.status(500).json({
      error: 'Failed to update settings',
      message: error.message
    })
  }
})

/**
 * GET /api/settings/cache
 * Get cache contents
 */
router.get('/cache', async (req, res) => {
  try {
    const { type, documentId } = req.query
    
    let cacheData = {}
    
    if (!type || type === 'analysis') {
      cacheData.analysis = cacheService.getAnalysisCache(documentId)
    }
    
    if (!type || type === 'keyvalue') {
      cacheData.keyvalue = cacheService.getKeyValueCache(documentId)
    }
    
    res.json({
      success: true,
      cache: cacheData,
      stats: cacheService.getCacheStats()
    })
  } catch (error) {
    console.error('❌ Cache fetch error:', error)
    res.status(500).json({
      error: 'Failed to fetch cache',
      message: error.message
    })
  }
})

/**
 * DELETE /api/settings/cache
 * Clear cache
 */
router.delete('/cache', async (req, res) => {
  try {
    const { type = 'all' } = req.query
    
    await cacheService.clearCache(type)
    
    console.log(`🗑️ Cache cleared: ${type}`)
    
    res.json({
      success: true,
      message: `Cache cleared: ${type}`,
      stats: cacheService.getCacheStats()
    })
  } catch (error) {
    console.error('❌ Cache clear error:', error)
    res.status(500).json({
      error: 'Failed to clear cache',
      message: error.message
    })
  }
})

/**
 * DELETE /api/settings/cache/:key
 * Delete specific cache entry
 */
router.delete('/cache/:key', async (req, res) => {
  try {
    const { key } = req.params
    
    await cacheService.deleteAnalysisEntry(key)
    
    console.log(`🗑️ Cache entry deleted: ${key}`)
    
    res.json({
      success: true,
      message: 'Cache entry deleted'
    })
  } catch (error) {
    console.error('❌ Cache delete error:', error)
    res.status(500).json({
      error: 'Failed to delete cache entry',
      message: error.message
    })
  }
})

export default router
