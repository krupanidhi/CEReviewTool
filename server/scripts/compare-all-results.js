#!/usr/bin/env node
/**
 * Compare AI Prefunding Results vs Manual Review Excel
 *
 * Reads per-application JSON files from pf-results/ (produced by combinedBatchPF.js)
 * and compares them against a manual review Excel file (SAC_PAR_Compliance*.xlsx).
 *
 * The manual Excel has columns: EHBTrackingNo | Question | Answer | Comment
 * (EHBTrackingNo = application number, same as applicationNumber in JSON)
 *
 * Output: Consolidated_Comparison_<timestamp>.xlsx with:
 *   - Master Summary sheet (per-app stats)
 *   - All Comparisons sheet (detailed row-by-row comparison)
 *
 * Usage:
 *   node server/scripts/compare-all-results.js
 *   (interactive prompts for folder paths)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'
import readline from 'readline'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function question(query) {
  return new Promise(resolve => rl.question(query, resolve))
}

const CONFIG = {
  MANUAL_EXCEL_DIR: '',
  AI_RESULTS_DIR: '',
  OUTPUT_DIR: ''
}

const logger = {
  log: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  success: (msg) => console.log(`[SUCCESS] ${msg}`),
  warning: (msg) => console.warn(`[WARNING] ${msg}`)
}

// ============================================================
// Find the SAC_PAR_Compliance Excel file dynamically
// ============================================================
function findManualExcelFile() {
  const files = fs.readdirSync(CONFIG.MANUAL_EXCEL_DIR)
  // Look for ManualReview_PF.xlsx first, then SAC_PAR_Compliance*.xlsx as fallback
  const excelFile = files.find(file =>
    file === 'ManualReview_PF.xlsx'
  ) || files.find(file =>
    file.startsWith('SAC_PAR_Compliance') && file.endsWith('.xlsx')
  )

  if (!excelFile) {
    throw new Error(`No ManualReview_PF.xlsx or SAC_PAR_Compliance*.xlsx file found in ${CONFIG.MANUAL_EXCEL_DIR}`)
  }

  const fullPath = path.join(CONFIG.MANUAL_EXCEL_DIR, excelFile)
  logger.log(`Found manual Excel file: ${excelFile}`)
  return fullPath
}

// ============================================================
// Element mapping: AI element names → Excel question format
// ============================================================
function mapAIElementToExcelQuestion(aiElement) {
  let cleanElement = aiElement.replace(/^REQUIREMENT \d+\.\d+:\s*/, '')
  cleanElement = cleanElement.replace(/^\d+\.\d+:\s*/, '')
  cleanElement = cleanElement.replace(/^\d+\.\d+\s*-\s*/, '')
  cleanElement = cleanElement.replace(/\s*\(FPG\)$/, '')
  cleanElement = cleanElement.replace(/\s*\(Not Applicable for Look-Alikes\)$/i, '')
  cleanElement = cleanElement.replace(/\s*\(Not Applicable for Look-alikes\)$/i, '')
  cleanElement = cleanElement.replace(/^Element ([a-h])\s*-\s*/, '$1. ')

  const fullMappings = {
    'Sliding Fee Discount Program Policies': 'b. Sliding Fee Discount Program Policies',
    'Sliding Fee for Column I Services': 'c. Sliding Fee for Column I Services',
    'Incorporation of Current Federal Poverty Guidelines': 'e. Incorporation of Current Federal Poverty Guidelines',
    'Documentation of Key Management Staff Positions': 'b. Documentation for Key Management Staff Positions',
    'b. Documentation of Key Management Staff Positions': 'b. Documentation for Key Management Staff Positions',
    'CEO Responsibilities': 'd. CEO Responsibilities',
    'HRSA Approval for Contracting Substantive Programmatic Work': 'e. HRSA Approval for Contracting Substantive Programmatic Work',
    'Required Contract Provisions': 'f. Required Contract Provisions',
    'HRSA Approval to Subaward': 'g. HRSA Approval to Subaward',
    'Subaward Agreement': 'h. Subaward Agreement',
    'Coordination and Integration of Activities': 'a. Coordination and Integration of Activities',
    'Collaboration with Other Primary Care Providers': 'b. Collaboration with Other Primary Care Providers',
    'Participation in Insurance Programs': 'c. Participation in Insurance Programs',
    'Policies or Procedures for Waiving or Reducing Fees': 'h. Policies or Procedures for Waiving or Reducing Fees',
    'Budgeting for Scope of Project': 'a. Annual Budgeting for Scope of Project',
    'a. Budgeting for Scope of Project': 'a. Annual Budgeting for Scope of Project',
    'Revenue Sources': 'b. Revenue Sources',
    'Maintenance of Board Authority Over Health Center Project': 'a. Maintenance of Board Authority Over Health Center Project',
    'Required Authorities and Responsibilities': 'b. Required Authorities and Responsibilities',
    'Board Member Selection and Removal Process': 'a. Board Member Selection and Removal Process',
    'Required Board Composition': 'b. Required Board Composition',
    'Current Board Composition': 'c. Current Board Composition',
    'Waiver Requests': 'e. Waiver Requests'
  }

  return fullMappings[cleanElement] || cleanElement
}

