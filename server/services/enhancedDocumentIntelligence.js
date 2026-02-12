import { DocumentAnalysisClient, AzureKeyCredential } from '@azure/ai-form-recognizer'
import { OpenAIClient, AzureKeyCredential as OpenAIKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const docEndpoint = process.env.VITE_AZURE_DOC_ENDPOINT
const docKey = process.env.VITE_AZURE_DOC_KEY
const openaiEndpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const openaiKey = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

const docClient = new DocumentAnalysisClient(docEndpoint, new AzureKeyCredential(docKey))
const openaiClient = new OpenAIClient(openaiEndpoint, new OpenAIKeyCredential(openaiKey))

/**
 * Convert table cells to structured JSON format
 * Transforms flat cell array into array of row objects with column headers as keys
 */
function convertTableToJSON(cells, rowCount, columnCount) {
  if (!cells || cells.length === 0) return []
  
  // Build a 2D grid from cells
  const grid = Array(rowCount).fill(null).map(() => Array(columnCount).fill(''))
  
  cells.forEach(cell => {
    if (cell.rowIndex < rowCount && cell.columnIndex < columnCount) {
      grid[cell.rowIndex][cell.columnIndex] = cell.content || ''
    }
  })
  
  // First row is typically headers
  const headers = grid[0] || []
  
  // If no headers or all empty, use generic column names
  const columnHeaders = headers.every(h => !h || h.trim() === '') 
    ? Array(columnCount).fill(null).map((_, i) => `Column_${i + 1}`)
    : headers.map((h, i) => h.trim() || `Column_${i + 1}`)
  
  // Convert remaining rows to objects
  const structuredRows = []
  for (let i = 1; i < rowCount; i++) {
    const row = grid[i]
    const rowObj = {}
    
    // Skip completely empty rows
    if (row.every(cell => !cell || cell.trim() === '')) continue
    
    columnHeaders.forEach((header, colIdx) => {
      rowObj[header] = row[colIdx] || ''
    })
    
    structuredRows.push(rowObj)
  }
  
  return structuredRows
}

/**
 * Enhanced document analysis with TOC extraction and page-based organization
 */
export async function analyzeDocumentEnhanced(fileBuffer, mimeType) {
  try {
    console.log('📄 Starting enhanced document analysis...')

    const poller = await docClient.beginAnalyzeDocument('prebuilt-layout', fileBuffer)
    const result = await poller.pollUntilDone()

    const extractedData = {
      content: result.content,
      pages: [],
      tableOfContents: [],
      sections: [],
      keyValuePairs: [],
      tables: [],
      figures: [], // Add figures/images extraction
      metadata: {
        pageCount: result.pages?.length || 0,
        analyzedAt: new Date().toISOString(),
        extractionQuality: 'production' // Mark as production-ready
      }
    }

    // Extract pages with detailed content
    if (result.pages) {
      extractedData.pages = result.pages.map((page, idx) => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        unit: page.unit,
        angle: page.angle,
        lines: page.lines?.map(line => ({
          content: line.content,
          boundingBox: line.polygon,
          spans: line.spans
        })) || [],
        words: page.words?.map(word => ({
          content: word.content,
          boundingBox: word.polygon,
          confidence: word.confidence
        })) || [],
        selectionMarks: page.selectionMarks?.map(mark => ({
          state: mark.state,
          boundingBox: mark.polygon,
          confidence: mark.confidence
        })) || []
      }))
    }

    // Extract paragraphs and organize into sections
    if (result.paragraphs) {
      const paragraphs = result.paragraphs.map(para => ({
        content: para.content,
        role: para.role,
        boundingRegions: para.boundingRegions?.map(region => ({
          pageNumber: region.pageNumber,
          polygon: region.polygon
        })) || [],
        spans: para.spans
      }))

      // Extract TOC by searching early pages for top-level section titles
      // Fully dynamic — detects any numbered section (1., 2., 3., 4., 5., etc.)
      const sectionMap = new Map()
      
      // Search pages 2-10 for TOC content (some documents have longer front matter)
      const maxTocPage = Math.min(10, extractedData.pages.length)
      for (let pageNum = 2; pageNum <= maxTocPage; pageNum++) {
        const tocPage = extractedData.pages.find(p => p.pageNumber === pageNum)
        if (!tocPage) continue
        
        const lines = tocPage.lines || []
        let i = 0
        
        while (i < lines.length) {
          const text = lines[i].content || ''
          
          // Look for lines starting with any single number followed by dot and space
          // e.g., "1. Introduction", "4. Submission and Review"
          const match = text.match(/^(\d+)\.\s+(.+)$/)
          if (match && !/\d+\.\d+/.test(text)) {
            const sectionNum = match[1]
            
            // Skip if we already have this section
            if (sectionMap.has(sectionNum)) {
              i++
              continue
            }
            
            let fullTitle = text
            
            // Collect continuation lines
            let j = i + 1
            while (j < lines.length && j < i + 5) {
              const nextLine = lines[j].content || ''
              
              // Stop conditions
              if (/^\d+\.\s/.test(nextLine)) break // Next numbered section
              if (/^\d+$/.test(nextLine)) break // Page number
              if (/^\.{3,}/.test(nextLine)) break // Dots
              if (nextLine.trim().length < 3) break // Empty/short line
              if (/^(page|figure|table)/i.test(nextLine)) break // Common non-title words
              
              fullTitle += ' ' + nextLine.trim()
              j++
            }
            
            // Clean up title and validate
            fullTitle = fullTitle.replace(/\s+/g, ' ').trim()
            
            if (fullTitle.length >= 10 && fullTitle.length <= 200) {
              sectionMap.set(sectionNum, {
                id: `section_${sectionNum}`,
                title: fullTitle,
                pageNumber: pageNum,
                level: 1
              })
            }
            
            i = j
          } else {
            i++
          }
        }
        
        // Continue searching all early pages — don't break early
      }
      
      // Convert map to sorted array by section number (numerically)
      const sortedTOC = [...sectionMap.keys()]
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(num => sectionMap.get(num))
      
      console.log(`📑 TOC extracted: ${sortedTOC.length} main sections`)
      sortedTOC.forEach((t, idx) => {
        console.log(`  ${idx + 1}. ${t.title}`)
      })
      
      extractedData.tableOfContents = sortedTOC

      // Organize content by sections
      // Enhanced: Also detect numbered subsections (3.1, 3.1.1, 3.1.1.1, etc.) even if not marked as title/sectionHeading
      let currentSection = null
      let numberedSectionsDetected = []
      
      paragraphs.forEach(para => {
        const isRoleBasedSection = para.role === 'title' || para.role === 'sectionHeading'
        
        // Check if this paragraph is a numbered subsection (e.g., 3., 3.1, 3.1.1, 3.1.1.1, 3.2.2, 3.4.3, 3.5)
        // Pattern: starts with digit(s), followed by dot, optionally followed by more digit-dot pairs, then space and text
        const numberedSectionMatch = para.content?.match(/^(\d+(\.\d+)*\.?)\s+(.+)/)
        const isNumberedSection = numberedSectionMatch && para.content.length < 250 // Likely a heading, not body text
        
        if (isNumberedSection && !isRoleBasedSection) {
          numberedSectionsDetected.push({
            number: numberedSectionMatch[1],
            title: para.content,
            length: para.content.length,
            page: para.boundingRegions[0]?.pageNumber
          })
        }
        
        if (isRoleBasedSection || isNumberedSection) {
          if (currentSection) {
            extractedData.sections.push(currentSection)
          }
          // Classify section type based on hierarchy and content
          const sectionMatch = para.content?.match(/^(\d+(?:\.\d+)*)/)
          const sectionNumber = sectionMatch ? sectionMatch[1] : ''
          const depth = sectionNumber.split('.').filter(p => p).length
          
          // Determine section type for intelligent validation
          let sectionType = 'requirement' // default
          if (depth === 1) {
            sectionType = 'organizational_header' // e.g., "3."
          } else if (depth === 2) {
            sectionType = 'category_header' // e.g., "3.1"
          } else if (depth >= 3) {
            sectionType = 'requirement' // e.g., "3.1.1", "3.1.1.1"
          }
          
          currentSection = {
            title: para.content,
            pageNumber: para.boundingRegions[0]?.pageNumber || 1,
            content: [],
            role: para.role || 'numberedSection',
            sectionNumber: sectionNumber,
            sectionType: sectionType,
            depth: depth
          }
        } else if (currentSection) {
          currentSection.content.push({
            text: para.content,
            pageNumber: para.boundingRegions[0]?.pageNumber || currentSection.pageNumber
          })
        }
      })
      if (currentSection) {
        extractedData.sections.push(currentSection)
      }
      
      console.log(`🔢 Numbered sections detected (not role-based): ${numberedSectionsDetected.length}`)
      if (numberedSectionsDetected.length > 0) {
        console.log('📋 Numbered sections found:')
        numberedSectionsDetected.slice(0, 30).forEach((s, idx) => {
          console.log(`  ${idx + 1}. [${s.number}] ${s.title.substring(0, 80)} (page ${s.page}, len ${s.length})`)
        })
      }
      
      console.log(`📊 Total sections extracted: ${extractedData.sections.length}`)
      
      // Count section types for intelligent validation
      const typeCount = {
        organizational_header: 0,
        category_header: 0,
        requirement: 0
      }
      extractedData.sections.forEach(s => {
        if (s.sectionType) typeCount[s.sectionType]++
      })
      console.log(`📊 Section classification:`)
      console.log(`   - Organizational headers: ${typeCount.organizational_header}`)
      console.log(`   - Category headers: ${typeCount.category_header}`)
      console.log(`   - Actionable requirements: ${typeCount.requirement}`)
      
      if (extractedData.sections.length > 0) {
        console.log('📋 First 30 section titles (with type):')
        extractedData.sections.slice(0, 30).forEach((s, idx) => {
          const typeLabel = s.sectionType === 'organizational_header' ? '[ORG]' 
                          : s.sectionType === 'category_header' ? '[CAT]' 
                          : '[REQ]'
          console.log(`  ${idx + 1}. ${typeLabel} ${s.title}`)
        })
      }
    }

    // Extract key-value pairs
    console.log(`🔍 Azure returned keyValuePairs property: ${result.keyValuePairs ? 'YES' : 'NO'}`)
    if (result.keyValuePairs) {
      console.log(`   Raw keyValuePairs count: ${result.keyValuePairs.length}`)
      extractedData.keyValuePairs = result.keyValuePairs
        .filter(kvp => kvp.key && kvp.value)
        .map(kvp => ({
          key: kvp.key.content,
          value: kvp.value.content,
          confidence: kvp.confidence,
          pageNumber: kvp.key.boundingRegions?.[0]?.pageNumber || 1
        }))
      console.log(`   Filtered keyValuePairs count: ${extractedData.keyValuePairs.length}`)
    } else {
      console.log(`   ⚠️  prebuilt-layout model does not extract key-value pairs for this document`)
    }

    // Extract tables with page references and convert to structured JSON
    if (result.tables) {
      extractedData.tables = result.tables.map((table, idx) => {
        const rawCells = table.cells.map(cell => ({
          rowIndex: cell.rowIndex,
          columnIndex: cell.columnIndex,
          content: cell.content,
          kind: cell.kind,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan
        }))
        
        // Convert table cells to structured JSON (array of row objects)
        const structuredData = convertTableToJSON(rawCells, table.rowCount, table.columnCount)
        
        return {
          id: `table_${idx}`,
          rowCount: table.rowCount,
          columnCount: table.columnCount,
          pageNumber: table.boundingRegions?.[0]?.pageNumber || 1,
          cells: rawCells, // Keep raw cells for reference
          structuredData: structuredData // Add structured JSON representation
        }
      })
      
      console.log(`📊 Extracted ${extractedData.tables.length} tables with structured data`)
      
      // Production logging: Show table details for verification
      extractedData.tables.forEach((table, idx) => {
        console.log(`\n  Table ${idx + 1}:`)
        console.log(`    - Page: ${table.pageNumber}`)
        console.log(`    - Dimensions: ${table.rowCount} rows × ${table.columnCount} columns`)
        console.log(`    - Structured rows: ${table.structuredData.length}`)
        
        // DEBUG: Show raw cell grid for first 3 tables to diagnose extraction issues
        if (idx < 3) {
          console.log(`    - Raw cell grid (first 5 rows):`)
          const grid = Array(table.rowCount).fill(null).map(() => Array(table.columnCount).fill(''))
          table.cells.forEach(cell => {
            if (cell.rowIndex < table.rowCount && cell.columnIndex < table.columnCount) {
              grid[cell.rowIndex][cell.columnIndex] = cell.content || ''
            }
          })
          for (let r = 0; r < Math.min(5, table.rowCount); r++) {
            console.log(`      Row ${r}:`, grid[r].map(c => c.substring(0, 30)))
          }
        }
        
        if (table.structuredData.length > 0) {
          console.log(`    - Sample data:`, JSON.stringify(table.structuredData[0], null, 2).substring(0, 300))
        }
      })
    }

    // Extract figures/images (screenshots, diagrams, etc.)
    console.log(`🔍 Azure returned figures property: ${result.figures ? 'YES' : 'NO'}`)
    if (result.figures) {
      console.log(`   Raw figures count: ${result.figures.length}`)
      extractedData.figures = result.figures.map((figure, idx) => ({
        id: `figure_${idx}`,
        pageNumber: figure.boundingRegions?.[0]?.pageNumber || 1,
        caption: figure.caption?.content || '',
        boundingBox: figure.boundingRegions?.[0]?.polygon || [],
        elements: figure.elements || [],
        confidence: figure.confidence || 0
      }))
      
      console.log(`🖼️  Extracted ${extractedData.figures.length} figures/images`)
      if (extractedData.figures.length > 0) {
        console.log(`📋 Figure details:`, extractedData.figures.map(f => ({
          id: f.id,
          page: f.pageNumber,
          caption: f.caption.substring(0, 50)
        })))
      }
    } else {
      console.log(`   ⚠️  prebuilt-layout model does not extract figures for this document`)
      console.log(`   💡 Note: Figures are detected as separate visual elements, not embedded images`)
    }

    // Production-ready logging with comprehensive metrics
    console.log('\n📊 ===== DOCUMENT EXTRACTION SUMMARY =====')
    console.log(`✅ Enhanced analysis complete: ${extractedData.pages.length} pages`)
    console.log(`📑 Sections extracted: ${extractedData.sections.length}`)
    console.log(`📋 TOC entries: ${extractedData.tableOfContents.length}`)
    console.log(`📊 Tables extracted: ${extractedData.tables.length}`)
    console.log(`🖼️  Figures/Images: ${extractedData.figures.length}`)
    console.log(`🔑 Key-Value pairs: ${extractedData.keyValuePairs.length}`)
    console.log(`📄 Total content length: ${extractedData.content?.length || 0} chars`)
    console.log('===== EXTRACTION COMPLETE =====\n')

    return {
      success: true,
      data: extractedData,
      metadata: {
        modelId: 'prebuilt-layout',
        analyzedAt: new Date().toISOString(),
        pageCount: extractedData.pages.length,
        sectionCount: extractedData.sections.length,
        tocEntries: extractedData.tableOfContents.length
      }
    }
  } catch (error) {
    // Production-ready error handling with detailed logging
    console.error('\n❌ ===== DOCUMENT ANALYSIS ERROR =====')
    console.error('Error type:', error.name)
    console.error('Error message:', error.message)
    console.error('Error stack:', error.stack)
    console.error('===== ERROR END =====\n')
    
    // Return structured error response
    return {
      success: false,
      error: {
        type: error.name,
        message: error.message,
        details: error.stack
      },
      data: null,
      metadata: {
        analyzedAt: new Date().toISOString(),
        failed: true
      }
    }
  }
}

