import * as XLSX from 'xlsx'
import { getProcessedApplications, getProcessedApplication } from '../services/api'

/**
 * Fetch full data for all completed applications from the dashboard.
 * Returns array of { name, checklistName, data } objects.
 */
async function fetchAllCompletedApps(onProgress) {
  const result = await getProcessedApplications()
  const apps = (result.applications || []).filter(a => a.status === 'completed')

  const fullApps = []
  for (let i = 0; i < apps.length; i++) {
    if (onProgress) onProgress(i + 1, apps.length, apps[i].name)
    try {
      const detail = await getProcessedApplication(apps[i].id)
      if (detail.application?.data) {
        const rawName = apps[i].name || 'Unknown'
        fullApps.push({
          name: rawName.replace(/\.pdf$/i, ''),
          applicationNumber: extractApplicationNumber(rawName),
          checklistName: apps[i].checklistName || '',
          data: detail.application.data
        })
      }
    } catch (err) {
      console.warn(`Skipping ${apps[i].name}: ${err.message}`)
    }
  }
  return fullApps
}

/**
 * Bulk Export — Compliance Report
 * One row per compliance section per application.
 * "Application Name" column enables Excel filtering by app.
 */
export async function bulkExportComplianceReport(onProgress) {
  const apps = await fetchAllCompletedApps(onProgress)

  const rows = []
  for (const app of apps) {
    const sections = app.data.comparison?.sections || []
    if (sections.length === 0) {
      rows.push({
        'Application Number': app.applicationNumber,
        'Application Name': app.name,
        'Checklist Name': app.checklistName,
        'Section': '(No compliance data)',
        'Requirement': '',
        'Status': '',
        'Evidence': '',
        'Explanation': '',
        'Recommendation': '',
        'Page References': '',
        'Missing Fields': ''
      })
      continue
    }
    for (const s of sections) {
      rows.push({
        'Application Number': app.applicationNumber,
        'Application Name': app.name,
        'Checklist Name': app.checklistName,
        'Section': s.checklistSection || '',
        'Requirement': s.requirement || '',
        'Status': s.status || '',
        'Evidence': s.evidence || '',
        'Explanation': s.explanation || '',
        'Recommendation': s.recommendation || '',
        'Page References': (s.pageReferences || []).join(', '),
        'Missing Fields': (s.missingFields || []).join(', ')
      })
    }
  }

  if (rows.length === 0) {
    throw new Error('No compliance report data found in any application.')
  }

  const ws = XLSX.utils.json_to_sheet(rows)
  autoFitColumns(ws, rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Compliance Report')
  XLSX.writeFile(wb, `Bulk_Export_Compliance_Report_${timestamp()}.xlsx`)
  return rows.length
}

/**
 * Bulk Export — Checklist Comparison
 * One row per checklist question per application.
 * Includes both Standard and Program-Specific questions.
 * "Application Name" column enables Excel filtering by app.
 */
export async function bulkExportChecklistComparison(onProgress) {
  const apps = await fetchAllCompletedApps(onProgress)

  const rows = []
  for (const app of apps) {
    const cc = app.data.checklistComparison || {}
    let hasData = false

    // Standard questions
    if (cc.standard?.results?.length) {
      hasData = true
      for (const r of cc.standard.results) {
        rows.push({
          'Application Number': app.applicationNumber,
          'Application Name': app.name,
          'Checklist Name': app.checklistName,
          'Type': 'Standard',
          'Question #': r.questionNumber || '',
          'Question': r.question || '',
          'AI Answer': r.aiAnswer || '',
          'Confidence': r.confidence || '',
          'Evidence': r.evidence || '',
          'Reasoning': r.reasoning || '',
          'Page References': (r.pageReferences || []).join(', '),
          'Requires SAAT': r.requiresSAAT ? 'Yes' : 'No'
        })
      }
    }

    // Program-Specific questions
    if (cc.programSpecific?.results?.length) {
      hasData = true
      for (const r of cc.programSpecific.results) {
        rows.push({
          'Application Number': app.applicationNumber,
          'Application Name': app.name,
          'Checklist Name': app.checklistName,
          'Type': 'Program-Specific',
          'Question #': r.questionNumber || '',
          'Question': r.question || '',
          'AI Answer': r.aiAnswer || '',
          'Confidence': r.confidence || '',
          'Evidence': r.evidence || '',
          'Reasoning': r.reasoning || '',
          'Page References': (r.pageReferences || []).join(', '),
          'Requires SAAT': r.requiresSAAT ? 'Yes' : 'No'
        })
      }
    }

    if (!hasData) {
      rows.push({
        'Application Number': app.applicationNumber,
        'Application Name': app.name,
        'Checklist Name': app.checklistName,
        'Type': '(No checklist data)',
        'Question #': '',
        'Question': '',
        'AI Answer': '',
        'Confidence': '',
        'Evidence': '',
        'Reasoning': '',
        'Page References': '',
        'Requires SAAT': ''
      })
    }
  }

  if (rows.length === 0) {
    throw new Error('No checklist comparison data found in any application.')
  }

  const ws = XLSX.utils.json_to_sheet(rows)
  autoFitColumns(ws, rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Checklist Comparison')
  XLSX.writeFile(wb, `Bulk_Export_Checklist_Comparison_${timestamp()}.xlsx`)
  return rows.length
}

/**
 * Extract application number from filename.
 * e.g. "HRSA-25-014_CEDAR-RIVERSIDE_Application-232640.pdf" → "232640"
 *      "Application-242645.pdf" → "242645"
 */
function extractApplicationNumber(filename) {
  const match = filename.match(/Application[- _]?(\d+)/i)
  return match ? match[1] : ''
}

/** Auto-fit column widths based on content */
function autoFitColumns(ws, rows) {
  if (!rows.length) return
  const keys = Object.keys(rows[0])
  ws['!cols'] = keys.map(key => {
    const maxLen = Math.max(
      key.length,
      ...rows.map(r => String(r[key] || '').length)
    )
    return { wch: Math.min(maxLen + 2, 60) }
  })
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
}
