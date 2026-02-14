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
 * Returns ALL service areas under the NOFO, grouped by service area ID.
 * The caller must match the applicant to the correct service area.
 * @param {string} fiscalYear - e.g., "FY26"
 * @param {string} [announcementNumber] - e.g., "HRSA-26-004" to filter
 * @returns {Promise<Object>} Parsed SAAT data with all service areas
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
      serviceAreas: [],
      matchedArea: null,
      message: `No SAAT data found for ${announcementNumber || 'any announcement'} in ${fiscalYear}`
    }
  }

  // Group rows by service area ID — each ID is a distinct service area
  const grouped = new Map()
  allRows.forEach(row => {
    const saId = (row.id || '').trim()
    if (!grouped.has(saId)) grouped.set(saId, [])
    grouped.get(saId).push(row)
  })

  // Build per-service-area summaries
  const serviceAreas = []
  for (const [saId, rows] of grouped) {
    serviceAreas.push(buildServiceAreaSummary(saId, rows))
  }

  console.log(`📊 SAAT: ${serviceAreas.length} distinct service areas found under ${announcementNumber || 'all announcements'}`)
  serviceAreas.forEach(sa => console.log(`   - SA ${sa.id}: ${sa.city}, ${sa.state} (${sa.type}) — ${sa.totalZipCodes} zips, target: ${sa.patientTarget}`))

  return {
    found: true,
    fiscalYear,
    announcementNumber: announcementNumber || allRows[0].announcement_number,
    serviceAreas,
    matchedArea: null // caller sets this after matching to applicant
  }
}

/**
 * Build a structured summary for a single SAAT service area.
 * @param {string} saId - Service area ID from CSV
 * @param {Array} rows - All CSV rows for this service area
 */
function buildServiceAreaSummary(saId, rows) {
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

  const uniqueZips = [...new Set(zipEntries.map(z => z.zip))]

  // Funding distribution
  const fundingDistribution = []
  if (chcFunding > 0) fundingDistribution.push({ type: 'CHC', amount: chcFunding })
  if (msawFunding > 0) fundingDistribution.push({ type: 'MSAW', amount: msawFunding })
  if (hpFunding > 0) fundingDistribution.push({ type: 'HP', amount: hpFunding })
  if (rphFunding > 0) fundingDistribution.push({ type: 'RPH', amount: rphFunding })

  return {
    id: saId,
    city: firstRow.city || '',
    state: firstRow.state || '',
    type: firstRow.service_area_type || '',
    currentRecipient: firstRow.current_award_recipient || '',
    grantNumber: firstRow.gn || '',
    patientTarget,
    totalFunding,
    fundingBreakdown: { chc: chcFunding, msaw: msawFunding, hp: hpFunding, rph: rphFunding },
    fundingDistribution,
    serviceTypes,
    zipCodes: uniqueZips,
    zipDetails: zipEntries,
    totalZipCodes: uniqueZips.length
  }
}

/**
 * Match the applicant to the correct SAAT service area using zip codes, city/state, or grant number.
 * @param {Object} saatData - Output from loadSAATData (contains serviceAreas array)
 * @param {Object} applicantProfile - Extracted from application (has zipCodesFromApp, organizationName, etc.)
 * @param {Object} applicationData - Full application data for deeper text search
 * @returns {Object} saatData with matchedArea set, plus matchMethod description
 */
