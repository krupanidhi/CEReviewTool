import express from 'express'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = express.Router()

/**
 * GET /api/documents
 * List all processed documents
 */
router.get('/', async (req, res) => {
  try {
    const documentsDir = join(__dirname, '../../documents')
    
    // Ensure directory exists
    await fs.mkdir(documentsDir, { recursive: true })
    
    const files = await fs.readdir(documentsDir)
    
    // Filter for metadata files
    const metadataFiles = files.filter(f => f.endsWith('.json'))
    
    const documents = await Promise.all(
      metadataFiles.map(async (file) => {
        try {
          const content = await fs.readFile(join(documentsDir, file), 'utf-8')
          const metadata = JSON.parse(content)
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
          console.error(`Error reading metadata file ${file}:`, error)
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
    const documentsDir = join(__dirname, '../../documents')
    
    const files = await fs.readdir(documentsDir)
    const metadataFile = files.find(f => f.startsWith(id) && f.endsWith('.json'))
    
    if (!metadataFile) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    const content = await fs.readFile(join(documentsDir, metadataFile), 'utf-8')
    const metadata = JSON.parse(content)
    
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
    const documentsDir = join(__dirname, '../../documents')
    
    const files = await fs.readdir(documentsDir)
    const metadataFile = files.find(f => f.startsWith(id) && f.endsWith('.json'))
    
    if (!metadataFile) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    const content = await fs.readFile(join(documentsDir, metadataFile), 'utf-8')
    const metadata = JSON.parse(content)
    
    // Resolve the PDF file path:
    // 1. Try fileName in documents/ dir (works on any host, including Azure)
    // 2. Fall back to absolute filePath (only works on the original machine)
    let resolvedPath = null

    if (metadata.fileName) {
      const localPath = join(documentsDir, metadata.fileName)
      try {
        await fs.access(localPath)
        resolvedPath = localPath
      } catch { /* not found locally */ }
    }

    if (!resolvedPath && metadata.filePath) {
      try {
        await fs.access(metadata.filePath)
        resolvedPath = metadata.filePath
      } catch { /* absolute path not found either */ }
    }

    if (!resolvedPath) {
      return res.status(404).json({ error: 'Original file not found. The PDF may not be deployed to this server.' })
    }
    
    res.setHeader('Content-Type', metadata.mimeType || 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${metadata.originalName}"`)
    
    const fileBuffer = await fs.readFile(resolvedPath)
    res.send(fileBuffer)
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
    const documentsDir = join(__dirname, '../../documents')
    
    const files = await fs.readdir(documentsDir)
    const metadataFile = files.find(f => f.startsWith(id) && f.endsWith('.json'))
    
    if (!metadataFile) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    const content = await fs.readFile(join(documentsDir, metadataFile), 'utf-8')
    const metadata = JSON.parse(content)
    
    // Try to read pre-generated structured file
    if (metadata.structuredFilePath) {
      try {
        const structuredContent = await fs.readFile(metadata.structuredFilePath, 'utf-8')
        const structuredData = JSON.parse(structuredContent)
        
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
        return res.json(structuredData)
      } catch (fileErr) {
        console.log('Structured file not found, generating on-the-fly...')
      }
    }
    
    // Fallback: generate on-the-fly from raw extraction
    const extractionPath = metadata.extractionFilePath
    if (extractionPath) {
      try {
        const rawContent = await fs.readFile(extractionPath, 'utf-8')
        const rawData = JSON.parse(rawContent)
        const structuredData = transformToStructured(rawData)
        
        // Save for future use
        const extractionsDir = join(__dirname, '../../extractions')
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const sanitizedName = metadata.originalName.replace(/[^a-zA-Z0-9.-]/g, '_')
        const structuredPath = join(extractionsDir, `${timestamp}_${sanitizedName}_structured.json`)
        await fs.writeFile(structuredPath, JSON.stringify(structuredData, null, 2))
        
        // Update metadata with new path
        metadata.structuredFilePath = structuredPath
        await fs.writeFile(join(documentsDir, metadataFile), JSON.stringify(metadata, null, 2))
        
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Disposition', `attachment; filename="${metadata.originalName.replace(/\.[^.]+$/, '')}_structured.json"`)
        return res.json(structuredData)
      } catch (genErr) {
        console.error('Failed to generate structured data:', genErr)
      }
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
    const documentsDir = join(__dirname, '../../documents')
    
    const files = await fs.readdir(documentsDir)
    const documentFiles = files.filter(f => f.startsWith(id))
    
    if (documentFiles.length === 0) {
      return res.status(404).json({ error: 'Document not found' })
    }
    
    // Delete all related files
    await Promise.all(
      documentFiles.map(file => fs.unlink(join(documentsDir, file)))
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

export default router
