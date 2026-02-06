import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import cacheService from '../services/cacheService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const router = express.Router()

const endpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const key = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

if (!endpoint || !key || !deployment) {
  throw new Error('Azure OpenAI credentials not configured')
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(key))

/**
 * POST /api/compare
 * Compare application document against checklist/guide
 */
router.post('/', async (req, res) => {
  try {
    const { applicationData, checklistData } = req.body

    if (!applicationData || !checklistData) {
      return res.status(400).json({ 
        error: 'Both application and checklist data are required' 
      })
    }

    console.log('\n🔍 ===== BACKEND COMPARISON DEBUG START =====')
    console.log('📋 Starting compliance comparison...')
    console.log('📊 Checklist data received:')
    console.log('  - TOC entries:', checklistData.tableOfContents?.length || 0)
    console.log('  - Sections:', checklistData.sections?.length || 0)
    console.log('  - Content length:', checklistData.content?.length || 0)
    
    if (checklistData.tableOfContents?.length > 0) {
      console.log('📑 TOC sections to validate:')
      checklistData.tableOfContents.forEach((toc, idx) => {
        console.log(`  ${idx + 1}. ${toc.title} (Page ${toc.pageNumber})`)
      })
    }
    
    if (checklistData.sections?.length > 0) {
      console.log('📑 Section titles being validated (first 10):')
      checklistData.sections.slice(0, 10).forEach((section, idx) => {
        console.log(`  ${idx + 1}. ${section.title}`)
      })
      
      console.log('📑 ALL section titles being sent to AI:')
      checklistData.sections.forEach((section, idx) => {
        console.log(`  ${idx + 1}. ${section.title}`)
      })
    }

    const systemPrompt = `You are an expert CE (Continuing Education) compliance validator.
Your task is to compare an application document against a checklist or guide document.

CRITICAL VALIDATION RULES:
1. When a checklist requires a FORM to be completed (e.g., Form 1A, Form 5B), you MUST:
   - Locate the actual form in the application tables/structured data
   - Read ALL fields in that form
   - Verify that REQUIRED fields are filled with actual data (not empty, not "N/A" unless appropriate)
   - Check field completeness: Applicant Name, EIN/TIN, Address, City, State, ZIP, etc.
   - If ANY required field is empty or missing, status = "not_met" or "partial"

2. Use ACTUAL PDF page numbers from the extraction data
   - The application tables include a "pageNumber" field - use this EXACT number
   - When referencing evidence, cite the pageNumber from the table where the data appears
   - Example: If Form 1A table has pageNumber: 26, use "Page 26" not "page 94"

3. EXTRACT EXACT TEXT - DO NOT INTERPRET OR PARAPHRASE:
   a) Copy field names EXACTLY as they appear in the application
      - If application says "Applicant Name", write "Applicant Name" (NOT "Entity Name")
      - If application says "Fiscal Year End Date", write "Fiscal Year End Date" (NOT "Fiscal Year")
   b) Copy field values EXACTLY as they appear
      - If value is "FAMILY PRACTICE & COUNSELING SERVICES NETWORK INC", copy it exactly
      - If value is "June 30", write "June 30" (NOT "June")
   c) Preserve the exact structure and layout of the form
      - Show sections as they appear: "1. Applicant Information", "2. Proposed Service Area"
      - Show checkboxes as they appear: "[ X ]" for checked, "[ _ ]" for unchecked
   d) Quote the ENTIRE form section, not just selected fields

4. For each requirement in the checklist:
   a) Determine if the application meets, partially meets, or does not meet the requirement
   b) Provide EXACT evidence from the application (copy-paste, no interpretation)
   c) For forms: Show the actual form structure with all field names and values
   d) Use the pageNumber field from the table for accurate page references
   e) If not met, provide specific recommendations

Return results in JSON format with this structure:
{
  "overallCompliance": "percentage (0-100)",
  "summary": "brief overall summary",
  "sections": [
    {
      "checklistSection": "section name from checklist",
      "requirement": "specific requirement text",
      "status": "met" | "partial" | "not_met",
      "applicationSection": "corresponding section in application",
      "pageReferences": [26],
      "evidence": "EXACT copy from application - Example: 'Applicant Name: FAMILY PRACTICE & COUNSELING SERVICES NETWORK INC\\nFiscal Year End Date: June 30\\nApplication Type: New\\nBusiness Entity: [ X ] Private, non-profit (non-Tribal or Urban Indian)\\nOrganization Type: [ X ] Community based organization'",
      "explanation": "why this meets/doesn't meet the requirement with field-level details",
      "recommendation": "what needs to be done (if not met)",
      "missingFields": ["list of empty/missing required fields if applicable"]
    }
  ],
  "criticalIssues": ["list of critical missing requirements"],
  "recommendations": ["overall recommendations for improvement"]
}

EVIDENCE FORMAT EXAMPLE:
For Form 1A validation, your evidence should look like:
"Form 1A - General Information Worksheet

1. Applicant Information (Page 26, Table 41)
Applicant Name: FAMILY PRACTICE & COUNSELING SERVICES NETWORK INC
Fiscal Year End Date: June 30
Application Type: New
Grant Number: N/A
Business Entity: [ X ] Private, non-profit (non-Tribal or Urban Indian)
Organization Type: [ X ] Community based organization

2. Proposed Service Area (Page 135)
2a. Service Area Designation
[Search tables first. If not in tables, search pages[135].text for '2a' or 'MUA/MUP'. If found in text, extract exact value. If not found anywhere, write: 'Field not found in application']

2b. Service Area Type (Page 135, Table 42)
* Choose Service Area Type: [ X ] Urban [ _ ] Rural

2c. Patients and Visits (Page 135, Table 43)
Total | 15617 | 89085 | 15617 | 88181
Medically Underserved Populations (CHC) | 0 | 0 | 0 | 0
Migratory and Seasonal Agricultural Workers (MSAW) | 0 | 0 | 0 | 0
Residents of Public Housing (RPH) | 15617 | 89085 | 15617 | 88181
Homeless Population (HP) | 0 | 0 | 0 | 0"

⚠️ MANDATORY TABLE FORMATTING REQUIREMENT (CRITICAL - MUST FOLLOW):

FOR ANY PATIENT/VISIT TABLE DATA, YOU **MUST** USE THIS EXACT FORMAT:
- Each data row MUST be pipe-delimited with EXACTLY 5 values
- Format: "PopulationType | UDSPatients | UDSVisits | ProjectedPatients | ProjectedVisits"
- NO header rows, NO descriptive text, ONLY data rows
- DO NOT include form questions like "How many unduplicated patients..."
- DO NOT include instructions like "For a 4-year period of performance..."
- DO NOT include standalone numbers that are not part of the table
- ONLY include the actual table rows (population type names with their 4 numeric values)

Example (FOLLOW THIS EXACTLY):
  2c. Patients and Visits
  Total | 15617 | 89085 | 15617 | 88181
  Medically Underserved Populations (CHC) | 0 | 0 | 0 | 0
  Migratory and Seasonal Agricultural Workers (MSAW) | 0 | 0 | 0 | 0
  Residents of Public Housing (RPH) | 15617 | 89085 | 15617 | 88181
  Homeless Population (HP) | 0 | 0 | 0 | 0

❌ WRONG (DO NOT DO THIS):
  2c. Patients and Visits
  Unduplicated Patients and Visits by Population Type
  How many unduplicated patients do you project to serve in the assessment period?
  For a 4-year period of performance, the assessment period is CY 2028.
  15617
  Population Type
  UDS / Baseline Value
  Patients
  Visits
  Total
  15617

✅ CORRECT (DO THIS):
  2c. Patients and Visits
  Total | 15617 | 89085 | 15617 | 88181

CRITICAL INSTRUCTIONS FOR MULTI-SOURCE DATA EXTRACTION:
1. PRIMARY SOURCE - structuredData (tables):
   - structuredData is an ARRAY of objects, each object is one row
   - Example: structuredData[0] = first row (headers), structuredData[1] = second row (first data)
   - For patient table: Read row index 1 → Total Patients = 15617, Total Visits = 89085

2. FALLBACK SOURCE - pages array (raw text):
   - If field NOT in any table's structuredData, search pages array
   - pages[135].text contains all text from page 135
   - Search for keywords like "2a", "MUA", "MUP", "Service Area Designation"
   - Extract the value that appears near these keywords
   - This makes the system work with ANY document, even if table extraction is incomplete

3. STRICT RULES:
   - DO NOT aggregate or sum values from multiple tables
   - DO NOT use values like "1016690" if they don't appear in the application's specific table
   - NEVER invent or hallucinate values (e.g., don't write "Philadelphia, PA" if it's not in tables OR pages)
   - Only after searching BOTH tables AND pages, write "Field not found in application"

DO NOT paraphrase or summarize - copy the exact field structure and values from tables OR pages.`

    // Extract selected section numbers for explicit validation
    const selectedSectionNumbers = checklistData.selectedSectionNumbers || []
    const selectedSectionNumbersStr = selectedSectionNumbers.length > 0 
      ? selectedSectionNumbers.join(', ') 
      : 'N/A'
    
    console.log('🎯 Selected section numbers for validation:', selectedSectionNumbersStr)
    
    const userPrompt = `You are an expert compliance validation specialist. Your task is to intelligently analyze an application document against a checklist, mimicking how a human reviewer would work.

FORM FIELD VALIDATION (CRITICAL):
When the checklist requires a form to be completed (e.g., "Complete Form 1A", "Complete Form 5B"):
1. SEARCH MULTIPLE TABLES - Forms are often split across several tables:
   - Form 1A section "1. Applicant Information" may be in one table (e.g., page 26)
   - Form 1A section "2. Proposed Service Area" may be in a DIFFERENT table (e.g., page 135)
   - Form 1A section "2a. Service Area Designation" may be in yet another table
   - Form 1A section "2b. Service Area Type" may be in a separate table
   - Form 1A section "2c. Patients and Visits" may be in a separate table
   - YOU MUST search ALL tables in the application to find ALL sections of the form
   
2. For each checklist subsection (e.g., 3.1.1.2 "Completing the Proposed Service Area Section"):
   - FIRST: Search for tables containing "2. Proposed Service Area", "2a.", "2b.", "2c." in structuredData keys
   - Look for tables with keys like "2b. Service Area Type", "2c. Patients and Visits"
   - structuredData is an ARRAY of row objects - read the correct row index
   - For "2c. Patients and Visits" - look for a SEPARATE table with patient data (e.g., table with "Population Type", "Total" rows)
   - FALLBACK: If field NOT found in tables, search the "pages" array for raw text on the relevant page
   - Example: If "2a. Service Area Designation" not in tables, search pages[135].text for "2a" or "MUA" or "MUP"
   
3. CRITICAL - NEVER MAKE UP OR AGGREGATE VALUES:
   - ONLY copy values that ACTUALLY EXIST in the structuredData OR in the raw page text
   - If a field is not found in tables, search the pages array before saying "not found"
   - If truly not found anywhere, write "Field not found in application" - DO NOT invent values
   - DO NOT aggregate data from multiple rows (e.g., don't sum up totals from different tables)
   - DO NOT read data from wrong tables (e.g., don't use summary statistics when looking for specific application data)
   - For patient counts, read from the FIRST data row (index 1) of the patient table, NOT from aggregate statistics
   
3a. CRITICAL - TABLE STRUCTURE FORMATTING (MUST FOLLOW EXACTLY):
   - For patient/visit tables, ALWAYS use PIPE-DELIMITED format: "PopType | Value1 | Value2 | Value3 | Value4"
   - DO NOT include header rows like "Population Type | UDS / Baseline Value | Projected..."
   - DO NOT include descriptive text like "Unduplicated Patients and Visits by Population Type"
   - ONLY include DATA ROWS with 5 pipe-separated values
   - Each row format: "Population Name | UDS Patients | UDS Visits | Projected Patients | Projected Visits"
   - CORRECT Example:
     2c. Patients and Visits
     Total | 15617 | 89085 | 15617 | 88181
     Medically Underserved Populations (CHC) | 0 | 0 | 0 | 0
   - WRONG Example (DO NOT DO THIS):
     Population Type | UDS / Baseline Value | Projected...
     Patients | Visits | Total | 15617 | 89085
   
4. EXTRACT EVIDENCE EXACTLY AS IT APPEARS:
   - Copy field names EXACTLY: "Applicant Name" not "Entity Name", "2b. Service Area Type" not "Service Area"
   - Copy field values EXACTLY from the specific row/column in structuredData
   - Example: If structuredData[1] = {"Population Type":"Total","UDS / Baseline Value":"15617"}, write "Total: 15617"
   - DO NOT write "Total Patients: 1016690" if that value doesn't exist in the application's table
   - Copy checkbox states: "[ X ]" for checked, "[ _ ]" for unchecked
   - Show form sections: "1. Applicant Information", "2. Proposed Service Area", "2a. Service Area Designation", "2b. Service Area Type", "2c. Patients and Visits"
   
5. Check if required fields contain actual data:
   - If value is "[ X ] Urban" - this is FILLED (status = "met")
   - If value is "* Choose Service Area Type" - this is PLACEHOLDER (status = "not_met")
   - If value is "" (empty string) - this is EMPTY (status = "not_met")
   - If field not found in any table - write "Field not found in application" (status = "not_met")
   - If value contains actual data - this is FILLED (status = "met")
   
6. DO NOT report "value missing" if the table exists with the field - check the actual VALUE
7. List specific missing fields ONLY if the value is truly empty, placeholder, or not found
8. CRITICAL: Use the pageNumber field from each table (different sections may have different page numbers)

UNDERSTANDING SECTION HIERARCHY (CRITICAL):
The checklist has a hierarchical structure. You must understand the difference between:

1. ORGANIZATIONAL HEADERS (e.g., "3. Completing the Program Specific Forms")
   - These are just section titles with no actionable requirements
   - DO NOT create validation entries for these
   - They simply introduce what the section covers

2. CATEGORY HEADERS (e.g., "3.1 Completing the General Information Section")
   - These introduce a category of forms/requirements
   - They may list what forms need to be completed
   - DO NOT validate these directly - validate their subsections instead

3. ACTIONABLE REQUIREMENTS (e.g., "3.1.1.1 Completing the Applicant Information Section")
   - These contain SPECIFIC, DETAILED instructions and requirements
   - These describe WHAT data must be provided, HOW to fill forms, WHAT fields are required
   - THESE are what you should validate against the application
   - Look for keywords like: "Complete", "Provide", "Must", "Required", "Enter", "Select", "Specify"

INTELLIGENT VALIDATION APPROACH:
- Read each deep subsection (3+ levels like 3.1.1.1, 3.2.2.1, 3.4.2) carefully
- Extract the SPECIFIC requirements (e.g., "provide applicant information", "complete all required fields", "select organization type")
- Search the application for evidence that these specific requirements are met
- Ignore generic instructional text - focus on actionable validation points

⚠️ CRITICAL: CREATE SEPARATE VALIDATION ENTRIES FOR EACH SUBSECTION
- If checklist has "3.1.1.1", "3.1.1.2", "3.1.1.3" - create 3 SEPARATE validation entries
- DO NOT combine multiple subsections into one validation entry
- Example: For Form 1A with sections 2a, 2b, 2c:
  * Create validation entry for "3.1.1.3 Completing 2a. Service Area Designation"
  * Create validation entry for "3.1.1.4 Completing 2b. Service Area Type"
  * Create validation entry for "3.1.1.5 Completing 2c. Patients and Visits"
- Each entry must have its own evidence, status, and explanation

SELECTED SECTIONS TO VALIDATE: ${selectedSectionNumbersStr}

Application Document Content (includes tables with actual page numbers, structured form data, AND raw page text for fields not in tables):
${(() => {
  // Filter tables to include only form-related tables (reduce from 94 to ~30-40)
  const formKeywords = ['Form', 'Applicant', 'Service Area', 'Patient', 'Visit', 'Organization', 'Business Entity', 'Fiscal Year', 'Application Type', 'Population Type', 'MUA', 'MUP', 'Designation'];
  const relevantTables = applicationData.tables?.filter(t => {
    if (!t.structuredData || t.structuredData.length === 0) return false;
    const tableText = JSON.stringify(t.structuredData).toLowerCase();
    return formKeywords.some(keyword => tableText.includes(keyword.toLowerCase()));
  }).map(t => ({
    id: t.id,
    pageNumber: t.pageNumber,
    rowCount: t.rowCount,
    columnCount: t.columnCount,
    structuredData: t.structuredData
  })) || [];
  
  // Include specific pages that commonly have forms (pages 1-50, 125-160)
  const relevantPages = applicationData.pages?.filter(p => 
    (p.pageNumber >= 1 && p.pageNumber <= 50) || 
    (p.pageNumber >= 125 && p.pageNumber <= 160)
  ).map(p => ({
    pageNumber: p.pageNumber,
    text: p.lines?.map(l => l.content).join('\n') || ''
  })) || [];
  
  console.log(`📊 Filtered tables: ${relevantTables.length} of ${applicationData.tables?.length || 0} (form-related only)`);
  console.log(`📄 Including pages: ${relevantPages.length} pages (1-50, 125-160)`);
  
  return JSON.stringify({
    sections: applicationData.sections?.slice(0, 30) || [],
    tables: relevantTables,
    pages: relevantPages,
    tableOfContents: applicationData.tableOfContents || [],
    totalPages: applicationData.pages?.length || 0,
    note: `Filtered to ${relevantTables.length} form-related tables and ${relevantPages.length} relevant pages for better context`
  }, null, 2);
})()}

Checklist Sections (with hierarchy):
${JSON.stringify(checklistData, null, 2).substring(0, 50000)}

🚨🚨🚨 CRITICAL REQUIREMENT - READ THIS FIRST 🚨🚨🚨

YOUR RESPONSE WILL BE REJECTED IF YOU DO NOT RETURN AT LEAST 70 VALIDATION ENTRIES.

You are receiving 77 checklist sections. You MUST return validation entries for AT LEAST 70 of them.
If your response contains fewer than 70 validation entries, it will be automatically rejected and you will have failed the task.

MINIMUM REQUIRED SECTIONS TO VALIDATE (YOU MUST INCLUDE ALL OF THESE):
□ 3.1 + ALL subsections (3.1.1, 3.1.1.1, 3.1.1.2, 3.1.1.3, 3.1.1.4, 3.1.1.5, 3.1.2) = 7 sections
□ 3.2 + ALL subsections (3.2.1, 3.2.2, 3.2.2.1, 3.2.2.2) = 5 sections
□ 3.3 + ALL subsections (3.3.1, 3.3.1.1-3.3.1.6, 3.3.2, 3.3.2.1-3.3.2.4, 3.3.3) = 15 sections
□ 3.4 + ALL subsections (3.4.1, 3.4.2, 3.4.2.1, 3.4.2.2, 3.4.3, 3.4.3.1, 3.4.3.2, 3.4.4) = 10 sections
□ 3.5 + ALL subsections (3.5.1) = 2 sections

TOTAL MINIMUM: 39 sections just from these major categories. You need to validate ALL 70+ sections in the list.

🚨 VALIDATION RULES - ABSOLUTELY MANDATORY 🚨

RULE #1: VALIDATE EVERY SECTION YOU RECEIVE
- You will receive a list of approximately 77 checklist sections
- Create a validation entry for EVERY SINGLE ONE (no exceptions)
- Expected output: 70-77 validation entries in your response
- This includes ALL of: Section 3.1, Section 3.2, Section 3.3, Section 3.4, Section 3.5 and ALL their subsections

RULE #2: DO NOT SKIP ANY SECTIONS
- Do NOT skip sections thinking they're "organizational headers"
- Do NOT skip sections thinking they're "not actionable"
- Do NOT skip sections for ANY reason
- If a section is in the list, VALIDATE IT
- Do NOT stop after validating section 3.1 - you MUST continue to 3.2, 3.3, 3.4, 3.5

RULE #3: WHAT TO VALIDATE FOR EACH SECTION
For each section (e.g., "3.1.1.2 Completing the Proposed Service Area Section"):
1. Read the section's content/requirements from the checklist
2. Search the application for evidence of those requirements
3. Determine status: met/partial/not_met
4. Provide exact evidence from application (with page numbers)
5. Explain your reasoning
6. If not met, provide specific recommendations

RULE #4: COMPLETE LIST OF SECTIONS TO VALIDATE
You MUST create validation entries for ALL of these (and any others in the list):
✓ 3.1 Completing the General Information Section
✓ 3.1.1 Completing Form 1A - General Information Worksheet
✓ 3.1.1.1 Completing the Applicant Information Section
✓ 3.1.1.2 Completing the Proposed Service Area Section
✓ 3.1.1.3 Completing 2a. Service Area Designation
✓ 3.1.1.4 Completing 2b. Service Area Type
✓ 3.1.1.5 Completing 2c. Patients and Visits
✓ 3.1.2 Completing Form 1C - Documents on File
✓ 3.2 Completing the Budget Information Section
✓ 3.2.1 Completing Form 2 - Staffing Profile
✓ 3.2.2 Completing Form 3 - Income Analysis
✓ 3.2.2.1 Completing the Payer Categories Section
✓ 3.2.2.2 Completing the Comments/Explanatory Notes Section
✓ 3.3 Completing the Sites and Services Section
✓ 3.3.1 Completing Form 5A - Services Provided
✓ 3.3.1.1 through 3.3.1.6 (all subsections)
✓ 3.3.2 Completing Form 5B - Service Sites
✓ 3.3.2.1 through 3.3.2.4 (all subsections)
✓ 3.3.3 Completing Form 5C - Other Activities / Locations
✓ 3.4 Completing the Other Forms Section
✓ 3.4.1 Completing Form 6A - Current Board Member Characteristics
✓ 3.4.2 Completing Form 6B - Request for Waiver of Board Member Requirements
✓ 3.4.2.1 and 3.4.2.2 (all subsections)
✓ 3.4.3 Completing Form 8 - Health Center Agreements
✓ 3.4.3.1 and 3.4.3.2 (all subsections)
✓ 3.4.4 Completing Form 12 - Organization Contacts
✓ 3.5 Completing Other Information
✓ 3.5.1 Completing the Summary Page

RULE #5: QUALITY OF EVIDENCE
- Provide COMPLETE evidence (don't truncate)
- Use ACTUAL page numbers from the application
- Copy exact text from application
- For tables: use pipe-delimited format as instructed earlier

⚠️ FINAL CHECKPOINT BEFORE RESPONDING:
Before you finish your response, verify you have validated ALL of these major sections:
□ Section 3.1 and ALL its subsections (3.1.1, 3.1.1.1, 3.1.1.2, 3.1.1.3, 3.1.1.4, 3.1.1.5, 3.1.2)
□ Section 3.2 and ALL its subsections (3.2.1, 3.2.2, 3.2.2.1, 3.2.2.2)
□ Section 3.3 and ALL its subsections (3.3.1, 3.3.1.1-3.3.1.6, 3.3.2, 3.3.2.1-3.3.2.4, 3.3.3)
□ Section 3.4 and ALL its subsections (3.4.1, 3.4.2, 3.4.2.1, 3.4.2.2, 3.4.3, 3.4.3.1, 3.4.3.2, 3.4.4)
□ Section 3.5 and ALL its subsections (3.5.1)

If you have NOT validated all of these, DO NOT submit your response. Continue validating until ALL sections are complete.

Return results in JSON format with this structure:
{
  "overallCompliance": "percentage (0-100)",
  "summary": "brief overall summary",
  "sections": [
    {
      "checklistSection": "section name from checklist",
      "requirement": "specific requirement text",
      "status": "met" | "partial" | "not_met",
      "applicationSection": "corresponding section in application",
      "pageReferences": ["page 1", "page 3"],
      "evidence": "exact quote from application",
      "explanation": "why this meets/doesn't meet the requirement",
      "recommendation": "what needs to be done (if not met)"
    }
  ],
  "criticalIssues": ["list of critical missing requirements"],
  "recommendations": ["overall recommendations for improvement"]
}`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    const applicationDataStr = JSON.stringify(applicationData, null, 2).substring(0, 50000)
    const checklistDataStr = JSON.stringify(checklistData, null, 2).substring(0, 50000)
    
    console.log('📤 Data being sent to AI:')
    console.log('  - Application data length:', applicationDataStr.length, 'chars')
    console.log('  - Checklist data length:', checklistDataStr.length, 'chars')
    console.log('  - Application tables count:', applicationData.tables?.length || 0)
    console.log('  - First 3 table IDs:', applicationData.tables?.slice(0, 3).map(t => t.id) || [])
    
    // Log sample of first table to verify data structure
    if (applicationData.tables && applicationData.tables.length > 0) {
      const firstTable = applicationData.tables[0]
      console.log('📋 Sample table structure (first table):')
      console.log('  - Table ID:', firstTable.id)
      console.log('  - Page Number:', firstTable.pageNumber)
      console.log('  - Row Count:', firstTable.rowCount)
      console.log('  - Column Count:', firstTable.columnCount)
      console.log('  - Has structuredData:', !!firstTable.structuredData)
      if (firstTable.structuredData && firstTable.structuredData.length > 0) {
        console.log('  - First row keys:', Object.keys(firstTable.structuredData[0]))
        console.log('  - First row sample:', JSON.stringify(firstTable.structuredData[0]).substring(0, 200))
      }
    }
    
    console.log(`🤖 Sending to model: ${deployment}`)
    console.log('🌡️  Temperature: 0.1 (for maximum consistency)')
    console.log('📡 OpenAI API Endpoint:', endpoint)
    console.log('� Request parameters:', {
      maxTokens: 16000,
      temperature: 0.1,
      topP: 0.9,
      responseFormat: 'json_object'
    })

    const result = await client.getChatCompletions(deployment, messages, {
      maxTokens: 16000,
      temperature: 0.1,
      topP: 0.9,
      responseFormat: { type: 'json_object' }
    })

    const response = result.choices[0]?.message?.content

    console.log('✅ Comparison complete')
    console.log('📊 OpenAI API Response:')
    console.log('  - Model:', result.model)
    console.log('  - Token usage:', {
      prompt: result.usage?.promptTokens,
      completion: result.usage?.completionTokens,
      total: result.usage?.totalTokens
    })
    console.log('  - Finish reason:', result.choices[0]?.finishReason)
    console.log('  - Response length:', response?.length, 'chars')
    console.log('📄 Response preview (first 500 chars):', response?.substring(0, 500))

    // Post-process evidence to enforce table formatting
    const enforceTableFormat = (evidence) => {
      if (!evidence || typeof evidence !== 'string') return evidence;
      
      // Check if evidence contains patient/visit table data in wrong format
      const lines = evidence.split('\n');
      const result = [];
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i].trim();
        
        // Skip form questions and instructions (not part of table)
        if (line.includes('How many unduplicated patients') ||
            line.includes('For a 4-year period of performance') ||
            line.includes('Unduplicated Patients and Visits by Population Type') ||
            (line.match(/^\d+$/) && !lines[i-1]?.includes('|'))) { // Standalone numbers
          i++;
          continue;
        }
        
        // Detect sequential table format (wrong format)
        // Pattern: "Population Type" followed by "UDS" followed by numbers
        if (line.includes('Population Type') && 
            !line.includes('|') && 
            i + 5 < lines.length) {
          
          // Skip header lines and find data rows
          let j = i + 1;
          while (j < lines.length && 
                 (lines[j].includes('UDS') || 
                  lines[j].includes('Baseline') || 
                  lines[j].includes('Projected') || 
                  lines[j].includes('Patients') || 
                  lines[j].includes('Visits'))) {
            j++;
          }
          
          // Now j should be at first data line (population type name)
          while (j < lines.length && lines[j].trim()) {
            const popType = lines[j].trim();
            if (!popType || lines[j].match(/^\d+[a-z]?\./)) break;
            
            // Check if this is a population type (not a number)
            if (isNaN(popType) && popType.length > 0) {
              // Next 4 lines should be: patients, visits, patients, visits
              const p1 = lines[j + 1]?.trim() || '0';
              const v1 = lines[j + 2]?.trim() || '0';
              const p2 = lines[j + 3]?.trim() || '0';
              const v2 = lines[j + 4]?.trim() || '0';
              
              // Convert to pipe format
              result.push(`${popType} | ${p1} | ${v1} | ${p2} | ${v2}`);
              j += 5;
            } else {
              j++;
            }
          }
          
          i = j;
        } else {
          result.push(line);
          i++;
        }
      }
      
      return result.join('\n');
    };

    let comparisonResult
    try {
      comparisonResult = JSON.parse(response)
      
      // Enforce table formatting in all evidence fields
      if (comparisonResult.sections) {
        comparisonResult.sections = comparisonResult.sections.map(section => ({
          ...section,
          evidence: enforceTableFormat(section.evidence)
        }));
        console.log('✅ Table formatting enforced in evidence fields');
      }
      
      console.log('✅ AI response parsed successfully')
      console.log('📊 Comparison results summary:')
      console.log('  - Overall compliance:', comparisonResult.overallCompliance)
      console.log('  - Sections analyzed:', comparisonResult.sections?.length || 0)
      console.log('  - Critical issues:', comparisonResult.criticalIssues?.length || 0)
      
      if (comparisonResult.sections?.length > 0) {
        console.log('📑 Sections in AI response (first 5):')
        comparisonResult.sections.slice(0, 5).forEach((section, idx) => {
          console.log(`  ${idx + 1}. ${section.checklistSection} - ${section.status}`)
        })
        
        console.log('📑 ALL sections in AI response:')
        comparisonResult.sections.forEach((section, idx) => {
          console.log(`  ${idx + 1}. ${section.checklistSection} - ${section.status}`)
        })
      }
    } catch (parseError) {
      console.error('❌ Failed to parse AI response as JSON:', parseError)
      console.error('📄 Raw AI response (first 2000 chars):', response?.substring(0, 2000))
      console.error('📄 Raw AI response (last 500 chars):', response?.substring(response.length - 500))
      console.error('📊 Response length:', response?.length, 'chars')
      console.error('📊 Finish reason:', result.choices[0]?.finishReason)
      
      // Try to extract partial JSON if response was truncated
      let partialResult = null
      if (result.choices[0]?.finishReason === 'length') {
        console.log('⚠️ Response was truncated due to token limit. Attempting to extract partial results...')
        // Try to find the last complete section
        const lastSectionMatch = response.lastIndexOf('},\n    {')
        if (lastSectionMatch > 0) {
          const truncatedResponse = response.substring(0, lastSectionMatch + 1) + '\n  ],\n  "criticalIssues": [],\n  "recommendations": []\n}'
          try {
            partialResult = JSON.parse(truncatedResponse)
            console.log('✅ Extracted partial results:', partialResult.sections?.length, 'sections')
          } catch (e) {
            console.error('❌ Could not extract partial results')
          }
        }
      }
      
      comparisonResult = partialResult || {
        overallCompliance: "0",
        summary: "Error: AI response was malformed or truncated. Try validating fewer sections at once.",
        sections: [],
        criticalIssues: ["Failed to parse AI response - response may have been truncated"],
        recommendations: ["Try selecting fewer sections to validate at once"],
        error: {
          message: parseError.message,
          finishReason: result.choices[0]?.finishReason,
          responseLength: response?.length
        }
      }
    }
    
    console.log('🔍 ===== BACKEND COMPARISON DEBUG END =====\n')

    const responseData = {
      success: true,
      comparison: comparisonResult,
      usage: {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens
      },
      metadata: {
        model: deployment,
        comparedAt: new Date().toISOString()
      }
    }

    await cacheService.cacheAnalysis(
      `comparison_${Date.now()}`,
      'Comparison Analysis',
      {
        type: 'comparison',
        result: comparisonResult,
        timestamp: new Date().toISOString()
      }
    )

    res.json(responseData)
  } catch (error) {
    console.error('❌ Comparison error:', error)
    res.status(500).json({
      error: 'Failed to compare documents',
      message: error.message
    })
  }
})

export default router
