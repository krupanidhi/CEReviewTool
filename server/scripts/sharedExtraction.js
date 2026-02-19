/**
 * Shared Extraction Module
 * 
 * Provides a single Azure Document Intelligence extraction call
 * and format converters for both CE Review (JSON) and Prefunding Review (plain text).
 * 
 * Both review pipelines reuse the same raw Azure DI result — no duplicate extraction.
 */

import axios from 'axios'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ============================================================
// Text Compression (shared utility)
// ============================================================

export function compressText(text) {
  if (!text) return ''
  let c = text
  c = c.replace(/={10,}/g, '')
  c = c.replace(/PAGE \d+/gi, '')
  c = c.replace(/Page Number:\s*\d+/gi, '')
  c = c.replace(/Tracking Number[^\n]*/gi, '')
  c = c.replace(/\n{3,}/g, '\n\n')
  c = c.replace(/[ \t]{2,}/g, ' ')
  c = c.replace(/^\s+$/gm, '')
  c = c.replace(/Page \d+ of \d+/gi, '')
  c = c.replace(/[│┤├┼─┌┐└┘]/g, ' ')
  c = c.replace(/_{5,}/g, '')
  c = c.replace(/-{5,}/g, '')
  c = c.replace(/\.{5,}/g, '')
  c = c.replace(/  +/g, ' ')
  c = c.replace(/\n /g, '\n')
  c = c.split('\n').filter(line => line.trim().length > 0).join('\n')
  return c.trim()
}

// ============================================================
// Azure Document Intelligence Extraction
// ============================================================

/**
 * Extract a PDF using Azure Document Intelligence (prebuilt-layout).
 * Returns the raw analyzeResult object.
 * Called ONCE per application — result is reused for both CE and Prefunding.
 * 
 * @param {Buffer} pdfBuffer - PDF file contents
 * @param {string} filename - Original filename (for logging)
 * @param {object} config - Must contain AZURE_DOC_ENDPOINT and AZURE_DOC_KEY
 * @returns {object} analyzeResult from Azure DI
 */
export async function extractWithAzureDI(pdfBuffer, filename, config) {
  const ts = () => new Date().toISOString().substring(11, 19)
  console.log(`[${ts()}] 📡 Extracting: ${filename} via Azure Document Intelligence...`)
  console.log(`[${ts()}]   🌐 DI Endpoint: ${config.AZURE_DOC_ENDPOINT || '(not set)'}`)
  const start = Date.now()

  const endpoint = `${config.AZURE_DOC_ENDPOINT}formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`

  const analyzeResponse = await axios.post(endpoint, pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Ocp-Apim-Subscription-Key': config.AZURE_DOC_KEY
    },
    maxBodyLength: Infinity
  })

  const operationLocation = analyzeResponse.headers['operation-location']
  if (!operationLocation) throw new Error('No operation-location returned from Azure DI')

  // Poll for completion (up to ~4 minutes)
  let result = null
  for (let attempt = 0; attempt < 120; attempt++) {
    await sleep(2000)
    const pollResponse = await axios.get(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': config.AZURE_DOC_KEY }
    })
    if (pollResponse.data.status === 'succeeded') {
      result = pollResponse.data
      break
    } else if (pollResponse.data.status === 'failed') {
      throw new Error('Azure DI analysis failed')
    }
  }

  if (!result) throw new Error('Timeout waiting for Azure DI results')

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const pageCount = result.analyzeResult?.pages?.length || 0
  console.log(`[${ts()}] ✅ Extraction complete: ${pageCount} pages in ${elapsed}s`)

  return result.analyzeResult
}

// ============================================================
// FORMAT: Raw Azure DI → CE Review JSON
// ============================================================

/**
 * Convert raw Azure DI analyzeResult into CE Review JSON format.
 * Produces: { pages, tables, sections, tableOfContents, keyValuePairs, metadata }
 * 
 * This matches the format CE Review's server expects when it receives
 * applicationData for /api/compare and /api/qa-comparison endpoints.
 */