// ============================================================
// Load manual Excel file
// ============================================================
function loadManualExcel() {
  const manualExcelPath = findManualExcelFile()
  logger.log(`Loading manual Excel file: ${manualExcelPath}`)

  const workbook = new ExcelJS.Workbook()
  return workbook.xlsx.readFile(manualExcelPath).then(() => {
    const worksheet = workbook.getWorksheet('Sheet1')
    const manualData = {}

    // Detect column layout from header row
    const header1 = worksheet.getRow(1).getCell(1).value?.toString() || ''
    // ManualReview_PF.xlsx: AnnouncementNumber | EHBTrackingNo | Question | QuestionAnswer | Comment
    // SAC_PAR_Compliance:   EHBTrackingNo | Question | Answer | Comment
    const isManualReviewFormat = header1.toLowerCase().includes('announcement')
    const colOffset = isManualReviewFormat ? 1 : 0 // shift by 1 if AnnouncementNumber is col 1
    logger.log(`Excel format: ${isManualReviewFormat ? 'ManualReview_PF (5-col)' : 'SAC_PAR_Compliance (4-col)'}`)

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return // Skip header

      const appNumber = row.getCell(1 + colOffset).value?.toString()
      const question = row.getCell(2 + colOffset).value
      const answer = row.getCell(3 + colOffset).value
      const comment = row.getCell(4 + colOffset).value

      if (appNumber && question) {
        if (!manualData[appNumber]) {
          manualData[appNumber] = {}
        }
        manualData[appNumber][question] = {
          answer: answer,
          comment: comment
        }
      }
    })

    logger.success(`Loaded manual data for ${Object.keys(manualData).length} applications`)
    return manualData
  })
}

// ============================================================
// Find all AI result JSON files
// ============================================================
function findAIResultFiles() {
  const files = fs.readdirSync(CONFIG.AI_RESULTS_DIR)
  const jsonFiles = files.filter(file =>
    file.endsWith('.json') && !file.includes('batch_summary')
  )

  logger.log(`Found ${jsonFiles.length} AI result files`)
  return jsonFiles
}

// ============================================================
// Load AI results from JSON file
// ============================================================
function loadAIResults(filename) {
  const jsonPath = path.join(CONFIG.AI_RESULTS_DIR, filename)
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  return data
}

// ============================================================
// Normalize compliance status
// ============================================================
function normalizeStatus(status) {
  if (!status) return 'UNKNOWN'

  const statusStr = status.toString().trim()

  if (statusStr.startsWith('Yes,') || statusStr.startsWith('YES,')) {
    return 'COMPLIANT'
  }
  if (statusStr.startsWith('No,') || statusStr.startsWith('NO,')) {
    return 'NON-COMPLIANT'
  }

  const statusUpper = statusStr.toUpperCase()

  if (statusUpper.includes('YES') || statusUpper.includes('COMPLIANT') || statusUpper === 'C') {
    return 'COMPLIANT'
  }
  if (statusUpper.includes('NO') || statusUpper.includes('NON-COMPLIANT') || statusUpper.includes('NON COMPLIANT')) {
    return 'NON-COMPLIANT'
  }
  if (statusUpper.includes('N/A') || statusUpper.includes('NOT APPLICABLE')) {
    return 'NOT APPLICABLE'
  }

  return 'UNKNOWN'
}

