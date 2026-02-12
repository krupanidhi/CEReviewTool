/**
 * Structured Document Transformer
 * 
 * Converts raw Azure Document Intelligence extraction output into a clean,
 * section-based key/value pair structure with form fields, tables, and
 * content organized by section hierarchy.
 * 
 * Output format:
 * - No bounding boxes, polygons, spans, or field locations
 * - Page numbers kept as content references only
 * - Strong section relationships with parent/child hierarchy
 * - Form fields as key/value pairs
 * - Tables as structured arrays within their parent section
 */

/**
 * Transform raw extraction data into structured section-based JSON
 * @param {Object} rawData - The raw extraction data from enhancedDocumentIntelligence
 * @returns {Object} Clean structured document
 */
export function transformToStructured(rawData) {
  if (!rawData) return null

  const structured = {
    document: {
      metadata: {
        pageCount: rawData.metadata?.pageCount || rawData.pages?.length || 0,
        analyzedAt: rawData.metadata?.analyzedAt || new Date().toISOString(),
        totalSections: 0,
        totalTables: 0,
        totalFormFields: 0
      },
      tableOfContents: buildTOC(rawData.tableOfContents),
      sections: buildSectionHierarchy(rawData.sections, rawData.tables, rawData.pages)
    }
  }

  // Update counts
  const counts = countElements(structured.document.sections)
  structured.document.metadata.totalSections = counts.sections
  structured.document.metadata.totalTables = counts.tables
  structured.document.metadata.totalFormFields = counts.formFields

  return structured
}

/**
 * Build clean TOC
 */
function buildTOC(tocEntries) {
  if (!tocEntries || tocEntries.length === 0) return []
  return tocEntries.map(entry => ({
    id: entry.id,
    title: entry.title,
    pageReference: entry.pageNumber,
    level: entry.level || 1
  }))
}

/**
 * Build section hierarchy with form fields and tables associated to their parent sections
 */
function buildSectionHierarchy(sections, tables, pages) {
  if (!sections || sections.length === 0) return []

  // Index tables by page number for quick lookup
  const tablesByPage = {}
  if (tables) {
    tables.forEach(table => {
      const page = table.pageNumber
      if (!tablesByPage[page]) tablesByPage[page] = []
      tablesByPage[page].push(table)
    })
  }

  // Build page text index for form field extraction
  const pageTextMap = {}
  if (pages) {
    pages.forEach(page => {
      pageTextMap[page.pageNumber] = page.lines?.map(l => l.content).join('\n') || ''
    })
  }

  // Track which tables have been assigned to sections
  const assignedTables = new Set()

  // Process sections into hierarchy
  const result = []
  
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const nextSection = sections[i + 1]

    // Determine page range for this section
    const startPage = section.pageNumber
    const endPage = nextSection ? nextSection.pageNumber : (pages?.length || startPage)

    // Build the structured section
    const structuredSection = {
      sectionNumber: section.sectionNumber || null,
      title: cleanTitle(section.title),
      type: section.sectionType || 'content',
      pageReference: startPage,
      content: extractSectionText(section.content),
      formFields: [],
      tables: [],
      children: [] // Will be populated in hierarchy pass
    }

    // Extract form fields from section content and page text
    const formFields = extractFormFields(section, pageTextMap, startPage, endPage)
    structuredSection.formFields = formFields

    // Associate tables with this section based on page range
    for (let p = startPage; p <= endPage; p++) {
      const pageTables = tablesByPage[p]
      if (pageTables) {
        pageTables.forEach(table => {
          if (!assignedTables.has(table.id)) {
            // Check if table belongs to this section (same page or within range)
            const shouldAssign = p === startPage || 
              (p > startPage && p < (nextSection?.pageNumber || endPage + 1))
            
            if (shouldAssign) {
              assignedTables.add(table.id)
              structuredSection.tables.push(transformTable(table))
            }
          }
        })
      }
    }

    result.push(structuredSection)
  }

  // Build parent-child hierarchy
  return buildHierarchy(result)
}

/**
 * Build parent-child hierarchy from flat section list based on section numbers
 */
function buildHierarchy(flatSections) {
  const root = []
  const stack = [] // Stack of { section, depth }

  for (const section of flatSections) {
    const depth = section.sectionNumber 
      ? section.sectionNumber.split('.').filter(p => p).length 
      : 0

    // Remove children array if empty (will be populated below)
    // Find parent: walk up stack until we find a section with lower depth
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop()
    }

    if (stack.length === 0) {
      // Top-level section
      root.push(section)
    } else {
      // Child of the section at top of stack
      stack[stack.length - 1].section.children.push(section)
    }

    stack.push({ section, depth })
  }

  // Clean up empty children arrays
  const cleanChildren = (sections) => {
    for (const s of sections) {
      if (s.children.length === 0) {
        delete s.children
      } else {
        cleanChildren(s.children)
      }
    }
  }
  cleanChildren(root)

  return root
}

/**
 * Extract form fields (key/value pairs) from section content and page text
 */
