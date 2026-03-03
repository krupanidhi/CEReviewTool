import express from 'express'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'
import storage from '../services/storageService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = express.Router()

/**
 * GET /api/documents
 * List all processed documents
 */
router.get('/', async (req, res) => {
  try {
    const metadataFiles = await storage.listFiles('documents', '', { extension: '.json' })
    
    const documents = await Promise.all(
      metadataFiles.map(async (file) => {
        try {
          const metadata = await storage.readJSON('documents', file.relativePath)
          return {
            id: metadata.id,
            originalName: metadata.originalName,
            fileName: metadata.fileName,
            size: metadata.size,
            mimeType: metadata.mimeType,
            uploadedAt: metadata.uploadedAt,
            hasAnalysis: !!metadata.analysis
          }
        } catch (error) {
          console.error(`Error reading metadata file ${file.relativePath}:`, error)
          return null
        }
      })
    )
    
    // Filter out any null entries and sort by upload date
    const validDocuments = documents
      .filter(d => d !== null)
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    
    res.json({
      success: true,
      count: validDocuments.length,
      documents: validDocuments
    })
  } catch (error) {
    console.error('❌ Error listing documents:', error)
    res.status(500).json({
      error: 'Failed to list documents',
      message: error.message
    })
  }
})

/**
 * GET /api/documents/:id
 * Get specific document details including analysis
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const metadataPath = await findMetadataPath(id)
    if (!metadataPath) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    const metadata = await storage.readJSON('documents', metadataPath)
    
    res.json({
      success: true,
      document: metadata
    })
  } catch (error) {
    console.error('❌ Error retrieving document:', error)
    res.status(500).json({
      error: 'Failed to retrieve document',
      message: error.message
    })
  }
})

/**
 * GET /api/documents/:id/file
 * Serve the original uploaded file (PDF, etc.) for viewing
 */
router.get('/:id/file', async (req, res) => {
  try {
    const { id } = req.params
    const metadataPath = await findMetadataPath(id)
    if (!metadataPath) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    const metadata = await storage.readJSON('documents', metadataPath)
    
    if (!metadata.fileName) {
      return res.status(404).json({ error: 'Original file not found' })
    }

    // Stream from storage (blob or local, with automatic fallback)
    const served = await storage.streamToResponse('documents', metadata.fileName, res, {
      contentType: metadata.mimeType || 'application/pdf',
      fileName: metadata.originalName
    })

    if (!served) {
      return res.status(404).json({ error: 'Original file not found. The PDF may not be deployed to this server.' })
    }
  } catch (error) {
    console.error('❌ Error serving document file:', error)
    res.status(500).json({
      error: 'Failed to serve document file',
      message: error.message
    })
  }
})

/**
 * GET /api/documents/:id/structured
 * Download structured JSON (clean key/value pair format) for a document
 */
router.get('/:id/structured', async (req, res) => {
  try {
    const { id } = req.params
    const metadataPath = await findMetadataPath(id)
    if (!metadataPath) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    const metadata = await storage.readJSON('documents', metadataPath)
    
    // Try to read pre-generated structured file from extractions
    if (metadata.structuredRelPath) {
      try {
        const structuredData = await storage.readJSON('extractions', metadata.structuredRelPath)
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
        return res.json(structuredData)
      } catch (fileErr) {
        console.log('Structured file not found in storage, trying legacy path...')
      }
    }

    // Legacy: try absolute structuredFilePath from old metadata
    if (metadata.structuredFilePath) {
      try {
        const structuredContent = await fs.readFile(metadata.structuredFilePath, 'utf-8')
        const structuredData = JSON.parse(structuredContent)
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
        return res.json(structuredData)
      } catch (fileErr) {
        console.log('Structured file not found at legacy path, generating on-the-fly...')
      }
    }
    
    // Fallback: generate on-the-fly from raw extraction
    if (metadata.extractionRelPath) {
      try {
        const rawData = await storage.readJSON('extractions', metadata.extractionRelPath)
        const structuredData = transformToStructured(rawData)
        
        // Save for future use
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const sanitizedName = metadata.originalName.replace(/[^a-zA-Z0-9.-]/g, '_')
        const structuredRelPath = `${timestamp}_${sanitizedName}_structured.json`
        await storage.saveJSON('extractions', structuredRelPath, structuredData)
        
        // Update metadata
        metadata.structuredRelPath = structuredRelPath
        await storage.saveJSON('documents', metadataPath, metadata)
        
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
        return res.json(structuredData)
      } catch (genErr) {
        console.error('Failed to generate structured data:', genErr)
      }
    }

    // Legacy: try absolute extractionFilePath
    if (metadata.extractionFilePath) {
      try {
        const rawContent = await fs.readFile(metadata.extractionFilePath, 'utf-8')
        const rawData = JSON.parse(rawContent)
        const structuredData = transformToStructured(rawData)
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
        return res.json(structuredData)
      } catch { /* ignore */ }
    }
    
    // Last fallback: transform from analysis data in metadata
    if (metadata.analysis?.data) {
      const structuredData = transformToStructured(metadata.analysis.data)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
      return res.json(structuredData)
    }
    
    return res.status(404).json({ error: 'No extraction data available for this document' })
  } catch (error) {
    console.error('❌ Error generating structured JSON:', error)
    res.status(500).json({
      error: 'Failed to generate structured JSON',
      message: error.message
    })
  }
})

/**
 * DELETE /api/documents/:id
 * Delete a document and its metadata
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const allFiles = await storage.listFiles('documents', '', {})
    const documentFiles = allFiles.filter(f => f.name.startsWith(id))
    
    if (documentFiles.length === 0) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    // Delete all related files
    await Promise.all(
      documentFiles.map(f => storage.deleteFile('documents', f.relativePath))
    )
    
    res.json({
      success: true,
      message: 'Document deleted successfully',
      filesDeleted: documentFiles.length
    })
  } catch (error) {
    console.error('❌ Error deleting document:', error)
    res.status(500).json({
      error: 'Failed to delete document',
      message: error.message
    })
  }
})

/**
 * Find the metadata JSON path for a given document ID.
 * Searches storage for a file starting with the ID and ending with .json.
 */
async function findMetadataPath(id) {
  const allFiles = await storage.listFiles('documents', '', { extension: '.json' })
  const match = allFiles.find(f => f.name.startsWith(id) && f.name.endsWith('.json'))
  return match ? match.relativePath : null
}

export default router
