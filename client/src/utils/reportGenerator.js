/**
 * Report Generator — Excel and Word downloads for CE Review
 * 
 * Generates combined compliance review + checklist comparison reports
 * with all evidences, page numbers, reasoning, and statuses shown on UI.
 */

import * as XLSX from 'xlsx'
import { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer, Table, TableRow, TableCell, WidthType, BorderStyle } from 'docx'
import { saveAs } from 'file-saver'

// ============================================================
// EXCEL REPORT
// ============================================================

/**
 * Generate and download an Excel report with compliance + checklist comparison data.
 * @param {Object} comparisonData - The full comparison result from the UI
 * @param {string} appName - Application name for the filename
 */
export function downloadExcelReport(comparisonData, appName = 'Application') {
  const wb = XLSX.utils.book_new()

  // --- Sheet 1: Compliance Review ---
  const complianceRows = buildComplianceRows(comparisonData)
  if (complianceRows.length > 0) {
    const ws = XLSX.utils.aoa_to_sheet(complianceRows)
    ws['!cols'] = [
      { wch: 30 }, // Section
      { wch: 12 }, // Status
      { wch: 50 }, // Requirement
      { wch: 50 }, // Evidence
      { wch: 15 }, // Page References
      { wch: 50 }, // Explanation
      { wch: 30 }, // Missing Fields
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Compliance Review')
  }

  // --- Sheet 2: Program-Specific Checklist ---
  const checklistComparison = extractChecklistComparison(comparisonData, 'programSpecific')
  if (checklistComparison) {
    const psqRows = buildChecklistRows(checklistComparison, 'Program-Specific')
    const ws2 = XLSX.utils.aoa_to_sheet(psqRows)
    ws2['!cols'] = [
      { wch: 6 },  // Q#
      { wch: 50 }, // Question
      { wch: 12 }, // AI Answer
      { wch: 10 }, // Confidence
      { wch: 50 }, // Evidence
      { wch: 15 }, // Page References
      { wch: 50 }, // Reasoning
      { wch: 30 }, // Suggested Resources
    ]
    XLSX.utils.book_append_sheet(wb, ws2, 'Program-Specific Checklist')
  }

  // --- Sheet 3: Standard Checklist ---
  const stdComparison = extractChecklistComparison(comparisonData, 'standard')
  if (stdComparison) {
    const stdRows = buildChecklistRows(stdComparison, 'Standard')
    const ws3 = XLSX.utils.aoa_to_sheet(stdRows)
    ws3['!cols'] = [
      { wch: 6 },  // Q#
      { wch: 50 }, // Question
      { wch: 12 }, // AI Answer
      { wch: 10 }, // Confidence
      { wch: 50 }, // Evidence
      { wch: 15 }, // Page References
      { wch: 50 }, // Reasoning
    ]
    XLSX.utils.book_append_sheet(wb, ws3, 'Standard Checklist')
  }

  // --- Sheet 4: Summary ---
  const summaryRows = buildSummaryRows(comparisonData, checklistComparison, stdComparison)
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows)
  wsSummary['!cols'] = [{ wch: 30 }, { wch: 40 }]
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary')

  const sanitized = appName.replace(/[^a-zA-Z0-9.-]/g, '_')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  saveAs(new Blob([buf], { type: 'application/octet-stream' }), `${sanitized}_CE_Review_Report.xlsx`)
}

// ============================================================
// WORD REPORT
// ============================================================

/**
 * Generate and download a Word report with compliance + checklist comparison data.
 * @param {Object} comparisonData - The full comparison result from the UI
 * @param {string} appName - Application name for the filename
 */