// ============================================================
// Compare AI vs Manual results for a single application
// ============================================================
function compareApplication(aiResults, manualData, appNumber) {
  const comparison = []
  let totalElements = 0
  let matchingElements = 0
  let mismatchElements = 0
  let missingInAI = 0
  let missingInManual = 0

  const sections = aiResults.results || aiResults.sections || aiResults
  const appManualData = manualData[appNumber] || {}

  Object.keys(sections).forEach(section => {
    const sectionData = sections[section]

    if (sectionData.error) {
      logger.warning(`Section ${section} has error: ${sectionData.error}`)
      return
    }

    // Process each status category
    const categories = [
      { items: sectionData.compliantItems, aiStatus: 'COMPLIANT' },
      { items: sectionData.nonCompliantItems, aiStatus: 'NON-COMPLIANT' },
      { items: sectionData.notApplicableItems, aiStatus: 'NOT APPLICABLE' }
    ]

    for (const { items, aiStatus } of categories) {
      if (!items) continue
      for (const item of items) {
        const aiElement = item.element

        // Skip excluded elements
        if (aiElement === 'Element b - Update of Needs Assessment') continue

        totalElements++
        const aiReasoning = item.reasoning || ''
        const aiEvidence = item.evidence || ''

        const manualQuestion = mapAIElementToExcelQuestion(aiElement)
        const manualEntry = appManualData[manualQuestion]

        if (manualEntry) {
          const manualStatus = normalizeStatus(manualEntry.answer)
          const match = aiStatus === manualStatus

          if (match) matchingElements++
          else mismatchElements++

          comparison.push({
            applicationNumber: appNumber,
            section,
            element: aiElement,
            aiStatus,
            manualStatus,
            match: match ? 'MATCH' : 'MISMATCH',
            aiReasoning,
            aiEvidence,
            manualComment: manualEntry.comment || '',
            notes: match ? '' : `AI: ${aiStatus}, Manual: ${manualStatus}`
          })
        } else {
          missingInManual++
          comparison.push({
            applicationNumber: appNumber,
            section,
            element: aiElement,
            aiStatus,
            manualStatus: 'NOT FOUND',
            match: 'MISSING IN MANUAL',
            aiReasoning,
            aiEvidence,
            manualComment: '',
            notes: 'Element not found in manual Excel'
          })
        }
      }
    }
  })

  const successRate = totalElements > 0 ? ((matchingElements / totalElements) * 100).toFixed(1) : '0.0'

  return {
    comparison,
    stats: {
      totalElements,
      matchingElements,
      mismatchElements,
      missingInAI,
      missingInManual,
      successRate
    }
  }
}

