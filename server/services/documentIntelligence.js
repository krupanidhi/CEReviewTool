import { DocumentAnalysisClient, AzureKeyCredential } from '@azure/ai-form-recognizer'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const endpoint = process.env.VITE_AZURE_DOC_ENDPOINT
const key = process.env.VITE_AZURE_DOC_KEY

if (!endpoint || !key) {
  throw new Error('Azure Document Intelligence credentials not configured')
}

const client = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key))

/**
 * Analyze document using Azure Document Intelligence
 * @param {Buffer} fileBuffer - Document file buffer
 * @param {string} contentType - MIME type of the document
 * @returns {Promise<Object>} Extracted document data as JSON
 */
export async function analyzeDocument(fileBuffer, contentType) {
  try {
    console.log('📄 Starting document analysis...')
    
    // Use prebuilt-document model for general document analysis
    const poller = await client.beginAnalyzeDocument('prebuilt-document', fileBuffer, {
      contentType: contentType
    })
    
    console.log('⏳ Waiting for analysis to complete...')
    const result = await poller.pollUntilDone()
    
    console.log('✅ Document analysis complete')
    
    // Extract structured data
    const extractedData = {
      content: result.content,
      pages: result.pages?.map(page => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        unit: page.unit,
        lines: page.lines?.map(line => ({
          content: line.content,
          boundingBox: line.boundingBox,
          spans: line.spans
        }))
      })),
      tables: result.tables?.map(table => ({
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        cells: table.cells?.map(cell => ({
          content: cell.content,
          rowIndex: cell.rowIndex,
          columnIndex: cell.columnIndex,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan
        }))
      })),
      keyValuePairs: result.keyValuePairs?.map(kvp => ({
        key: kvp.key?.content,
        value: kvp.value?.content,
        confidence: kvp.confidence
      })),
      paragraphs: result.paragraphs?.map(para => ({
        content: para.content,
        role: para.role,
        boundingRegions: para.boundingRegions
      })),
      styles: result.styles?.map(style => ({
        isHandwritten: style.isHandwritten,
        confidence: style.confidence,
        spans: style.spans
      }))
    }
    
    return {
      success: true,
      data: extractedData,
      metadata: {
        modelId: result.modelId,
        apiVersion: result.apiVersion,
        analyzedAt: new Date().toISOString()
      }
    }
  } catch (error) {
    console.error('❌ Document analysis error:', error)
    throw new Error(`Document analysis failed: ${error.message}`)
  }
}

/**
 * Analyze document with custom model (for fine-tuned scenarios)
 * @param {Buffer} fileBuffer - Document file buffer
 * @param {string} modelId - Custom model ID
 * @returns {Promise<Object>} Extracted document data
 */
export async function analyzeWithCustomModel(fileBuffer, modelId) {
  try {
    console.log(`📄 Analyzing with custom model: ${modelId}`)
    
    const poller = await client.beginAnalyzeDocument(modelId, fileBuffer)
    const result = await poller.pollUntilDone()
    
    return {
      success: true,
      data: result,
      metadata: {
        modelId: result.modelId,
        analyzedAt: new Date().toISOString()
      }
    }
  } catch (error) {
    console.error('❌ Custom model analysis error:', error)
    throw new Error(`Custom model analysis failed: ${error.message}`)
  }
}
