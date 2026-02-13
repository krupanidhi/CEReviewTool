import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SAAT_ROOT = join(__dirname, '../../SAAT')

/**
 * SAAT (Service Area Analysis Tool) Service
 * 
 * Reads SAAT CSV exports and provides structured data for QA comparison.
 * CSV files are organized by fiscal year: SAAT/<FY>/SAC-SAAT-Export-*.csv
 * 
 * Key data points per service area (announcement_number):
 * - patient_target: Total unduplicated patients projected
 * - service_type: Required service types (Medical, Dental, Mental Health, etc.)
 * - total_funding / chc/msaw/hp/rph funding breakdown
 * - zip codes with pct_patients for each
 */

/**
 * Derive fiscal year folder name from a Funding Opportunity Number.
 * e.g., "HRSA-26-004" → "FY26", "HRSA-25-001" → "FY25"
 * @param {string} fundingOppNumber - e.g., "HRSA-26-004"
 * @returns {string|null} e.g., "FY26" or null if cannot derive
 */
export function deriveFiscalYear(fundingOppNumber) {
  if (!fundingOppNumber) return null
  const match = fundingOppNumber.match(/HRSA-(\d{2})-/i)
  if (!match) return null
  return `FY${match[1]}`
}

/**
 * Parse a CSV string into an array of objects using the header row.
 * Handles quoted fields with commas and escaped quotes.
 * @param {string} csvText - Raw CSV content
 * @returns {Array<Object>} Parsed rows
 */
function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(line => line.trim())
  if (lines.length < 2) return []

  // Parse header
  const headers = parseCSVLine(lines[0])
  const rows = []

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    if (values.length === 0) continue
    const row = {}
    headers.forEach((header, idx) => {
      row[header.trim()] = (values[idx] || '').trim()
    })
    rows.push(row)
  }

  return rows
}

/**
 * Parse a single CSV line handling quoted fields with embedded commas and quotes.
 */
function parseCSVLine(line) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const nextChar = line[i + 1]

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        current += '"'
        i++ // skip escaped quote
      } else if (char === '"') {
        inQuotes = false
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        values.push(current)
        current = ''
      } else {
        current += char
      }
    }
  }
  values.push(current)
  return values
}

/**
 * Load SAAT data for a given fiscal year and optionally filter by announcement number.
 * @param {string} fiscalYear - e.g., "FY26"
 * @param {string} [announcementNumber] - e.g., "HRSA-26-004" to filter
 * @returns {Promise<Object>} Parsed SAAT data
 */