export async function downloadWordReport(comparisonData, appName = 'Application') {
  const children = []

  // Title
  children.push(new Paragraph({
    text: 'CE Review — Combined Compliance Report',
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 }
  }))
  children.push(new Paragraph({
    text: `Application: ${appName}`,
    heading: HeadingLevel.HEADING_2,
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 }
  }))
  children.push(new Paragraph({
    text: `Generated: ${new Date().toLocaleString()}`,
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 }
  }))

  // --- Section 1: Compliance Review ---
  const primaryResult = comparisonData?.results?.[0]
  const sections = primaryResult?.comparison?.sections || []
  if (sections.length > 0) {
    children.push(new Paragraph({
      text: '1. Compliance Review',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 }
    }))

    // Overall compliance
    const overall = primaryResult.comparison.overallCompliance
    if (overall !== undefined) {
      children.push(makeBoldValueParagraph('Overall Compliance', `${overall}%`))
    }
    children.push(makeBoldValueParagraph('Total Sections', `${sections.length}`))
    children.push(new Paragraph({ text: '', spacing: { after: 200 } }))

    sections.forEach((s, idx) => {
      const title = s.checklistSection || `Section ${idx + 1}`
      const status = (s.status || 'unknown').toUpperCase()
      const statusLabel = status === 'MET' ? '✅ MET' : status === 'NOT_MET' ? '❌ NOT MET' : status === 'NOT_APPLICABLE' ? '⊘ N/A' : status

      children.push(new Paragraph({
        text: `${title} — ${statusLabel}`,
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 }
      }))

      if (s.requirement) {
        children.push(makeBoldValueParagraph('Requirement', s.requirement))
      }
      if (s.explanation) {
        children.push(makeBoldValueParagraph('Explanation', s.explanation))
      }
      if (s.evidence) {
        children.push(makeBoldValueParagraph('Evidence', s.evidence))
      }
      if (s.pageReferences?.length > 0) {
        children.push(makeBoldValueParagraph('Page References', s.pageReferences.join(', ')))
      }
      if (s.missingFields?.length > 0) {
        children.push(makeBoldValueParagraph('Missing Fields', s.missingFields.join(', ')))
      }
    })
  }

  // --- Section 2: Checklist Comparison ---
  const checklistComparison = extractChecklistComparison(comparisonData, 'programSpecific')
  const stdComparison = extractChecklistComparison(comparisonData, 'standard')

  if (checklistComparison || stdComparison) {
    children.push(new Paragraph({
      text: '2. Checklist Comparison',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 }
    }))
  }

  if (checklistComparison) {
    children.push(new Paragraph({
      text: '2.1 Program-Specific Questions',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 100 }
    }))
    addChecklistSummaryToWord(children, checklistComparison.summary)
    addChecklistResultsToWord(children, checklistComparison.results || [])
  }

  if (stdComparison) {
    children.push(new Paragraph({
      text: '2.2 Standard Checklist',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 100 }
    }))
    addChecklistSummaryToWord(children, stdComparison.summary)
    addChecklistResultsToWord(children, stdComparison.results || [])
  }

  const doc = new Document({ sections: [{ properties: {}, children }] })
  const buffer = await Packer.toBlob(doc)
  const sanitized = appName.replace(/[^a-zA-Z0-9.-]/g, '_')
  saveAs(buffer, `${sanitized}_CE_Review_Report.docx`)
}

// ============================================================
// HELPERS
// ============================================================

function extractChecklistComparison(comparisonData, type) {
  const primaryResult = comparisonData?.results?.[0]
  const cc = primaryResult?.checklistComparison
  if (!cc) return null
  return cc[type] || null
}

function buildComplianceRows(comparisonData) {
  const primaryResult = comparisonData?.results?.[0]
  const sections = primaryResult?.comparison?.sections || []
  if (sections.length === 0) return []

  const rows = [['Section', 'Status', 'Requirement', 'Evidence', 'Page References', 'Explanation', 'Missing Fields']]

  sections.forEach(s => {
    rows.push([
      s.checklistSection || '',
      (s.status || '').toUpperCase(),
      s.requirement || '',
      s.evidence || '',
      (s.pageReferences || []).join(', '),
      s.explanation || '',
      (s.missingFields || []).join(', ')
    ])
  })

  return rows
}

function buildChecklistRows(checklistData, label) {
  const results = checklistData?.results || []
  if (results.length === 0) return []

  const hasResources = results.some(r => r.suggestedResources)
  const header = ['Q#', 'Question', 'AI Answer', 'Confidence', 'Evidence', 'Page References', 'Reasoning']
  if (hasResources) header.push('Suggested Resources')

  const rows = [header]
  results.forEach(r => {
    const row = [
      r.questionNumber || '',
      r.question || '',
      r.aiAnswer || '',
      r.confidence || '',
      r.evidence || '',
      (r.pageReferences || []).join(', '),
      r.reasoning || ''
    ]
    if (hasResources) row.push(r.suggestedResources || '')
    rows.push(row)
  })

  return rows
}