function extractFormFields(section, pageTextMap, startPage, endPage) {
  const fields = []
  const seenKeys = new Set()

  // Extract from section content lines
  if (section.content) {
    for (const item of section.content) {
      const text = item.text || ''
      
      // Pattern 1: "Key: Value" format
      const kvMatch = text.match(/^([^:]{3,60}):\s+(.+)$/)
      if (kvMatch && !text.includes('|')) {
        const key = kvMatch[1].trim()
        const value = kvMatch[2].trim()
        if (key && value && !seenKeys.has(key.toLowerCase())) {
          seenKeys.add(key.toLowerCase())
          fields.push({
            field: key,
            value: value,
            pageReference: item.pageNumber || startPage
          })
        }
      }

      // Pattern 2: "Question? Answer" (form questions with answers)
      const questionMatch = text.match(/^(.+\?)\s*$/)
      if (questionMatch) {
        // Look for answer on next line (already in content array)
        const idx = section.content.indexOf(item)
        if (idx < section.content.length - 1) {
          const nextText = section.content[idx + 1]?.text?.trim()
          if (nextText && /^\d[\d,]*$/.test(nextText)) {
            const key = questionMatch[1].trim()
            if (!seenKeys.has(key.toLowerCase())) {
              seenKeys.add(key.toLowerCase())
              fields.push({
                field: key,
                value: nextText,
                pageReference: item.pageNumber || startPage
              })
            }
          }
        }
      }

      // Pattern 3: Checkbox fields "[X] Label" or ":selected: Label"
      const checkboxMatch = text.match(/(?:\[([Xx_ ])\]|:(selected|unselected):)\s*(.+)/)
      if (checkboxMatch) {
        const isSelected = checkboxMatch[1] === 'X' || checkboxMatch[1] === 'x' || checkboxMatch[2] === 'selected'
        const label = checkboxMatch[3].trim()
        if (label && !seenKeys.has(label.toLowerCase())) {
          seenKeys.add(label.toLowerCase())
          fields.push({
            field: label,
            value: isSelected ? 'Selected' : 'Not Selected',
            pageReference: item.pageNumber || startPage
          })
        }
      }
    }
  }

  // Extract from page text for the section's page range
  for (let p = startPage; p <= Math.min(endPage, startPage + 2); p++) {
    const pageText = pageTextMap[p]
    if (!pageText) continue

    const lines = pageText.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Multi-line question with numeric answer
      if (line.endsWith('?') && i + 1 < lines.length) {
        const nextLine = lines[i + 1]?.trim()
        // Check if next line(s) complete the question or provide an answer
        if (nextLine && /^\d[\d,]*$/.test(nextLine)) {
          const key = line
          if (!seenKeys.has(key.toLowerCase())) {
            seenKeys.add(key.toLowerCase())
            fields.push({
              field: key,
              value: nextLine,
              pageReference: p
            })
          }
        }
      }

      // "Field Name: Field Value" on same line (not already captured)
      const inlineKV = line.match(/^([A-Z][^:]{2,50}):\s+(.{1,200})$/)
      if (inlineKV) {
        const key = inlineKV[1].trim()
        const value = inlineKV[2].trim()
        if (!seenKeys.has(key.toLowerCase()) && !line.includes('|')) {
          seenKeys.add(key.toLowerCase())
          fields.push({
            field: key,
            value: value,
            pageReference: p
          })
        }
      }
    }
  }

  return fields
}

/**
 * Transform a raw table into clean structured format
 */
function transformTable(table) {
  const result = {
    tableId: table.id,
    pageReference: table.pageNumber,
    dimensions: {
      rows: table.rowCount,
      columns: table.columnCount
    },
    headers: [],
    rows: []
  }

  if (table.structuredData && table.structuredData.length > 0) {
    // Get headers from the keys of the first row
    result.headers = Object.keys(table.structuredData[0])
    
    // Each row is a key/value object
    result.rows = table.structuredData.map(row => {
      const cleanRow = {}
      for (const [key, value] of Object.entries(row)) {
        // Clean up selection marks in values
        cleanRow[key] = cleanValue(value)
      }
      return cleanRow
    })
  } else if (table.cells) {
    // Fallback: build from raw cells
    const grid = Array(table.rowCount).fill(null).map(() => Array(table.columnCount).fill(''))
    table.cells.forEach(cell => {
      if (cell.rowIndex < table.rowCount && cell.columnIndex < table.columnCount) {
        grid[cell.rowIndex][cell.columnIndex] = cell.content || ''
      }
    })

    if (grid.length > 0) {
      result.headers = grid[0].map((h, i) => h.trim() || `Column_${i + 1}`)
      for (let r = 1; r < grid.length; r++) {
        if (grid[r].every(c => !c.trim())) continue
        const row = {}
        result.headers.forEach((header, ci) => {
          row[header] = cleanValue(grid[r][ci])
        })
        result.rows.push(row)
      }
    }
  }

  return result
}

/**
 * Clean a cell value - remove selection marks, normalize whitespace
 */
function cleanValue(value) {
  if (!value) return ''
  return value
    .replace(/:selected:/g, '☑')
    .replace(/:unselected:/g, '☐')
    .replace(/\[X\]/gi, '☑')
    .replace(/\[_\]/g, '☐')
    .replace(/\[ \]/g, '☐')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Clean section title
 */
function cleanTitle(title) {
  if (!title) return ''
  return title.replace(/\s+/g, ' ').trim()
}

/**
 * Extract plain text from section content array
 */
function extractSectionText(content) {
  if (!content || content.length === 0) return ''
  return content.map(item => item.text || '').join('\n').trim()
}

/**
 * Count total elements in the structured output
 */
function countElements(sections, counts = { sections: 0, tables: 0, formFields: 0 }) {
  if (!sections) return counts
  for (const section of sections) {
    counts.sections++
    counts.tables += section.tables?.length || 0
    counts.formFields += section.formFields?.length || 0
    if (section.children) {
      countElements(section.children, counts)
    }
  }
  return counts
}

export default { transformToStructured }