export async function loadSAATData(fiscalYear, announcementNumber = null) {
  const saatDir = join(SAAT_ROOT, fiscalYear)

  // Find CSV files in the fiscal year folder
  let files
  try {
    files = await fs.readdir(saatDir)
  } catch (err) {
    throw new Error(`SAAT folder not found: ${saatDir}. Expected structure: SAAT/${fiscalYear}/<csv files>`)
  }

  const csvFiles = files.filter(f => f.toLowerCase().endsWith('.csv'))
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found in ${saatDir}`)
  }

  // Read and parse all CSV files (there may be multiple exports)
  let allRows = []
  for (const csvFile of csvFiles) {
    const csvPath = join(saatDir, csvFile)
    const csvText = await fs.readFile(csvPath, 'utf-8')
    const rows = parseCSV(csvText)
    console.log(`📊 SAAT: Parsed ${rows.length} rows from ${csvFile}`)
    allRows.push(...rows)
  }

  // Filter by announcement number if provided
  if (announcementNumber) {
    allRows = allRows.filter(row =>
      (row.announcement_number || '').trim().toUpperCase() === announcementNumber.trim().toUpperCase()
    )
    console.log(`📊 SAAT: ${allRows.length} rows match announcement ${announcementNumber}`)
  }

  if (allRows.length === 0) {
    return {
      found: false,
      fiscalYear,
      announcementNumber,
      message: `No SAAT data found for ${announcementNumber || 'any announcement'} in ${fiscalYear}`
    }
  }

  // Aggregate data from rows
  return aggregateSAATData(allRows, fiscalYear, announcementNumber)
}

/**
 * Aggregate SAAT CSV rows into a structured summary for AI analysis.
 * Each row represents one zip code entry for a service area.
 */
function aggregateSAATData(rows, fiscalYear, announcementNumber) {
  // All rows for the same announcement share the same funding/target values
  const firstRow = rows[0]

  const patientTarget = parseInt(firstRow.patient_target) || 0
  const totalFunding = parseInt(firstRow.total_funding) || 0
  const chcFunding = parseInt(firstRow.chc_funding) || 0
  const msawFunding = parseInt(firstRow.msaw_funding) || 0
  const hpFunding = parseInt(firstRow.hp_funding) || 0
  const rphFunding = parseInt(firstRow.rph_funding) || 0

  // Collect unique service types
  const serviceTypesSet = new Set()
  rows.forEach(row => {
    const types = (row.service_type || '').split(',').map(t => t.trim()).filter(Boolean)
    types.forEach(t => serviceTypesSet.add(t))
  })
  const serviceTypes = [...serviceTypesSet].sort()

  // Collect zip codes with their patient percentages
  const zipEntries = rows
    .map(row => ({
      zip: (row.zip || '').trim(),
      pctPatients: parseFloat(row.pct_patients) || 0,
      highlight: (row.highlight || '').trim()
    }))
    .filter(z => z.zip)
    .sort((a, b) => b.pctPatients - a.pctPatients)

  // Unique zip codes
  const uniqueZips = [...new Set(zipEntries.map(z => z.zip))]

  // Determine funding distribution (which population types have non-zero funding)
  const fundingDistribution = []
  if (chcFunding > 0) fundingDistribution.push({ type: 'CHC', amount: chcFunding })
  if (msawFunding > 0) fundingDistribution.push({ type: 'MSAW', amount: msawFunding })
  if (hpFunding > 0) fundingDistribution.push({ type: 'HP', amount: hpFunding })
  if (rphFunding > 0) fundingDistribution.push({ type: 'RPH', amount: rphFunding })

  // Service area metadata
  const serviceAreaType = firstRow.service_area_type || ''
  const currentRecipient = firstRow.current_award_recipient || ''
  const city = firstRow.city || ''
  const state = firstRow.state || ''

  return {
    found: true,
    fiscalYear,
    announcementNumber: announcementNumber || firstRow.announcement_number,
    serviceArea: {
      city,
      state,
      type: serviceAreaType,
      currentRecipient
    },
    patientTarget,
    totalFunding,
    fundingBreakdown: {
      chc: chcFunding,
      msaw: msawFunding,
      hp: hpFunding,
      rph: rphFunding
    },
    fundingDistribution,
    serviceTypes,
    zipCodes: uniqueZips,
    zipDetails: zipEntries,
    totalZipCodes: uniqueZips.length,
    // Pre-computed values for Q11-Q15 validation
    validation: {
      // Q11: Is Form 1A patient count >= 75% of SAAT patient_target?
      q11_patientTarget: patientTarget,
      q11_75pctThreshold: Math.ceil(patientTarget * 0.75),
      // Q12: Does applicant propose all service types listed in SAAT?
      q12_requiredServiceTypes: serviceTypes,
      // Q13: Does requested funding NOT exceed SAAT total?
      q13_maxFunding: totalFunding,
      // Q14: Does applicant maintain funding distribution (CHC, MSAW, HP, RPH)?
      q14_fundingDistribution: fundingDistribution,
      // Q15: Does applicant propose to serve patients for each population type?
      q15_populationTypes: fundingDistribution.map(f => f.type)
    }
  }
}

/**
 * Build a human-readable SAAT summary for inclusion in AI prompts.
 * @param {Object} saatData - Output from loadSAATData
 * @returns {string} Formatted text summary
 */
export function buildSAATSummary(saatData) {
  if (!saatData || !saatData.found) {
    return 'SAAT DATA: Not available for this service area.'
  }

  const v = saatData.validation
  return `
=== SAAT (Service Area Analysis Tool) DATA ===
Announcement: ${saatData.announcementNumber}
Service Area: ${saatData.serviceArea.city}, ${saatData.serviceArea.state} (${saatData.serviceArea.type})
Current Award Recipient: ${saatData.serviceArea.currentRecipient}

PATIENT TARGET: ${saatData.patientTarget.toLocaleString()} unduplicated patients
  - 75% Threshold: ${v.q11_75pctThreshold.toLocaleString()} (Form 1A must show at least this many)

TOTAL FUNDING: $${saatData.totalFunding.toLocaleString()}
  - CHC: $${saatData.fundingBreakdown.chc.toLocaleString()}
  - MSAW: $${saatData.fundingBreakdown.msaw.toLocaleString()}
  - HP: $${saatData.fundingBreakdown.hp.toLocaleString()}
  - RPH: $${saatData.fundingBreakdown.rph.toLocaleString()}

REQUIRED SERVICE TYPES: ${saatData.serviceTypes.join(', ')}

FUNDING DISTRIBUTION (population types with non-zero funding):
${v.q14_fundingDistribution.map(f => `  - ${f.type}: $${f.amount.toLocaleString()}`).join('\n')}

ZIP CODES IN SERVICE AREA: ${saatData.totalZipCodes} zip codes
Top zip codes by patient percentage:
${saatData.zipDetails.slice(0, 10).map(z => `  - ${z.zip}: ${(z.pctPatients * 100).toFixed(1)}%`).join('\n')}
${saatData.totalZipCodes > 10 ? `  ... and ${saatData.totalZipCodes - 10} more` : ''}

=== VALIDATION CRITERIA FOR QUESTIONS 11-15 ===
Q11: Form 1A total unduplicated patients must be >= ${v.q11_75pctThreshold.toLocaleString()} (75% of SAAT target ${saatData.patientTarget.toLocaleString()})
Q12: Application must propose ALL of these service types: ${v.q12_requiredServiceTypes.join(', ')}
Q13: Requested annual SAC funding must NOT exceed $${v.q13_maxFunding.toLocaleString()}
Q14: Application must maintain funding distribution across: ${v.q15_populationTypes.join(', ')}
Q15: Application must propose to serve patients for each population type: ${v.q15_populationTypes.join(', ')}
=== END SAAT DATA ===
`.trim()
}

export default {
  deriveFiscalYear,
  loadSAATData,
  buildSAATSummary
}