function buildSummaryRows(comparisonData, psqData, stdData) {
  const primaryResult = comparisonData?.results?.[0]
  const comparison = primaryResult?.comparison
  const appName = comparisonData?.applications?.[0]?.name || comparisonData?.applications?.[0]?.originalName || 'Unknown'
  const checklistName = comparisonData?.checklists?.[0]?.name || comparisonData?.checklists?.[0]?.originalName || 'Unknown'

  const rows = [
    ['CE Review — Summary Report', ''],
    ['', ''],
    ['Application', appName],
    ['Checklist', checklistName],
    ['Generated', new Date().toLocaleString()],
    ['', ''],
    ['--- Compliance Review ---', ''],
    ['Overall Compliance', comparison?.overallCompliance !== undefined ? `${comparison.overallCompliance}%` : 'N/A'],
    ['Total Sections', `${(comparison?.sections || []).length}`],
    ['Met', `${(comparison?.sections || []).filter(s => s.status === 'met').length}`],
    ['Not Met', `${(comparison?.sections || []).filter(s => s.status === 'not_met').length}`],
    ['Not Applicable', `${(comparison?.sections || []).filter(s => s.status === 'not_applicable').length}`],
  ]

  if (psqData?.summary) {
    rows.push(['', ''])
    rows.push(['--- Program-Specific Checklist ---', ''])
    rows.push(['Total Questions', `${psqData.summary.totalQuestions}`])
    rows.push(['Yes', `${psqData.summary.yesCount || 0}`])
    rows.push(['No', `${psqData.summary.noCount || 0}`])
    rows.push(['N/A', `${psqData.summary.naCount || 0}`])
  }

  if (stdData?.summary) {
    rows.push(['', ''])
    rows.push(['--- Standard Checklist ---', ''])
    rows.push(['Total Questions', `${stdData.summary.totalQuestions}`])
    rows.push(['Yes', `${stdData.summary.yesCount || 0}`])
    rows.push(['No', `${stdData.summary.noCount || 0}`])
    rows.push(['N/A', `${stdData.summary.naCount || 0}`])
  }

  return rows
}

function makeBoldValueParagraph(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: value || '' })
    ],
    spacing: { after: 60 }
  })
}

function addChecklistSummaryToWord(children, summary) {
  if (!summary) return
  children.push(makeBoldValueParagraph('Total Questions', `${summary.totalQuestions}`))
  children.push(makeBoldValueParagraph('Yes', `${summary.yesCount || 0}`))
  children.push(makeBoldValueParagraph('No', `${summary.noCount || 0}`))
  children.push(makeBoldValueParagraph('N/A', `${summary.naCount || 0}`))
  children.push(new Paragraph({ text: '', spacing: { after: 100 } }))
}

function addChecklistResultsToWord(children, results) {
  results.forEach(r => {
    const answerIcon = (r.aiAnswer || '').toLowerCase() === 'yes' ? '✅' : (r.aiAnswer || '').toLowerCase() === 'no' ? '❌' : '⊘'

    children.push(new Paragraph({
      children: [
        new TextRun({ text: `Q${r.questionNumber}: `, bold: true }),
        new TextRun({ text: r.question || '' })
      ],
      spacing: { before: 200, after: 60 }
    }))

    children.push(makeBoldValueParagraph('AI Answer', `${answerIcon} ${r.aiAnswer || ''} (${r.confidence || 'low'} confidence)`))
    if (r.evidence) {
      children.push(makeBoldValueParagraph('Evidence', r.evidence))
    }
    if (r.pageReferences?.length > 0) {
      children.push(makeBoldValueParagraph('Page References', r.pageReferences.join(', ')))
    }
    if (r.reasoning) {
      children.push(makeBoldValueParagraph('Reasoning', r.reasoning))
    }
    if (r.suggestedResources) {
      children.push(makeBoldValueParagraph('Suggested Resources', r.suggestedResources))
    }
  })
}