export function convertToCEFormat(analyzeResult) {
  // Pages — extract lines content only (strip bounding boxes)
  const pages = (analyzeResult.pages || []).map((page, idx) => ({
    pageNumber: page.pageNumber || (idx + 1),
    width: page.width,
    height: page.height,
    unit: page.unit,
    lines: (page.lines || []).map(line => ({
      content: line.content
    })),
    selectionMarks: page.selectionMarks || []
  }))

  // Tables — convert cells to structuredData (header row as keys)
  const tables = (analyzeResult.tables || []).map((table, tableIdx) => {
    const cells = table.cells || []
    const rowCount = table.rowCount || 0
    const columnCount = table.columnCount || 0
    const pageNumber = table.boundingRegions?.[0]?.pageNumber || 1

    const grid = Array(rowCount).fill(null).map(() => Array(columnCount).fill(''))
    cells.forEach(cell => {
      if (cell.rowIndex < rowCount && cell.columnIndex < columnCount) {
        grid[cell.rowIndex][cell.columnIndex] = cell.content || ''
      }
    })

    const headers = grid[0] || []
    const columnHeaders = headers.every(h => !h?.trim())
      ? Array(columnCount).fill(null).map((_, i) => `Column_${i + 1}`)
      : headers.map((h, i) => h?.trim() || `Column_${i + 1}`)

    const structuredData = []
    for (let r = 1; r < rowCount; r++) {
      const row = grid[r]
      if (row.every(c => !c?.trim())) continue
      const rowObj = {}
      columnHeaders.forEach((header, ci) => { rowObj[header] = row[ci] || '' })
      structuredData.push(rowObj)
    }

    return { id: `table_${tableIdx}`, pageNumber, rowCount, columnCount, structuredData }
  })

  // Sections — built from paragraphs with role detection
  const paragraphs = analyzeResult.paragraphs || []
  const sections = []
  let currentSection = null

  paragraphs.forEach(para => {
    const pageNum = para.boundingRegions?.[0]?.pageNumber || 1
    if (para.role === 'title' || para.role === 'sectionHeading') {
      if (currentSection) sections.push(currentSection)
      const numMatch = para.content.match(/^(\d+(?:\.\d+)*)/)
      currentSection = {
        sectionNumber: numMatch ? numMatch[1] : '',
        title: para.content,
        pageNumber: pageNum,
        content: []
      }
    } else if (currentSection) {
      currentSection.content.push({ text: para.content, pageNumber: pageNum })
    } else {
      currentSection = {
        sectionNumber: '',
        title: 'Introduction',
        pageNumber: pageNum,
        content: [{ text: para.content, pageNumber: pageNum }]
      }
    }
  })
  if (currentSection) sections.push(currentSection)

  // Table of Contents — top-level sections only
  const tableOfContents = sections
    .filter(s => /^\d+$/.test(s.sectionNumber))
    .map((s, idx) => ({
      id: `section_${idx + 1}`,
      title: s.title,
      pageNumber: s.pageNumber,
      level: 1
    }))

  // Key-value pairs — include pageNumber to match UI path (enhancedDocumentIntelligence.js)
  // pageNumber is used by extractApplicantProfile for source tracking of applicant type flags
  const keyValuePairs = (analyzeResult.keyValuePairs || []).map(kv => ({
    key: kv.key?.content || '',
    value: kv.value?.content || '',
    confidence: kv.confidence,
    pageNumber: kv.key?.boundingRegions?.[0]?.pageNumber || 1
  })).filter(kv => kv.key && kv.value)

  return {
    pages,
    tables,
    sections,
    tableOfContents,
    keyValuePairs,
    metadata: {
      pageCount: pages.length,
      analyzedAt: new Date().toISOString()
    }
  }
}

// ============================================================
// FORMAT: Raw Azure DI → Prefunding Plain Text
// ============================================================

/**
 * Convert raw Azure DI analyzeResult into Prefunding Review plain text format.
 * Produces text with PAGE markers, [TEXT], [HEADING], [TABLE] tags — matching
 * the format Prefunding Review's extractTextFromPDF() produces.
 */
export function convertToPrefundingFormat(analyzeResult) {
  const pages = analyzeResult.pages || []
  const paragraphs = analyzeResult.paragraphs || []
  const tables = analyzeResult.tables || []

  let contentWithPages = ''

  if (paragraphs.length > 0) {
    // Map Azure page numbers to footer page numbers
    const footerPageMap = {}
    pages.forEach((page, index) => {
      const azurePageNum = page.pageNumber || (index + 1)
      const lines = page.lines || []
      lines.forEach(line => {
        const pageMatch = line.content.match(/Page Number:\s*(\d+)/i)
        if (pageMatch) footerPageMap[azurePageNum] = pageMatch[1]
      })
      if (!footerPageMap[azurePageNum]) footerPageMap[azurePageNum] = azurePageNum.toString()
    })

    // Group paragraphs by footer page number
    const pageContent = {}
    paragraphs.forEach(para => {
      const azurePageNum = para.boundingRegions?.[0]?.pageNumber || 1
      const footerPageNum = footerPageMap[azurePageNum] || azurePageNum
      if (!pageContent[footerPageNum]) pageContent[footerPageNum] = []

      // Skip footer lines
      if (para.content.match(/Page Number:\s*\d+/i) || para.content.match(/Tracking Number/i)) return

      let contentType = '[TEXT]'
      if (para.role === 'title' || para.role === 'sectionHeading') contentType = '[HEADING]'

      pageContent[footerPageNum].push({ type: contentType, content: para.content })
    })

    // Add tables to their respective pages
    tables.forEach((table, tableIndex) => {
      const azurePageNum = table.boundingRegions?.[0]?.pageNumber || 1
      const footerPageNum = footerPageMap[azurePageNum] || azurePageNum
      if (!pageContent[footerPageNum]) pageContent[footerPageNum] = []

      const cells = table.cells || []
      const tableData = {}
      cells.forEach(cell => {
        const rowIdx = cell.rowIndex || 0
        const colIdx = cell.columnIndex || 0
        if (!tableData[rowIdx]) tableData[rowIdx] = []
        tableData[rowIdx][colIdx] = cell.content || ''
      })

      let tableText = `Table ${tableIndex + 1}:\n`
      Object.keys(tableData).forEach(rowIdx => {
        tableText += tableData[rowIdx].join(' | ') + '\n'
      })

      pageContent[footerPageNum].push({ type: '[TABLE]', content: tableText })
    })

    // Build content page by page
    const sortedPages = Object.keys(pageContent).sort((a, b) => parseInt(a) - parseInt(b))
    sortedPages.forEach(pageNum => {
      contentWithPages += `\n\n========== PAGE ${pageNum} (from PDF footer) ==========\n\n`
      pageContent[pageNum].forEach(item => {
        contentWithPages += `${item.type} ${item.content}\n\n`
      })
    })
  } else {
    contentWithPages = analyzeResult.content || ''
  }

  return contentWithPages
}