export function matchApplicantToServiceArea(saatData, applicantProfile, applicationData) {
  if (!saatData?.found || !saatData.serviceAreas || saatData.serviceAreas.length === 0) {
    return saatData
  }

  const areas = saatData.serviceAreas

  // Strategy 1 (HIGHEST PRIORITY): Match by Service Area ID from actual forms (Summary Page, Form 1A)
  const appSaId = applicantProfile?.serviceAreaId
  if (appSaId) {
    // Clean the ID for comparison (remove asterisks, whitespace)
    const cleanAppId = appSaId.replace(/[*\s]/g, '')
    for (const area of areas) {
      const cleanAreaId = (area.id || '').replace(/[*\s]/g, '')
      if (cleanAreaId === cleanAppId) {
        saatData.matchedArea = area
        saatData.matchMethod = `Matched by Service Area ID: ${appSaId} (from application forms)`
        console.log(`📊 SAAT Match: SA ${area.id} (${area.city}, ${area.state}) — SA ID match`)
        return saatData
      }
    }
    console.log(`📊 SAAT: Applicant SA ID ${appSaId} not found in SAAT CSV (${areas.map(a => a.id).join(', ')})`)
  }

  // Strategy 2: Match by zip code overlap
  const appZips = new Set(applicantProfile?.zipCodesFromApp || [])
  if (appZips.size > 0) {
    let bestMatch = null
    let bestOverlap = 0
    for (const area of areas) {
      const overlap = area.zipCodes.filter(z => appZips.has(z)).length
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestMatch = area
      }
    }
    if (bestMatch && bestOverlap > 0) {
      saatData.matchedArea = bestMatch
      saatData.matchMethod = `Matched by ${bestOverlap} overlapping zip codes`
      console.log(`📊 SAAT Match: SA ${bestMatch.id} (${bestMatch.city}, ${bestMatch.state}) — ${bestOverlap} zip overlap`)
      return saatData
    }
  }

  // Strategy 3: Match by city/state from applicant profile first, then full text
  const appCity = applicantProfile?.serviceAreaCity
  const appState = applicantProfile?.serviceAreaState
  if (appCity && appState) {
    for (const area of areas) {
      if (area.city.toLowerCase() === appCity.toLowerCase() && area.state.toLowerCase() === appState.toLowerCase()) {
        saatData.matchedArea = area
        saatData.matchMethod = `Matched by service area city/state: ${appCity}, ${appState}`
        console.log(`📊 SAAT Match: SA ${area.id} (${area.city}, ${area.state}) — profile city/state match`)
        return saatData
      }
    }
  }

  // Strategy 4: Match by city/state from full application text
  const fullText = extractFullText(applicationData)
  for (const area of areas) {
    if (!area.city) continue
    const cityPattern = new RegExp(`\\b${escapeRegex(area.city)}\\b`, 'i')
    const statePattern = new RegExp(`\\b${escapeRegex(area.state)}\\b`, 'i')
    if (cityPattern.test(fullText) && statePattern.test(fullText)) {
      saatData.matchedArea = area
      saatData.matchMethod = `Matched by city/state in application text: ${area.city}, ${area.state}`
      console.log(`📊 SAAT Match: SA ${area.id} (${area.city}, ${area.state}) — text city/state match`)
      return saatData
    }
  }

  // Strategy 5: Match by grant number (gn field) in application text
  for (const area of areas) {
    if (area.grantNumber && fullText.includes(area.grantNumber)) {
      saatData.matchedArea = area
      saatData.matchMethod = `Matched by grant number: ${area.grantNumber}`
      console.log(`📊 SAAT Match: SA ${area.id} (${area.city}, ${area.state}) — grant number match`)
      return saatData
    }
  }

  // No match found — log details for debugging
  saatData.matchedArea = null
  saatData.matchMethod = `No match found — applicant SA ID: ${appSaId || 'not extracted'}, city: ${appCity || 'unknown'}, state: ${appState || 'unknown'} — SAAT has: ${areas.map(a => `${a.id}(${a.city},${a.state})`).join(', ')}`
  console.log(`📊 SAAT Match: NONE — applicant's service area not found in SAAT CSV`)
  return saatData
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractFullText(applicationData) {
  const parts = []
  if (applicationData?.pages) {
    applicationData.pages.slice(0, 20).forEach(p => {
      const text = p.lines?.map(l => l.content).join('\n') || ''
      if (text) parts.push(text)
    })
  }
  if (applicationData?.keyValuePairs) {
    applicationData.keyValuePairs.forEach(kv => {
      parts.push(`${kv.key || ''}: ${kv.value || ''}`)
    })
  }
  return parts.join('\n')
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

  const parts = []

  parts.push(`=== SAAT (Service Area Analysis Tool) DATA ===`)
  parts.push(`Announcement: ${saatData.announcementNumber}`)

  // Q10 context: list ALL service areas announced under this NOFO
  parts.push(`\nALL SERVICE AREAS ANNOUNCED UNDER THIS NOFO (${saatData.serviceAreas.length} total):`)
  parts.push(`(Q10: The applicant's proposed service area must be one of these to answer "Yes")`)
  saatData.serviceAreas.forEach(sa => {
    parts.push(`  - SA ID ${sa.id}: ${sa.city}, ${sa.state} (${sa.type}) — Grant: ${sa.grantNumber || 'N/A'}, Recipient: ${sa.currentRecipient || 'N/A'}`)
  })

  // Matched service area details (for Q11-Q16)
  const matched = saatData.matchedArea
  if (matched) {
    parts.push(`\n═══ MATCHED SERVICE AREA FOR THIS APPLICANT ═══`)
    parts.push(`Match Method: ${saatData.matchMethod}`)
    parts.push(`Service Area ID: ${matched.id}`)
    parts.push(`Location: ${matched.city}, ${matched.state} (${matched.type})`)
    parts.push(`Current Award Recipient: ${matched.currentRecipient}`)
    parts.push(`Grant Number: ${matched.grantNumber || 'N/A'}`)

    const threshold75 = Math.ceil(matched.patientTarget * 0.75)
    parts.push(`\nPATIENT TARGET: ${matched.patientTarget.toLocaleString()} unduplicated patients`)
    parts.push(`  - 75% Threshold: ${threshold75.toLocaleString()} (Form 1A must show at least this many)`)

    parts.push(`\nTOTAL FUNDING: $${matched.totalFunding.toLocaleString()}`)
    parts.push(`  - CHC: $${matched.fundingBreakdown.chc.toLocaleString()}`)
    parts.push(`  - MSAW: $${matched.fundingBreakdown.msaw.toLocaleString()}`)
    parts.push(`  - HP: $${matched.fundingBreakdown.hp.toLocaleString()}`)
    parts.push(`  - RPH: $${matched.fundingBreakdown.rph.toLocaleString()}`)

    parts.push(`\nREQUIRED SERVICE TYPES: ${matched.serviceTypes.join(', ')}`)

    parts.push(`\nFUNDING DISTRIBUTION (population types with non-zero funding):`)
    matched.fundingDistribution.forEach(f => parts.push(`  - ${f.type}: $${f.amount.toLocaleString()}`))

    parts.push(`\nZIP CODES IN SERVICE AREA: ${matched.totalZipCodes} zip codes`)
    parts.push(`All SAAT zip codes (sorted by patient percentage, descending):`)
    parts.push(buildZipCodeTable(matched.zipDetails))

    const popTypes = matched.fundingDistribution.map(f => f.type)
    parts.push(`\n=== VALIDATION CRITERIA FOR QUESTIONS 11-16 ===`)
    parts.push(`Q11: Form 1A total unduplicated patients must be >= ${threshold75.toLocaleString()} (75% of SAAT target ${matched.patientTarget.toLocaleString()})`)
    parts.push(`Q12: Application must propose ALL of these service types: ${matched.serviceTypes.join(', ')}`)
    parts.push(`Q13: Requested annual SAC funding must NOT exceed $${matched.totalFunding.toLocaleString()}`)
    parts.push(`Q14: Application must maintain funding distribution across: ${popTypes.join(', ')}`)
    parts.push(`Q15: Application must propose to serve patients for each population type: ${popTypes.join(', ')}`)
    const highlightZips = matched.zipDetails.filter(z => z.highlight === 'Yes')
    parts.push(`Q16: Form 5B zip codes must include SAAT zip codes where cumulative patient % reaches >= 75%.`)
    parts.push(`     The "75% threshold" zips: ${highlightZips.map(z => z.zip).join(', ')}`)
    parts.push(`     Cumulative % of highlighted zips: ${(highlightZips.reduce((s, z) => s + z.pctPatients, 0) * 100).toFixed(1)}%`)
  } else {
    parts.push(`\n═══ NO MATCHED SERVICE AREA ═══`)
    parts.push(`Match Method: ${saatData.matchMethod || 'No match attempted'}`)
    parts.push(`The applicant's service area was NOT found in the SAAT CSV data.`)
    parts.push(`This does NOT necessarily mean Q10 is "No" — the SAAT CSV may be a partial export.`)
    parts.push(`For Q10: Check if the applicant's NOFO number (${saatData.announcementNumber}) matches and if they propose a valid service area.`)
    parts.push(`For Q11-Q16: Without matched SAAT data, answer based on application evidence alone and note SAAT cross-validation was not possible.`)
  }

  parts.push(`=== END SAAT DATA ===`)
  return parts.join('\n')
}

