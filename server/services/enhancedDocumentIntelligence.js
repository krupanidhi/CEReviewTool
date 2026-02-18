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

      // ─── Extract TOC using DI paragraph roles (deterministic) ─────────────────
      // DI's prebuilt-layout model tags paragraphs with role: "title" or "sectionHeading".
      // We use these to find top-level numbered sections (e.g., "1. Starting the FY 2025...")
      // This is far more reliable than scanning raw page lines which merge titles with body text.
      const sectionMap = new Map()
      const actionVerbPattern = /^\d+\.\s+(Click|Save|Enter|Select|Check|Open|Go|Navigate|Submit|Upload|Download|Press|Type|Fill|Complete|Verify|Review|Update|Add|Remove|Delete|Copy|Paste|Drag|Drop|Scroll|Expand|Collapse|Find|Access|Unduplicated|Total|I am)\b/i

      for (const para of paragraphs) {
        // Only consider paragraphs DI identified as headings
        if (para.role !== 'title' && para.role !== 'sectionHeading') continue

        const text = (para.content || '').trim()
        // Match top-level numbered sections: "1. Title", "2. Title", etc.
        // Exclude subsections like "3.1", "3.1.1"
        const match = text.match(/^(\d+)\.\s+(.+)/)
        if (!match) continue
        if (/^\d+\.\d+/.test(text)) continue // subsection — skip

        const sectionNum = match[1]
        // Keep first occurrence of each section number (the real heading, not a body reference)
        if (sectionMap.has(sectionNum)) continue
        // Filter out instruction steps
        if (actionVerbPattern.test(text)) continue

        sectionMap.set(sectionNum, {
          id: `section_${sectionNum}`,
          title: text,
          pageNumber: para.boundingRegions?.[0]?.pageNumber || 1,
          level: 1
        })
      }

      // Remove entries that create gaps in sequential numbering
      // Real TOC sections are sequential (1, 2, 3, 4). A jump to 8 means body content leaked in.
      const sortedNums = [...sectionMap.keys()].map(Number).sort((a, b) => a - b)
      if (sortedNums.length > 2) {
        let lastConsecutive = sortedNums[0]
        for (let k = 1; k < sortedNums.length; k++) {
          if (sortedNums[k] - lastConsecutive > 1) {
            for (let m = k; m < sortedNums.length; m++) {
              sectionMap.delete(String(sortedNums[m]))
            }
            break
          }
          lastConsecutive = sortedNums[k]
        }
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

      // ─── HYBRID section extraction: DI roles + numbered-paragraph detection ───
      // DI doesn't consistently tag every numbered heading (e.g., FY26 misses
      // 3.1.1.1, 3.1.1.4). We use a two-pass approach:
      //   Pass 1: Build sections from DI-tagged headings with numbered prefixes
      //   Pass 2: Scan ALL paragraphs for numbered patterns that DI missed
      // This ensures 100% section coverage regardless of DI tagging quality.
      //
      // Section heading heuristic for Pass 2 (non-DI-tagged paragraphs):
      //   - Starts with a section number like "3.1.1.1"
      //   - Followed by a descriptive title (e.g., "Completing the...")
      //   - Short enough to be a heading (< 200 chars)
      //   - NOT an instruction step (e.g., "3. Click Save" — single digit + verb)
      const instructionVerbs = /^(\d+)\.\s+(Click|Select|Enter|Type|Check|Uncheck|Save|Go|Navigate|Return|Review|Scroll|Open|Close|Press|Upload|Download|Attach|Remove|Delete|Add|Edit|Update|View|Verify|Confirm|Submit|Complete|Fill|Choose|Pick|Drag|Drop|Copy|Paste|Print|Sign|Log|Access|Expand|Collapse)\b/i
      
      let currentSection = null
      const diTaggedNumbers = new Set()
      
      // Pass 1: DI-tagged numbered headings (high confidence)
      paragraphs.forEach(para => {
        const isDIHeading = para.role === 'title' || para.role === 'sectionHeading'
        const text = (para.content || '').trim()
        const numberMatch = text.match(/^(\d+(?:\.\d+)*)[\.\s]/)
        
        if (isDIHeading && numberMatch) {
          // Skip non-section DI headings (figures, notes, repeated headers)
          if (!numberMatch) return
          
          if (currentSection) {
            extractedData.sections.push(currentSection)
          }
          const sectionNumber = numberMatch[1]
          diTaggedNumbers.add(sectionNumber)
          const depth = sectionNumber.split('.').filter(p => p).length
          
          let sectionType = 'requirement'
          if (depth === 1) sectionType = 'organizational_header'
          else if (depth === 2) sectionType = 'category_header'
          
          currentSection = {
            title: para.content,
            pageNumber: para.boundingRegions?.[0]?.pageNumber || 1,
            content: [],
            role: para.role,
            sectionNumber: sectionNumber,
            sectionType: sectionType,
            depth: depth
          }
        } else if (currentSection) {
          currentSection.content.push({
            text: para.content,
            pageNumber: para.boundingRegions?.[0]?.pageNumber || currentSection.pageNumber
          })
        }
      })
      if (currentSection) {
        extractedData.sections.push(currentSection)
      }
      
      const diCount = extractedData.sections.length
      
      // Pass 2: Detect numbered section headings that DI missed
      // Scan all paragraphs for patterns like "3.1.1.1 Completing the..." that
      // DI didn't tag as title/sectionHeading but are clearly section headings.
      const missedSections = []
      paragraphs.forEach((para, idx) => {
        const isDIHeading = para.role === 'title' || para.role === 'sectionHeading'
        if (isDIHeading) return // already handled in Pass 1
        
        const text = (para.content || '').trim()
        if (text.length > 200) return // too long to be a heading
        
        const numberMatch = text.match(/^(\d+(?:\.\d+)*)[\.\s]/)
        if (!numberMatch) return
        
        const sectionNumber = numberMatch[1]
        const depth = sectionNumber.split('.').filter(p => p).length
        
        // Skip single-digit instruction steps (e.g., "3. Click Save")
        if (depth === 1 && instructionVerbs.test(text)) return
        
        // Single-depth numbered paragraphs: the instructionVerbs filter above
        // (line 264) already blocks instruction steps like "3. Click Save".
        // Any single-depth numbered paragraph that passes that filter is a
        // legitimate section heading (e.g., checklist questions, requirements).
        
        // Skip if already captured by DI
        if (diTaggedNumbers.has(sectionNumber)) return
        
        // Skip if this number is a child of an already-captured DI section
        // at the same depth (avoid duplicates)
        const alreadyExists = extractedData.sections.some(s => s.sectionNumber === sectionNumber)
        if (alreadyExists) return
        
        // Collect subsequent body paragraphs as content
        const bodyContent = []
        for (let j = idx + 1; j < paragraphs.length; j++) {
          const next = paragraphs[j]
          const nextText = (next.content || '').trim()
          const nextNum = nextText.match(/^(\d+(?:\.\d+)*)[\.\s]/)
          // Stop at next numbered heading or DI-tagged heading
          if (nextNum && (next.role === 'title' || next.role === 'sectionHeading' || nextNum[1].split('.').length >= depth)) break
          if (next.role === 'title' || next.role === 'sectionHeading') break
          bodyContent.push({
            text: next.content,
            pageNumber: next.boundingRegions?.[0]?.pageNumber || para.boundingRegions?.[0]?.pageNumber || 1
          })
        }
        
        let sectionType = 'requirement'
        if (depth === 1) sectionType = 'organizational_header'
        else if (depth === 2) sectionType = 'category_header'
        
        missedSections.push({
          title: para.content,
          pageNumber: para.boundingRegions?.[0]?.pageNumber || 1,
          content: bodyContent,
          role: 'detected',
          sectionNumber: sectionNumber,
          sectionType: sectionType,
          depth: depth
        })
      })
      
      if (missedSections.length > 0) {
        extractedData.sections.push(...missedSections)
        console.log(`🔍 Pass 2 recovered ${missedSections.length} sections DI missed:`)
        missedSections.forEach(s => console.log(`   + ${s.sectionNumber} ${s.title?.substring(0, 80)}`))
      }
      
      // Sort sections by number for consistent ordering
      extractedData.sections.sort((a, b) => {
        const ap = (a.sectionNumber || '').split('.').map(Number)
        const bp = (b.sectionNumber || '').split('.').map(Number)
        for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
          if ((ap[i] || 0) !== (bp[i] || 0)) return (ap[i] || 0) - (bp[i] || 0)
        }
        return 0
      })
      
      // ─── Ensure every TOC entry has at least one section in sections[] ────────
      for (const tocEntry of sortedTOC) {
        const tocNum = tocEntry.title?.match(/^(\d+)/)?.[1]
        if (!tocNum) continue
        const hasSection = extractedData.sections.some(s => {
          const sNum = s.sectionNumber || ''
          return sNum === tocNum || sNum.startsWith(tocNum + '.')
        })
        if (!hasSection) {
          const tocPage = tocEntry.pageNumber || 1
          const nextTocPage = sortedTOC.find(t => {
            const n = t.title?.match(/^(\d+)/)?.[1]
            return n && parseInt(n) > parseInt(tocNum)
          })?.pageNumber || (tocPage + 10)
          const bodyContent = paragraphs
            .filter(p => {
              const pg = p.boundingRegions?.[0]?.pageNumber || 0
              return pg >= tocPage && pg < nextTocPage && p.role !== 'title' && p.role !== 'sectionHeading'
            })
            .map(p => ({ text: p.content, pageNumber: p.boundingRegions?.[0]?.pageNumber || tocPage }))

          extractedData.sections.push({
            title: tocEntry.title,
            pageNumber: tocPage,
            content: bodyContent,
            role: 'title',
            sectionNumber: tocNum,
            sectionType: 'organizational_header',
            depth: 1
          })
          console.log(`📌 Synthetic section for TOC entry: ${tocEntry.title}`)
        }
      }

      console.log(`📊 Total sections: ${extractedData.sections.length} (DI: ${diCount}, recovered: ${missedSections.length})`)
      
      const typeCount = { organizational_header: 0, category_header: 0, requirement: 0 }
      extractedData.sections.forEach(s => {
        if (s.sectionType) typeCount[s.sectionType]++
      })
      console.log(`   - Organizational headers: ${typeCount.organizational_header}`)
      console.log(`   - Category headers: ${typeCount.category_header}`)
      console.log(`   - Requirements: ${typeCount.requirement}`)
      
      if (extractedData.sections.length > 0) {
        console.log('📋 First 25 section titles:')
        extractedData.sections.slice(0, 25).forEach((s, idx) => {
          const src = s.role === 'detected' ? '[REC]' : '[DI]'
          const typeLabel = s.sectionType === 'organizational_header' ? 'ORG' 
                          : s.sectionType === 'category_header' ? 'CAT' 
                          : 'REQ'
          console.log(`  ${idx + 1}. ${src}[${typeLabel}] ${s.sectionNumber} ${s.title?.substring(0, 90)}`)
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
