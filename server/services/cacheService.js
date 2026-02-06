import fs from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

class CacheService {
  constructor() {
    this.analysisCache = new Map()
    this.kvCache = new Map()
    this.settings = {
      enableCache: true,
      multipleApplications: false,
      multipleChecklists: true,
      maxCacheSize: 100,
      cacheLocation: './cache'
    }
    this.initialized = false
    this.cacheDir = null
    this.analysisCacheFile = null
    this.kvCacheFile = null
    this.settingsFile = null
  }

  getCachePaths() {
    const baseDir = this.settings.cacheLocation.startsWith('.') 
      ? join(__dirname, '../../', this.settings.cacheLocation)
      : this.settings.cacheLocation
    
    return {
      cacheDir: baseDir,
      analysisCacheFile: join(baseDir, 'analysis_cache.json'),
      kvCacheFile: join(baseDir, 'kv_cache.json'),
      settingsFile: join(baseDir, 'settings.json')
    }
  }

  async initialize() {
    if (this.initialized) return

    try {
      const paths = this.getCachePaths()
      await fs.mkdir(paths.cacheDir, { recursive: true })
      await this.loadFromDisk()
      this.initialized = true
      console.log(`✅ Cache service initialized at: ${paths.cacheDir}`)
    } catch (error) {
      console.error('❌ Cache initialization error:', error)
    }
  }

  async loadFromDisk() {
    const paths = this.getCachePaths()
    
    try {
      const analysisData = await fs.readFile(paths.analysisCacheFile, 'utf-8')
      const analysisEntries = JSON.parse(analysisData)
      this.analysisCache = new Map(analysisEntries)
    } catch (error) {
      this.analysisCache = new Map()
    }

    try {
      const kvData = await fs.readFile(paths.kvCacheFile, 'utf-8')
      const kvEntries = JSON.parse(kvData)
      this.kvCache = new Map(kvEntries)
    } catch (error) {
      this.kvCache = new Map()
    }

    try {
      const settingsData = await fs.readFile(paths.settingsFile, 'utf-8')
      this.settings = { ...this.settings, ...JSON.parse(settingsData) }
    } catch (error) {
      await this.saveSettings()
    }
  }

  async saveToDisk() {
    if (!this.settings.enableCache) return

    const paths = this.getCachePaths()
    
    try {
      await fs.mkdir(paths.cacheDir, { recursive: true })
      await fs.writeFile(
        paths.analysisCacheFile,
        JSON.stringify([...this.analysisCache.entries()], null, 2)
      )
      await fs.writeFile(
        paths.kvCacheFile,
        JSON.stringify([...this.kvCache.entries()], null, 2)
      )
    } catch (error) {
      console.error('❌ Cache save error:', error)
    }
  }

  async saveSettings() {
    const paths = this.getCachePaths()
    
    try {
      await fs.mkdir(paths.cacheDir, { recursive: true })
      await fs.writeFile(paths.settingsFile, JSON.stringify(this.settings, null, 2))
    } catch (error) {
      console.error('❌ Settings save error:', error)
    }
  }

  getSettings() {
    return { ...this.settings }
  }

  async updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings }
    await this.saveSettings()
    return this.settings
  }

  generateCacheKey(documentId, type = 'analysis') {
    return `${type}_${documentId}_${Date.now()}`
  }

  async cacheAnalysis(documentId, documentName, analysisData) {
    if (!this.settings.enableCache) return null

    const key = this.generateCacheKey(documentId, 'analysis')
    const entry = {
      documentId,
      documentName,
      analysisData,
      timestamp: new Date().toISOString(),
      type: 'analysis'
    }

    this.analysisCache.set(key, entry)

    if (this.analysisCache.size > this.settings.maxCacheSize) {
      const firstKey = this.analysisCache.keys().next().value
      this.analysisCache.delete(firstKey)
    }

    await this.saveToDisk()
    return key
  }

  async cacheKeyValuePairs(documentId, documentName, kvPairs) {
    if (!this.settings.enableCache) return null

    const key = this.generateCacheKey(documentId, 'kv')
    const entry = {
      documentId,
      documentName,
      kvPairs,
      timestamp: new Date().toISOString(),
      type: 'keyvalue'
    }

    this.kvCache.set(key, entry)

    if (this.kvCache.size > this.settings.maxCacheSize) {
      const firstKey = this.kvCache.keys().next().value
      this.kvCache.delete(firstKey)
    }

    await this.saveToDisk()
    return key
  }

  getAnalysisCache(documentId = null) {
    if (!documentId) {
      return Array.from(this.analysisCache.values())
    }

    return Array.from(this.analysisCache.values()).filter(
      entry => entry.documentId === documentId
    )
  }

  getKeyValueCache(documentId = null) {
    if (!documentId) {
      return Array.from(this.kvCache.values())
    }

    return Array.from(this.kvCache.values()).filter(
      entry => entry.documentId === documentId
    )
  }

  async clearCache(type = 'all') {
    if (type === 'all' || type === 'analysis') {
      this.analysisCache.clear()
    }
    if (type === 'all' || type === 'keyvalue') {
      this.kvCache.clear()
    }
    await this.saveToDisk()
    console.log(`✅ Cache cleared: ${type}`)
  }

  async deleteAnalysisEntry(key) {
    this.analysisCache.delete(key)
    await this.saveToDisk()
  }

  getCacheStats() {
    return {
      analysisCacheSize: this.analysisCache.size,
      kvCacheSize: this.kvCache.size,
      totalSize: this.analysisCache.size + this.kvCache.size,
      maxSize: this.settings.maxCacheSize,
      cacheEnabled: this.settings.enableCache
    }
  }
}

const cacheService = new CacheService()

export default cacheService