/**
 * Build a compact zip code table with cumulative percentages for AI cross-referencing.
 * Shows all zip codes with their individual and cumulative patient percentages.
 */
function buildZipCodeTable(zipDetails) {
  if (!zipDetails || zipDetails.length === 0) return '  (no zip codes available)'

  let cumulative = 0
  const lines = []

  // Show all zips up to 75% threshold with individual detail, then summarize the rest
  const threshold75Idx = zipDetails.findIndex(z => {
    cumulative += z.pctPatients
    return cumulative >= 0.75
  })

  cumulative = 0
  for (let i = 0; i < zipDetails.length; i++) {
    const z = zipDetails[i]
    cumulative += z.pctPatients
    const marker = z.highlight === 'Yes' ? ' [75% threshold]' : ''
    if (i < 40) {
      lines.push(`  ${z.zip}: ${(z.pctPatients * 100).toFixed(1)}% (cumulative: ${(cumulative * 100).toFixed(1)}%)${marker}`)
    }
  }

  if (zipDetails.length > 40) {
    lines.push(`  ... and ${zipDetails.length - 40} more zip codes (total cumulative: ${(cumulative * 100).toFixed(1)}%)`)
  }

  return lines.join('\n')
}

export default {
  deriveFiscalYear,
  loadSAATData,
  matchApplicantToServiceArea,
  buildSAATSummary
}