// ============================================================
// Generate consolidated Excel report
// ============================================================
async function generateConsolidatedReport(allComparisons, allStats) {
  const workbook = new ExcelJS.Workbook()

  // ---- Master Summary sheet ----
  const summarySheet = workbook.addWorksheet('Master Summary')
  summarySheet.columns = [
    { header: 'Application Number', key: 'appNumber', width: 20 },
    { header: 'Total Elements', key: 'totalElements', width: 15 },
    { header: 'Matches', key: 'matches', width: 12 },
    { header: 'Mismatches', key: 'mismatches', width: 12 },
    { header: 'Missing in AI', key: 'missingAI', width: 15 },
    { header: 'Missing in Manual', key: 'missingManual', width: 18 },
    { header: 'Success Rate (%)', key: 'successRate', width: 18 }
  ]

  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  summarySheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  }

  Object.keys(allStats).forEach(appNumber => {
    const stats = allStats[appNumber]
    const row = summarySheet.addRow({
      appNumber: appNumber,
      totalElements: stats.totalElements,
      matches: stats.matchingElements,
      mismatches: stats.mismatchElements,
      missingAI: stats.missingInAI,
      missingManual: stats.missingInManual,
      successRate: stats.successRate
    })

    const successRateCell = row.getCell('successRate')
    const rate = parseFloat(stats.successRate)
    if (rate >= 90) {
      successRateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B050' } }
    } else if (rate >= 70) {
      successRateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } }
    } else {
      successRateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }
      successRateCell.font = { color: { argb: 'FFFFFFFF' } }
    }
  })

  const totalApps = Object.keys(allStats).length
  const avgSuccessRate = (Object.values(allStats).reduce((sum, s) => sum + parseFloat(s.successRate), 0) / totalApps).toFixed(1)

  summarySheet.addRow([])
  summarySheet.addRow(['Overall Statistics'])
  summarySheet.addRow(['Total Applications', totalApps])
  summarySheet.addRow(['Average Success Rate', `${avgSuccessRate}%`])

  // ---- All Comparisons sheet ----
  const detailSheet = workbook.addWorksheet('All Comparisons')
  detailSheet.columns = [
    { header: 'Application Number', key: 'applicationNumber', width: 20 },
    { header: 'Section', key: 'section', width: 30 },
    { header: 'Element', key: 'element', width: 50 },
    { header: 'AI Status', key: 'aiStatus', width: 18 },
    { header: 'Manual Status', key: 'manualStatus', width: 18 },
    { header: 'Match Status', key: 'match', width: 18 },
    { header: 'AI Reasoning', key: 'aiReasoning', width: 60 },
    { header: 'AI Evidence', key: 'aiEvidence', width: 60 },
    { header: 'Manual Comment', key: 'manualComment', width: 60 },
    { header: 'Notes', key: 'notes', width: 40 }
  ]

  detailSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  detailSheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  }

  detailSheet.autoFilter = {
    from: 'A1',
    to: 'J1'
  }

  allComparisons.forEach(item => {
    const row = detailSheet.addRow(item)

    const matchCell = row.getCell('match')
    if (item.match === 'MATCH') {
      matchCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B050' } }
      matchCell.font = { color: { argb: 'FFFFFFFF' }, bold: true }
    } else if (item.match === 'MISMATCH') {
      matchCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }
      matchCell.font = { color: { argb: 'FFFFFFFF' }, bold: true }
    } else {
      matchCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } }
      matchCell.font = { bold: true }
    }
  })

  if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
  const reportPath = path.join(CONFIG.OUTPUT_DIR, `Consolidated_Comparison_${timestamp}.xlsx`)

  await workbook.xlsx.writeFile(reportPath)
  return reportPath
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  try {
    console.log('\n========================================')
    console.log('HRSA Compliance - AI vs Manual Comparison')
    console.log('(CEReviewTool Prefunding Results)')
    console.log('========================================\n')

    // Default AI results dir
    const defaultAIDir = path.join(__dirname, '../../pf-results')

    // Get manual Excel directory
    const manualExcelDir = await question('Enter the folder path containing the manual Excel file (ManualReview_PF.xlsx): ')
    if (!fs.existsSync(manualExcelDir)) {
      logger.error(`Folder not found: ${manualExcelDir}`)
      rl.close()
      process.exit(1)
    }
    CONFIG.MANUAL_EXCEL_DIR = manualExcelDir

    // Get AI results directory
    const aiResultsDir = await question(`Enter the folder path containing AI result JSON files [${defaultAIDir}]: `) || defaultAIDir
    if (!fs.existsSync(aiResultsDir)) {
      logger.error(`Folder not found: ${aiResultsDir}`)
      rl.close()
      process.exit(1)
    }
    CONFIG.AI_RESULTS_DIR = aiResultsDir

    // Get output directory
    const defaultOutputDir = path.join(__dirname, '../../pf-comparison-output')
    const outputDir = await question(`Enter the folder path for comparison output [${defaultOutputDir}]: `) || defaultOutputDir
    CONFIG.OUTPUT_DIR = outputDir

    console.log('\n')
    logger.log('Starting consolidated comparison for all applications')
    logger.log('============================================================')
    logger.log(`Manual Excel Directory: ${CONFIG.MANUAL_EXCEL_DIR}`)
    logger.log(`AI Results Directory: ${CONFIG.AI_RESULTS_DIR}`)
    logger.log(`Output Directory: ${CONFIG.OUTPUT_DIR}`)
    logger.log('============================================================')

    // Load manual Excel data
    const manualData = await loadManualExcel()

    // Find all AI result files
    const aiFiles = findAIResultFiles()

    if (aiFiles.length === 0) {
      logger.error('No AI result files found')
      rl.close()
      process.exit(1)
    }

    const allComparisons = []
    const allStats = {}

    // Process each AI result file
    for (const filename of aiFiles) {
      logger.log(`Processing ${filename}...`)

      const aiResults = loadAIResults(filename)
      const appNumber = aiResults.applicationNumber

      if (!appNumber) {
        logger.warning(`No application number found in ${filename}, skipping`)
        continue
      }

      const { comparison, stats } = compareApplication(aiResults, manualData, appNumber)

      allComparisons.push(...comparison)
      allStats[appNumber] = stats

      logger.success(`Application ${appNumber}: ${stats.matchingElements}/${stats.totalElements} matches (${stats.successRate}% success rate)`)
    }

    // Generate consolidated report
    logger.log('Generating consolidated Excel report...')
    const reportPath = await generateConsolidatedReport(allComparisons, allStats)
    logger.success(`Consolidated report generated: ${reportPath}`)

    logger.log('============================================================')
    logger.log('CONSOLIDATED COMPARISON SUMMARY:')
    logger.log(`Total Applications Processed: ${Object.keys(allStats).length}`)

    Object.keys(allStats).forEach(appNumber => {
      const stats = allStats[appNumber]
      logger.log(`  ${appNumber}: ${stats.matchingElements}/${stats.totalElements} matches (${stats.successRate}%)`)
    })

    const avgSuccessRate = (Object.values(allStats).reduce((sum, s) => sum + parseFloat(s.successRate), 0) / Object.keys(allStats).length).toFixed(1)
    logger.log(`Average Success Rate: ${avgSuccessRate}%`)
    logger.log('============================================================')
    logger.success(`Report saved to: ${reportPath}`)

    rl.close()
  } catch (error) {
    logger.error(`Error during consolidated comparison: ${error.message}`)
    console.error(error)
    rl.close()
    process.exit(1)
  }
}

main()

export { loadManualExcel, loadAIResults, compareApplication, generateConsolidatedReport }
