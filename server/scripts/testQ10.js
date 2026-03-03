/**
 * Quick test: Hit the /api/qa-comparison/analyze endpoint for application 242764
 * and check Q10 answer + data conflicts.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '../..')

// Load the application data (same structure the UI sends)
const docJsonPath = join(ROOT, 'documents', 'f0e300bb-bb2f-4b5a-af61-ceddfead296f-HRSA-26-006_North Hudson Community Action Corporation_Application-242764.pdf.json')
const docData = JSON.parse(readFileSync(docJsonPath, 'utf-8'))

// Navigate to the actual analysis data
let applicationData = docData
if (docData.analysis?.data) {
  applicationData = docData.analysis.data
}

console.log(`Application data: ${applicationData.pages?.length || 0} pages`)

// Call the analyze endpoint
const response = await fetch('http://localhost:3002/api/qa-comparison/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ applicationData })
})

const result = await response.json()

if (!result.success) {
  console.error('❌ API error:', result.error, result.message)
  process.exit(1)
}

// Show Q10 result
const q10 = result.results?.find(r => r.questionNumber === 10)
if (q10) {
  console.log(`\n=== Q10 RESULT ===`)
  console.log(`Answer: ${q10.aiAnswer}`)
  console.log(`Confidence: ${q10.confidence}`)
  console.log(`Method: ${q10.method}`)
  console.log(`Evidence: ${q10.evidence}`)
  console.log(`Reasoning: ${q10.reasoning}`)
  console.log(`Pages: ${q10.pageReferences?.join(', ')}`)
} else {
  console.log('Q10 not found in results')
}

// Show data conflicts
if (result.dataConflicts?.length > 0) {
  console.log(`\n=== DATA CONFLICTS (${result.dataConflicts.length}) ===`)
  result.dataConflicts.forEach(c => {
    console.log(`  ${c.field}: ${c.message}`)
  })
} else {
  console.log('\nNo data conflicts detected')
}

// Show applicant profile SA IDs
if (result.applicantProfile) {
  console.log(`\n=== APPLICANT PROFILE ===`)
  console.log(`Primary SA ID: ${result.applicantProfile.serviceAreaId}`)
  console.log(`All SA IDs: ${JSON.stringify(result.applicantProfile.allServiceAreaIds)}`)
}

// Show SAAT info
if (result.saatInfo) {
  console.log(`\n=== SAAT INFO ===`)
  console.log(`Available: ${result.saatInfo.available}`)
  console.log(`Matched Area ID: ${result.saatInfo.matchedAreaId}`)
  console.log(`Match Method: ${result.saatInfo.matchMethod}`)
  if (result.saatInfo.saIdConflict) {
    console.log(`SA ID Conflict: ${JSON.stringify(result.saatInfo.saIdConflict)}`)
  }
}
