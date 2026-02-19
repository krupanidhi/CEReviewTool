/**
 * generateComparisonExcel.js
 *
 * Generates a new Excel workbook that merges:
 *   - Manual answers from checklistQuestions/FY26/<manual-excel>.xlsx
 *   - AI answers from processed-applications/ JSON files
 *
 * Output columns:
 *   announcementnumber | ApplicationTrackingNo | questionNumber | Questiontext | AI | Manual | Match Status | Reasoning | comments | Form | ...
 *
 * "Manual"       = the human reviewer answer from the original Excel
 * "Match Status" = Match / Mismatch / Missing in Manual / Missing in AI
 *
 * Matching: AI answers are matched to manual answers by EXACT questionNumber + Form (standard/program).
 * Output is sorted by: announcementnumber, ApplicationTrackingNo, questionNumber, Form.
 *
 * Usage:
 *   node server/scripts/generateComparisonExcel.js
 *   node server/scripts/generateComparisonExcel.js --source checklistQuestions/FY26/MyFile.xlsx
 *   node server/scripts/generateComparisonExcel.js --output path/to/output.xlsx
 *   node server/scripts/generateComparisonExcel.js --app 243164          # single application
 *   node server/scripts/generateComparisonExcel.js --nofo HRSA-26-006   # filter by NOFO
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import ExcelJS from 'exceljs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CE_ROOT = path.resolve(__dirname, '../..')
const CHECKLIST_QUESTIONS_DIR = path.join(CE_ROOT, 'checklistQuestions')
const PROCESSED_APPS_DIR = path.join(CE_ROOT, 'processed-applications')
const DEFAULT_SOURCE = path.join(CHECKLIST_QUESTIONS_DIR, 'FY26', 'HRSA-26-006 Manual CE Review.xlsx')
const DEFAULT_OUTPUT = path.join(CHECKLIST_QUESTIONS_DIR, 'ChecklistComparision.xlsx')

// ── CLI args ──────────────────────────────────────────────────────────────────
function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null
}

const sourceExcel = getArg('source') ? path.resolve(CE_ROOT, getArg('source')) : DEFAULT_SOURCE
const outputPath = getArg('output') ? path.resolve(CE_ROOT, getArg('output')) : DEFAULT_OUTPUT
const filterApp = getArg('app')       // e.g. 243164
const filterNofo = getArg('nofo')     // e.g. HRSA-26-006

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize answer text for comparison: lowercase, trim, collapse whitespace */
function normalizeAnswer(ans) {
  if (ans == null) return ''
  return String(ans).trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Extract tracking number from a filename like "..._Application-242656.pdf..." */
function extractTrackingNo(filename) {
  const m = filename.match(/Application[_-](\d{5,7})/i)
  return m ? m[1] : null
}

/**
 * Compare two answers. Returns 'Match' if they agree, 'Mismatch' if they differ.
 */
function compareAnswers(aiAnswer, manualAnswer) {
  const ai = normalizeAnswer(aiAnswer)
  const manual = normalizeAnswer(manualAnswer)

  if (!ai || !manual) return null // caller handles Missing in AI / Missing in Manual
  if (ai === manual) return 'Match'

  // Handle common equivalences
  const yesSet = new Set(['yes', 'y', 'true', '1'])
  const noSet = new Set(['no', 'n', 'false', '0'])
  const naSet = new Set(['n/a', 'na', 'not applicable', '-', 'null'])

  const aiGroup = yesSet.has(ai) ? 'yes' : noSet.has(ai) ? 'no' : naSet.has(ai) ? 'na' : ai
  const manualGroup = yesSet.has(manual) ? 'yes' : noSet.has(manual) ? 'no' : naSet.has(manual) ? 'na' : manual

  if (aiGroup === manualGroup) return 'Match'
  return 'Mismatch'
}

// ── Load AI answers from processed-applications ──────────────────────────────

async function loadAIAnswers() {
  const aiMap = new Map() // key: trackingNo → { standard: [...], programSpecific: [...] }

  let files
  try {
    files = await fs.readdir(PROCESSED_APPS_DIR)
  } catch {
    console.error(`❌ Cannot read processed-applications directory: ${PROCESSED_APPS_DIR}`)
    return aiMap
  }

  // Prefer _checklist_comparison.json files (simpler structure)
  const compFiles = files.filter(f => f.endsWith('_checklist_comparison.json'))
  // Fallback: app_*.json files
  const appFiles = files.filter(f => f.startsWith('app_') && f.endsWith('.json') && f !== 'index.json')

  // Track which tracking numbers we've already loaded
  const loaded = new Set()

  // Load from _checklist_comparison.json first
  for (const file of compFiles) {
    const trackNo = extractTrackingNo(file)
    if (!trackNo) continue
    if (filterApp && trackNo !== filterApp) continue

    try {
      const data = JSON.parse(await fs.readFile(path.join(PROCESSED_APPS_DIR, file), 'utf8'))
      const stdResults = data.standard?.results || []
      const psResults = data.programSpecific?.results || []

      aiMap.set(trackNo, {
        standard: stdResults,
        programSpecific: psResults,
        source: file
      })
      loaded.add(trackNo)
    } catch (err) {
      console.warn(`⚠️  Could not parse ${file}: ${err.message}`)
    }
  }

  // Load from app_*.json for any tracking numbers not yet loaded
  for (const file of appFiles) {
    const trackNo = extractTrackingNo(file)
    if (!trackNo || loaded.has(trackNo)) continue
    if (filterApp && trackNo !== filterApp) continue

    try {
      const data = JSON.parse(await fs.readFile(path.join(PROCESSED_APPS_DIR, file), 'utf8'))
      const cc = data.checklistComparison || {}
      const stdResults = cc.standard?.results || []
      const psResults = cc.programSpecific?.results || []

      if (stdResults.length > 0 || psResults.length > 0) {
        aiMap.set(trackNo, {
          standard: stdResults,
          programSpecific: psResults,
          source: file
        })
        loaded.add(trackNo)
      }
    } catch (err) {
      console.warn(`⚠️  Could not parse ${file}: ${err.message}`)
    }
  }

  return aiMap
}

/**
 * Find AI answer by EXACT questionNumber match.
 * aiResults is the array for the correct form type (standard or programSpecific).
 */
function findAIAnswer(aiResults, questionNumber) {
  if (!aiResults || aiResults.length === 0 || questionNumber == null) return null
  return aiResults.find(r => r.questionNumber === questionNumber) || null
}

/**
 * Determine which form category a Form string belongs to.
 * Returns 'standard' or 'program'.
 */
function formCategory(form) {
  return String(form || '').toLowerCase().includes('standard') ? 'standard' : 'program'
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  CE Review — Checklist Comparison Excel Generator')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`📂 Source Excel:    ${sourceExcel}`)
  console.log(`📂 Processed Apps:  ${PROCESSED_APPS_DIR}`)
  console.log(`📄 Output:          ${outputPath}`)
  if (filterApp) console.log(`🔍 Filter app:      ${filterApp}`)
  if (filterNofo) console.log(`🔍 Filter NOFO:     ${filterNofo}`)
  console.log('')

  // 1. Load AI answers
  console.log('📥 Loading AI answers from processed applications...')
  const aiMap = await loadAIAnswers()
  console.log(`   Found AI results for ${aiMap.size} application(s)`)
  for (const [trackNo, data] of aiMap) {
    console.log(`   - ${trackNo}: ${data.standard.length} standard + ${data.programSpecific.length} program-specific questions (${data.source})`)
  }

  if (aiMap.size === 0) {
    console.error('❌ No AI answers found in processed-applications. Run checklist comparison first.')
    process.exit(1)
  }

  // 2. Read source Excel
  // Source columns: Col1=announcementnumber, Col2=ApplicationTrackingNo, Col3=questionNumber,
  //                 Col4=Questiontext, Col5=Answer, Col6=comments, Col7=Form
  console.log('\n📥 Reading source Excel...')
  const sourceWb = new ExcelJS.Workbook()
  await sourceWb.xlsx.readFile(sourceExcel)
  const sourceWs = sourceWb.worksheets[0]
  console.log(`   Sheet: "${sourceWs.name}" — ${sourceWs.rowCount} rows, ${sourceWs.columnCount} columns`)

  // 3. Build manual answers lookup: trackingNo → [ { ... } ]
  const manualMap = new Map()
  for (let r = 2; r <= sourceWs.rowCount; r++) {
    const row = sourceWs.getRow(r)
    const announcementNumber = row.getCell(1).value ? String(row.getCell(1).value).trim() : ''
    const trackingNo = row.getCell(2).value ? String(row.getCell(2).value).trim() : ''
    const questionNumber = row.getCell(3).value != null ? Number(row.getCell(3).value) : null
    const questionText = row.getCell(4).value ? String(row.getCell(4).value) : ''
    const manualAnswer = row.getCell(5).value ? String(row.getCell(5).value).trim() : ''
    const comments = row.getCell(6).value ? String(row.getCell(6).value) : ''
    const form = row.getCell(7).value ? String(row.getCell(7).value).trim() : ''

    if (filterNofo && announcementNumber !== filterNofo) continue
    if (filterApp && trackingNo !== filterApp) continue
    if (!trackingNo) continue

    if (!manualMap.has(trackingNo)) manualMap.set(trackingNo, [])
    manualMap.get(trackingNo).push({ announcementNumber, trackingNo, questionNumber, questionText, manualAnswer, comments, form })
  }
  console.log(`   Manual Excel: ${manualMap.size} unique application(s) after filters`)

  // 4. Merge both directions into a flat rows array, then sort
  const outputRows = [] // collect all rows before writing (for sorting)
  let countMatch = 0
  let countMismatch = 0
  let countMissingInManual = 0
  let countMissingInAI = 0

  // Collect all unique tracking numbers from both sources
  const allTrackingNos = new Set([...manualMap.keys(), ...aiMap.keys()])

  for (const trackNo of allTrackingNos) {
    if (filterApp && trackNo !== filterApp) continue

    const manualRows = manualMap.get(trackNo) || []
    const aiData = aiMap.get(trackNo)
    const hasManual = manualRows.length > 0
    const hasAI = !!aiData

    // Track which AI questions have been matched (to find AI-only questions later)
    const matchedAIStandard = new Set()
    const matchedAIProgramSpecific = new Set()

    // --- Process manual rows first ---
    for (const mRow of manualRows) {
      const isStandard = formCategory(mRow.form) === 'standard'
      const aiResults = hasAI ? (isStandard ? aiData.standard : aiData.programSpecific) : []
      const matchedSet = isStandard ? matchedAIStandard : matchedAIProgramSpecific

      // Match by EXACT questionNumber
      const aiResult = findAIAnswer(aiResults, mRow.questionNumber)

      const aiAnswer = aiResult?.aiAnswer || ''
      const aiConfidence = aiResult?.confidence || ''
      const aiEvidence = aiResult?.evidence || ''
      const aiReasoning = aiResult?.reasoning || ''
      const aiPageRefs = aiResult?.pageReferences?.join(', ') || ''

      if (aiResult) matchedSet.add(aiResult.questionNumber)

      // Determine Match Status
      let matchStatus
      if (!hasAI || !aiResult) {
        matchStatus = 'Missing in AI'
        countMissingInAI++
      } else {
        const cmp = compareAnswers(aiAnswer, mRow.manualAnswer)
        matchStatus = cmp || 'Mismatch'
        if (matchStatus === 'Match') countMatch++
        else countMismatch++
      }

      outputRows.push({
        announcementnumber: mRow.announcementNumber,
        ApplicationTrackingNo: trackNo,
        questionNumber: mRow.questionNumber,
        Questiontext: mRow.questionText.replace(/<br\s*\/?>/gi, '\n'),
        AI: aiAnswer,
        Manual: mRow.manualAnswer,
        MatchStatus: matchStatus,
        Reasoning: aiReasoning,
        comments: mRow.comments === 'NULL' ? '' : mRow.comments,
        Form: mRow.form,
        AI_Confidence: aiConfidence,
        AI_Evidence: aiEvidence,
        AI_PageRefs: aiPageRefs,
      })
    }

    // --- Now add AI-only questions (Missing in Manual) ---
    if (hasAI) {
      const announcementNumber = manualRows[0]?.announcementNumber || ''

      for (const [formLabel, aiResults, matchedSet] of [
        ['Standard Check list', aiData.standard, matchedAIStandard],
        ['Program Check List', aiData.programSpecific, matchedAIProgramSpecific]
      ]) {
        for (const aiResult of aiResults) {
          if (matchedSet.has(aiResult.questionNumber)) continue

          countMissingInManual++

          outputRows.push({
            announcementnumber: announcementNumber,
            ApplicationTrackingNo: trackNo,
            questionNumber: aiResult.questionNumber,
            Questiontext: (aiResult.question || '').replace(/<br\s*\/?>/gi, '\n'),
            AI: aiResult.aiAnswer || '',
            Manual: '',
            MatchStatus: 'Missing in Manual',
            Reasoning: aiResult.reasoning || '',
            comments: '',
            Form: formLabel,
            AI_Confidence: aiResult.confidence || '',
            AI_Evidence: aiResult.evidence || '',
            AI_PageRefs: aiResult.pageReferences?.join(', ') || '',
          })
        }
      }
    }
  }

  // 5. Sort rows by announcementnumber, ApplicationTrackingNo, questionNumber, Form
  const formOrder = { 'standard check list': 0, 'program check list': 1 }
  outputRows.sort((a, b) => {
    // announcementnumber
    const annCmp = String(a.announcementnumber).localeCompare(String(b.announcementnumber))
    if (annCmp !== 0) return annCmp
    // ApplicationTrackingNo (numeric)
    const trackA = parseInt(a.ApplicationTrackingNo) || 0
    const trackB = parseInt(b.ApplicationTrackingNo) || 0
    if (trackA !== trackB) return trackA - trackB
    // Form (standard first, then program)
    const formA = formOrder[String(a.Form).toLowerCase()] ?? 2
    const formB = formOrder[String(b.Form).toLowerCase()] ?? 2
    if (formA !== formB) return formA - formB
    // questionNumber (numeric)
    const qA = a.questionNumber ?? 9999
    const qB = b.questionNumber ?? 9999
    return qA - qB
  })

  const totalRows = outputRows.length
  console.log(`   Total merged rows: ${totalRows} (sorted by announcementnumber, ApplicationTrackingNo, questionNumber, Form)`)

  // 6. Create output workbook and write sorted rows
  const outWb = new ExcelJS.Workbook()
  outWb.creator = 'CE Review Tool'
  outWb.created = new Date()

  const outWs = outWb.addWorksheet('Comparison')

  outWs.columns = [
    { header: 'announcementnumber', key: 'announcementnumber', width: 18 },
    { header: 'ApplicationTrackingNo', key: 'ApplicationTrackingNo', width: 22 },
    { header: 'questionNumber', key: 'questionNumber', width: 14 },
    { header: 'Questiontext', key: 'Questiontext', width: 80 },
    { header: 'AI', key: 'AI', width: 10 },
    { header: 'Manual', key: 'Manual', width: 10 },
    { header: 'Match Status', key: 'MatchStatus', width: 18 },
    { header: 'Reasoning', key: 'Reasoning', width: 60 },
    { header: 'comments', key: 'comments', width: 30 },
    { header: 'Form', key: 'Form', width: 22 },
    { header: 'AI_Confidence', key: 'AI_Confidence', width: 14 },
    { header: 'AI_Evidence', key: 'AI_Evidence', width: 60 },
    { header: 'AI_PageRefs', key: 'AI_PageRefs', width: 14 },
  ]

  // Style header row
  const headerRow = outWs.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B4778' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }

  // Write sorted rows
  for (const rowData of outputRows) {
    const outRow = outWs.addRow(rowData)
    styleMatchStatusCell(outRow, rowData.MatchStatus)
  }

  /** Apply conditional formatting to the Match Status cell */
  function styleMatchStatusCell(outRow, matchStatus) {
    const cell = outRow.getCell('MatchStatus')
    if (matchStatus === 'Match') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } }
      cell.font = { color: { argb: 'FF006100' }, bold: true }
    } else if (matchStatus === 'Mismatch') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }
      cell.font = { color: { argb: 'FF9C0006' }, bold: true }
      outRow.getCell('AI').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }
      outRow.getCell('Manual').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }
    } else if (matchStatus === 'Missing in AI') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFCC' } }
      cell.font = { color: { argb: 'FF9C6500' }, bold: true }
    } else if (matchStatus === 'Missing in Manual') {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }
      cell.font = { color: { argb: 'FF1F4E79' }, bold: true }
    }
  }

  // 7. Add summary sheet
  const summaryWs = outWb.addWorksheet('Summary')
  summaryWs.columns = [
    { header: 'Metric', key: 'metric', width: 40 },
    { header: 'Value', key: 'value', width: 20 },
  ]
  const summaryHeaderRow = summaryWs.getRow(1)
  summaryHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  summaryHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B4778' } }

  summaryWs.addRow({ metric: 'Generated At', value: new Date().toISOString() })
  summaryWs.addRow({ metric: 'Source Excel', value: sourceExcel })
  summaryWs.addRow({ metric: 'Applications in AI', value: aiMap.size })
  summaryWs.addRow({ metric: 'Applications in Manual Excel', value: manualMap.size })
  summaryWs.addRow({ metric: 'Total Rows in Output', value: totalRows })
  summaryWs.addRow({ metric: '', value: '' })
  summaryWs.addRow({ metric: 'Match (AI agrees with Manual)', value: countMatch })
  summaryWs.addRow({ metric: 'Mismatch (AI disagrees with Manual)', value: countMismatch })
  summaryWs.addRow({ metric: 'Missing in AI (question not in AI results)', value: countMissingInAI })
  summaryWs.addRow({ metric: 'Missing in Manual (question not in manual Excel)', value: countMissingInManual })
  const comparable = countMatch + countMismatch
  const accuracy = comparable > 0 ? ((countMatch / comparable) * 100).toFixed(1) : 'N/A'
  summaryWs.addRow({ metric: 'Agreement Rate (Match / (Match+Mismatch))', value: `${accuracy}%` })

  // Per-application breakdown
  summaryWs.addRow({ metric: '', value: '' })
  summaryWs.addRow({ metric: '── Per Application Breakdown ──', value: '' })
  for (const trackNo of allTrackingNos) {
    if (filterApp && trackNo !== filterApp) continue
    let appMatch = 0, appMismatch = 0, appMissingAI = 0, appMissingManual = 0
    for (const r of outputRows) {
      if (r.ApplicationTrackingNo !== trackNo) continue
      if (r.MatchStatus === 'Match') appMatch++
      else if (r.MatchStatus === 'Mismatch') appMismatch++
      else if (r.MatchStatus === 'Missing in AI') appMissingAI++
      else if (r.MatchStatus === 'Missing in Manual') appMissingManual++
    }
    const appComparable = appMatch + appMismatch
    const appAcc = appComparable > 0 ? ((appMatch / appComparable) * 100).toFixed(1) : 'N/A'
    summaryWs.addRow({ metric: `  App ${trackNo}`, value: `${appMatch}/${appComparable} match (${appAcc}%) — ${appMissingAI} missing in AI, ${appMissingManual} missing in manual` })
  }

  // 8. Save
  const outputDir = path.dirname(outputPath)
  await fs.mkdir(outputDir, { recursive: true })
  await outWb.xlsx.writeFile(outputPath)

  // 9. Print summary
  console.log('\n═══════════════════════════════════════════════════════════')
  console.log('  Results')
  console.log('═══════════════════════════════════════════════════════════')
  console.log(`📊 Total rows:              ${totalRows}`)
  console.log(`✅ Match:                   ${countMatch}`)
  console.log(`❌ Mismatch:                ${countMismatch}`)
  console.log(`⚠️  Missing in AI:           ${countMissingInAI}`)
  console.log(`⚠️  Missing in Manual:       ${countMissingInManual}`)
  console.log(`📈 Agreement Rate:          ${accuracy}%`)
  console.log(`\n💾 Output saved to: ${outputPath}`)
}

main().catch(err => {
  console.error('❌ Fatal error:', err)
  process.exit(1)
})