/**
 * Generate table of contents using AI when not detected
 */
async function generateTOCWithAI(content, pages) {
  try {
    const prompt = `Analyze this document and extract the table of contents. Identify all main sections and subsections with their page numbers.

Document content (first 5000 chars):
${content.substring(0, 5000)}

Return a JSON array with this structure:
[
  {
    "id": "section_1",
    "title": "Section Title",
    "pageNumber": 1,
    "level": 1
  }
]

Only return valid JSON, no other text.`

    const messages = [
      { role: 'system', content: 'You are a document analysis expert. Extract table of contents accurately.' },
      { role: 'user', content: prompt }
    ]

    const result = await openaiClient.getChatCompletions(deployment, messages, {
      maxTokens: 1000,
      temperature: 0.1,
      responseFormat: { type: 'json_object' }
    })

    const response = result.choices[0]?.message?.content
    const parsed = JSON.parse(response)
    
    return Array.isArray(parsed) ? parsed : (parsed.toc || parsed.sections || [])
  } catch (error) {
    console.error('AI TOC generation error:', error)
    return []
  }
}

/**
 * Extract specific section content by title or page range
 */
export function extractSection(documentData, sectionTitle = null, pageRange = null) {
  if (!documentData) return null

  if (sectionTitle) {
    const section = documentData.sections?.find(s => 
      s.title.toLowerCase().includes(sectionTitle.toLowerCase())
    )
    return section
  }

  if (pageRange) {
    const [startPage, endPage] = pageRange
    const pages = documentData.pages?.filter(p => 
      p.pageNumber >= startPage && p.pageNumber <= endPage
    )
    return {
      title: `Pages ${startPage}-${endPage}`,
      pageNumber: startPage,
      content: pages?.flatMap(p => p.lines?.map(l => ({ text: l.content, pageNumber: p.pageNumber }))) || []
    }
  }

  return null
}

export default { analyzeDocumentEnhanced, extractSection }
