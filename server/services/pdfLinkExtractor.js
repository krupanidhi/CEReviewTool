/**
 * PDF Link Extractor
 * 
 * Extracts internal hyperlink annotations from PDF files, specifically
 * from Table of Contents pages. Each TOC entry typically has a clickable
 * link that jumps to the exact destination page.
 * 
 * This gives us 100% accurate page mappings without any string matching guesswork.
 */

import './domPolyfills.js'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * Extract TOC links from a PDF file buffer.
 * Scans the first N pages for internal link annotations and returns
 * a map of link text → destination page number.
 * 
 * @param {Buffer} pdfBuffer - The PDF file as a Buffer
 * @param {number} maxTocPages - Max pages to scan for TOC links (default: 10)
 * @returns {Promise<Array<{text: string, destPage: number, sourcePage: number}>>}
 */
export async function extractTocLinks(pdfBuffer, maxTocPages = 10) {
  const links = []

  try {
    // Convert Buffer to Uint8Array for pdfjs
    const data = new Uint8Array(pdfBuffer)
    const pdf = await getDocument({ data, useSystemFonts: true }).promise
    const numPages = Math.min(pdf.numPages, maxTocPages)

    console.log(`🔗 PDF Link Extractor: scanning ${numPages} pages for TOC links...`)

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum)
      const annotations = await page.getAnnotations()

      // Filter for internal link annotations (GoTo type)
      const linkAnnotations = annotations.filter(a => a.subtype === 'Link' && a.dest)

      if (linkAnnotations.length === 0) continue

      // Get text content to match link positions to text
      const textContent = await page.getTextContent()
      const textItems = textContent.items.filter(item => item.str && item.str.trim())

      for (const annot of linkAnnotations) {
        // The dest array contains the destination: [pageRef, /XYZ, x, y, zoom]
        // We need to resolve the page reference to a page number
        let destPageNum = null

        if (annot.dest && Array.isArray(annot.dest)) {
          // dest[0] is a page reference object — resolve it
          try {
            const destRef = annot.dest[0]
            if (destRef && typeof destRef === 'object' && destRef.num !== undefined) {
              // Resolve the page ref to a page index
              const pageIndex = await pdf.getPageIndex(destRef)
              destPageNum = pageIndex + 1 // 0-indexed → 1-indexed
            }
          } catch (e) {
            // Some dest formats may not be resolvable
          }
        }

        if (!destPageNum) continue

        // Find the text that overlaps with this annotation's rectangle
        const rect = annot.rect // [x1, y1, x2, y2]
        if (!rect) continue

        // Find text items within the annotation rectangle
        const matchingText = textItems
          .filter(item => {
            if (!item.transform) return false
            const tx = item.transform[4]
            const ty = item.transform[5]
            // Check if text position is within the annotation rect (with some tolerance)
            return tx >= rect[0] - 5 && tx <= rect[2] + 5 &&
                   ty >= rect[1] - 5 && ty <= rect[3] + 5
          })
          .map(item => item.str)
          .join(' ')
          .trim()

        if (matchingText) {
          links.push({
            text: matchingText,
            destPage: destPageNum,
            sourcePage: pageNum
          })
        }
      }
    }

    console.log(`🔗 Extracted ${links.length} TOC links from PDF`)

    await pdf.destroy()
  } catch (error) {
    console.warn(`⚠️ PDF link extraction failed (non-fatal): ${error.message}`)
    // Non-fatal — we fall back to text-based TOC parsing
  }

  return links
}

/**
 * Build a formPageMap from extracted TOC links.
 * Normalizes link text to canonical form/attachment keys.
 * 
 * @param {Array} tocLinks - Array of {text, destPage, sourcePage}
 * @returns {Map<string, number>} Normalized key → page number
 */
export function buildMapFromTocLinks(tocLinks) {
  const map = new Map()

  // Patterns to normalize TOC link text to canonical keys
  const patterns = [
    { regex: /Attachment\s+(\d+)/i, keyFn: (m) => `attachment ${m[1]}` },
    { regex: /Form\s+(\d+[A-Za-z]?)/i, keyFn: (m) => `form ${m[1].toLowerCase()}` },
    { regex: /SF[-\s]?424\s*A/i, keyFn: () => 'sf-424a' },
    { regex: /SF[-\s]?424(?!\s*A)/i, keyFn: () => 'sf-424' },
    { regex: /Project\s+Narrative/i, keyFn: () => 'project narrative' },
    { regex: /Scope\s+of\s+Project/i, keyFn: () => 'project narrative' },
    { regex: /Budget\s+Narrative/i, keyFn: () => 'budget narrative' },
    { regex: /Operational\s+Plan/i, keyFn: () => 'operational plan' },
    { regex: /Summary\s+Page/i, keyFn: () => 'summary page' },
    { regex: /Project\s+Abstract/i, keyFn: () => 'project abstract' },
    { regex: /Organizational\s+Chart/i, keyFn: () => 'organizational chart' },
    { regex: /Evidence\s+of\s+(?:Nonprofit|Non-?Profit|Public\s+Agency)/i, keyFn: () => 'evidence of nonprofit' },
    { regex: /Co-?Applicant\s+Agreement/i, keyFn: () => 'co-applicant agreement' },
    { regex: /Board\s+(?:of\s+)?Directors/i, keyFn: () => 'board of directors' },
    { regex: /Bylaws/i, keyFn: () => 'bylaws' },
    { regex: /Articles\s+of\s+Incorporation/i, keyFn: () => 'articles of incorporation' },
    { regex: /Needs\s+Assessment/i, keyFn: () => 'needs assessment' },
    { regex: /Service\s+Area\s+Map/i, keyFn: () => 'service area map' },
    { regex: /Staffing\s+Profile/i, keyFn: () => 'form 2' },
    { regex: /Income\s+Analysis/i, keyFn: () => 'form 3' },
    { regex: /Services\s+Provided/i, keyFn: () => 'form 5a' },
    { regex: /Service\s+Sites/i, keyFn: () => 'form 5b' },
    { regex: /Other\s+Activities/i, keyFn: () => 'form 5c' },
    { regex: /Sliding\s+Fee/i, keyFn: () => 'form 11' },
    { regex: /QI\/?QA\s+Plan/i, keyFn: () => 'form 12' },
  ]

  for (const link of tocLinks) {
    const text = link.text

    // Always store the raw text as a key too
    if (text.length > 3) {
      map.set(text.toLowerCase().trim(), link.destPage)
    }

    // Normalize to canonical keys
    for (const pattern of patterns) {
      const m = text.match(pattern.regex)
      if (m) {
        const key = pattern.keyFn(m)
        // Only set if not already set (first match wins — TOC order is authoritative)
        if (!map.has(key)) {
          map.set(key, link.destPage)
        }
      }
    }
  }

  return map
}
