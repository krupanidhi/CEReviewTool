/**
 * One-time script to extract FY24 checklist PDFs to structured JSON
 * via Azure Document Intelligence.
 */
import dotenv from 'dotenv'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '../../.env') })

import { analyzeDocumentEnhanced } from '../services/enhancedDocumentIntelligence.js'
import { transformToStructured } from '../services/structuredDocumentTransformer.js'

const fy24Dir = join(__dirname, '../../checklistQuestions/FY24')

async function extract(pdfName, jsonName) {
  const pdfPath = join(fy24Dir, pdfName)
  const jsonPath = join(fy24Dir, jsonName)
  const rawJsonPath = jsonPath.replace('_structured.json', '_extraction.json')

  console.log(`\nExtracting: ${pdfName}`)
  const pdfBuffer = await fs.readFile(pdfPath)
  console.log(`  PDF size: ${(pdfBuffer.length / 1024).toFixed(0)} KB`)

  const result = await analyzeDocumentEnhanced(pdfBuffer, 'application/pdf')
  console.log(`  DI extraction done`)

  const structured = transformToStructured(result.data)

  await fs.writeFile(rawJsonPath, JSON.stringify(result.data, null, 2))
  console.log(`  Raw saved: ${rawJsonPath}`)

  await fs.writeFile(jsonPath, JSON.stringify(structured, null, 2))
  console.log(`  Structured saved: ${jsonPath}`)
}

try {
  await extract('ProgramSpecificChecklist.pdf', 'ProgramSpecificQuestions_structured.json')
  await extract('StandardChecklist.pdf', 'StandardChecklist_structured.json')
  console.log('\n✅ FY24 extraction complete!')
} catch (err) {
  console.error('❌ Extraction failed:', err.message)
  process.exit(1)
}
