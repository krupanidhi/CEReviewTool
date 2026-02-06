import express from 'express'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

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
