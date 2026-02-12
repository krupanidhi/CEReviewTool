import express from 'express'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { analyzeDocumentEnhanced } from '../services/enhancedDocumentIntelligence.js'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'
import cacheService from '../services/cacheService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const router = express.Router()

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = join(__dirname, '../../documents')
    try {
      await fs.mkdir(uploadDir, { recursive: true })
      cb(null, uploadDir)
    } catch (error) {
      cb(error)
    }
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`
    cb(null, uniqueName)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept common document formats
    const allowedMimes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/tiff',
      'image/bmp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ]
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`))
    }
  }
})

/**
 * POST /api/upload
 * Upload and analyze a document
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    console.log(`📤 File uploaded: ${req.file.originalname}`)

    // Read file buffer for analysis
    const fileBuffer = await fs.readFile(req.file.path)

    // Analyze document with Enhanced Azure Document Intelligence
    const analysisResult = await analyzeDocumentEnhanced(fileBuffer, req.file.mimetype)

    const documentId = req.file.filename.split('-')[0]
    
    // Save extracted JSON data to dedicated extractions directory for reference
    const extractionsDir = join(__dirname, '../../extractions')
    await fs.mkdir(extractionsDir, { recursive: true })
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const sanitizedName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')
    const extractionFileName = `${timestamp}_${sanitizedName}_extraction.json`
    const extractionPath = join(extractionsDir, extractionFileName)
    
    // Save complete extraction data
    await fs.writeFile(extractionPath, JSON.stringify(analysisResult.data, null, 2))
    console.log(`💾 Extraction saved to: ${extractionPath}`)

    // Generate and save structured JSON (clean key/value pair format)
    const structuredData = transformToStructured(analysisResult.data)
    const structuredFileName = `${timestamp}_${sanitizedName}_structured.json`
    const structuredPath = join(extractionsDir, structuredFileName)
    await fs.writeFile(structuredPath, JSON.stringify(structuredData, null, 2))
    console.log(`📋 Structured JSON saved to: ${structuredPath}`)

    // Cache key-value pairs for internal reference
    if (analysisResult.data.keyValuePairs && analysisResult.data.keyValuePairs.length > 0) {
      await cacheService.cacheKeyValuePairs(
        documentId,
        req.file.originalname,
        analysisResult.data.keyValuePairs
      )
    }

    // Save metadata
    const metadata = {
      id: documentId,
      originalName: req.file.originalname,
      fileName: req.file.filename,
      filePath: req.file.path,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      extractionFilePath: extractionPath, // Reference to saved extraction JSON
      structuredFilePath: structuredPath, // Reference to structured JSON
      analysis: analysisResult
    }

    const metadataPath = req.file.path + '.json'
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2))

    console.log(`✅ Document processed: ${req.file.originalname}`)

    res.json({
      success: true,
      message: 'Document uploaded and analyzed successfully',
      id: metadata.id,
      originalName: metadata.originalName,
      fileName: metadata.fileName,
      size: metadata.size,
      uploadedAt: metadata.uploadedAt,
      analysis: analysisResult,
      data: analysisResult.data,
      structuredData: structuredData
    })
  } catch (error) {
    console.error('❌ Upload error:', error)
    
    // Clean up file if it was uploaded
    if (req.file?.path) {
      try {
        await fs.unlink(req.file.path)
      } catch (unlinkError) {
        console.error('Failed to clean up file:', unlinkError)
      }
    }

    res.status(500).json({
      error: 'Failed to process document',
      message: error.message
    })
  }
})

export default router
