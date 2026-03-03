/**
 * Debug script: Call the /analyze endpoint and inspect what pages are sent to the AI.
 * Usage: node server/scripts/debugSaId.js [docJsonFilename]
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '../..')

const targetFile = process.argv[2] || 'cec5b57e-bec3-4376-8e69-c768384a2086-HRSA-26-006_GREEN RIVER MEDICAL CENTER_Application-242918.pdf.json'
const docJsonPath = join(ROOT, 'documents', targetFile)
const docData = JSON.parse(readFileSync(docJsonPath, 'utf-8'))

// Navigate nested structure to find pages
let applicationData = docData
if (docData.analysis?.data) applicationData = docData.analysis.data

const pages = applicationData.pages || []
console.log(`Total pages: ${pages.length}`)

// Show which pages mention Form 1A and what numbers are on them
console.log('\n=== Pages mentioning "Form 1A" ===')
for (const p of pages) {
  const pn = p.pageNumber || p.page || 0
  const text = (p.lines || []).map(l => l.content).join('\n')
  if (/Form\s*1A/i.test(text)) {
    const nums = text.match(/\b\d{3,6}\b/g)
    const hasPatient = /patient|unduplicated/i.test(text)
    console.log(`  Page ${pn}: hasPatientMention=${hasPatient}, numbers=${nums ? [...new Set(nums)].slice(0,10).join(',') : 'none'}`)
    // Check if this looks like a TOC page
    const formMentions = text.match(/\b(?:Form|Attachment|SF-424)\b/gi)
    if (formMentions && formMentions.length > 5) {
      console.log(`    ⚠️ Likely TOC page (${formMentions.length} form mentions)`)
    }
  }
}

// Show Summary Page content
console.log('\n=== Summary Page ===')
for (const p of pages) {
  const pn = p.pageNumber || p.page || 0
  const text = (p.lines || []).map(l => l.content).join('\n')
  if (/summary\s*page/i.test(text) && /patient\s*projection/i.test(text)) {
    console.log(`  Page ${pn}: Summary Page with Patient Projection`)
    const patientLines = text.match(/.*(?:patient\s*(?:projection|target)|unduplicated|1074|1084).*/gi)
    if (patientLines) patientLines.forEach(l => console.log(`    "${l.trim()}"`))
  }
}

// Show Form 1A tables (pages 140-142 area)
console.log('\n=== Tables with patient counts (>100) ===')
if (applicationData.tables) {
  for (const table of applicationData.tables) {
    const tPage = table.pageNumber || table.boundingRegions?.[0]?.pageNumber || 0
    const cells = table.cells || []
    const patientCells = cells.filter(c => {
      const v = parseInt((c.content || '').replace(/,/g, ''))
      return v >= 100 && /\d{3,}/.test(c.content || '')
    })
    if (patientCells.length > 0 && /patient|unduplicated/i.test(JSON.stringify(cells))) {
      console.log(`  Table on page ${tPage}:`)
      patientCells.forEach(c => console.log(`    Cell [${c.rowIndex},${c.columnIndex}]: "${c.content}"`))
    }
  }
}

// Now call the API and check Q11 result
console.log('\n=== Calling /api/qa-comparison/analyze ===')
const response = await fetch('http://localhost:3002/api/qa-comparison/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ applicationData })
})
const result = await response.json()
if (!result.success) {
  console.error('API error:', result.error, result.message)
  process.exit(1)
}

// Show Q10-Q16 results
for (let qn = 10; qn <= 16; qn++) {
  const q = result.results?.find(r => r.questionNumber === qn)
  if (q) {
    console.log(`\nQ${qn}: ${q.aiAnswer} (${q.confidence}, ${q.method})`)
    console.log(`  Evidence: ${q.evidence?.substring(0, 300)}...`)
    console.log(`  Pages: ${q.pageReferences?.join(', ')}`)
  }
}

// Show data conflicts
if (result.dataConflicts?.length > 0) {
  console.log(`\n=== DATA CONFLICTS (${result.dataConflicts.length}) ===`)
  result.dataConflicts.forEach(c => console.log(`  ${c.field}: ${c.message}`))
}

// Show applicant profile
console.log(`\n=== APPLICANT PROFILE ===`)
console.log(`  SA ID: ${result.applicantProfile?.serviceAreaId}`)
console.log(`  All SA IDs: ${JSON.stringify(result.applicantProfile?.allServiceAreaIds)}`)
console.log(`  Patient Projection: ${result.applicantProfile?.patientProjection}`)
console.log(`  All Patient Projections: ${JSON.stringify(result.applicantProfile?.allPatientProjections)}`)
console.log(`  Funding: ${result.applicantProfile?.fundingRequested}`)

// Show SAAT info
console.log(`\n=== SAAT INFO ===`)
console.log(`  Matched: ${result.saatInfo?.matchedAreaId}`)
console.log(`  Method: ${result.saatInfo?.matchMethod}`)
console.log(`  Patient Target: ${result.saatInfo?.patientTarget}`)
