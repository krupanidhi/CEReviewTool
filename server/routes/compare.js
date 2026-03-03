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
 * Compress text to reduce AI token usage.
 * Strips page markers, excessive whitespace, formatting chars, and noise.
 */
function compressText(text) {
  if (!text) return ''
  let c = text
  // Remove decorative separators and noise
  c = c.replace(/={10,}/g, '')
  c = c.replace(/_{5,}/g, '')
  c = c.replace(/-{5,}/g, '')
  c = c.replace(/\.{5,}/g, '')
  c = c.replace(/[│┤├┼─┌┐└┘]/g, ' ')
  // Remove page footers/headers noise
  c = c.replace(/PAGE \d+/gi, '')
  c = c.replace(/Page Number:\s*\d+/gi, '')
  c = c.replace(/Page \d+ of \d+/gi, '')
  c = c.replace(/Tracking Number[^\n]*/gi, '')
  // Remove [TEXT] tags (no value for AI — headings/tables already labeled)
  c = c.replace(/\[TEXT\]/gi, '')
  // Remove :selected: and :unselected: markers (replace with readable format)
  c = c.replace(/:selected:/g, '[X]')
  c = c.replace(/:unselected:/g, '[ ]')
  // Collapse whitespace
  c = c.replace(/\n{3,}/g, '\n')
  c = c.replace(/[ \t]{2,}/g, ' ')
  c = c.replace(/\n /g, '\n')
  // Remove empty lines
  c = c.split('\n').filter(line => line.trim().length > 0).join('\n')
  return c.trim()
}

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

APPLICABILITY RULES (IMPORTANT):
- Determine the Application Type from the application data (e.g., "New", "Renewal", "Competing Continuation", "Supplemental").
- If a checklist section explicitly states it only applies to certain application types (e.g., "For renewal applications only"), and the current application is a different type, mark that section as "not_applicable".
- Sections requiring SAAT (Service Area Analysis Tool) data integration that cannot be fully verified from the application alone should be marked as "partial" with an explanation that SAAT verification is pending.
- For patient/visit projections (e.g., section 3.1.1.5), if the data is present but requires cross-referencing with SAAT data to confirm the 75% threshold, mark as "partial" and note that SAAT integration is needed for full validation.
- "not_applicable" sections should NOT count toward the overall compliance percentage calculation.

Return results in JSON format with this structure:
{
  "overallCompliance": "percentage (0-100, excluding not_applicable sections from calculation)",
  "applicationInfo": {
    "applicationType": "New | Renewal | Competing Continuation | Supplemental",
    "applicantName": "extracted applicant name",
    "grantNumber": "extracted grant number or N/A"
  },
  "summary": "brief overall summary",
  "sections": [
    {
      "checklistSection": "section name from checklist",
      "requirement": "specific requirement text FROM CHECKLIST ONLY - DO NOT add formQuestions here",
      "status": "met" | "partial" | "not_met" | "not_applicable",
      "applicationSection": "corresponding section in application",
      "pageReferences": [26],
      "evidence": "EXACT copy from application. CRITICAL: If table has formQuestions array, START with question-answer pairs, THEN table. Example: 'How many unduplicated patients do you project to serve in the assessment period? For a 4-year period of performance, the assessment period is CY 2028: 15617\\n\\nPopulation Type | UDS Patients | UDS Visits | Projected Patients | Projected Visits\\nTotal | 15617 | 89085 | 15617 | 88181'",
      "explanation": "why this meets/doesn't meet the requirement with field-level details. For not_applicable: explain why this section doesn't apply to this application type.",
      "recommendation": "what needs to be done (if not met or partial)",
      "missingFields": ["list of empty/missing required fields if applicable"]
    }
  ],
  "criticalIssues": ["list of critical missing requirements"],
  "recommendations": ["overall recommendations for improvement"]
}

🚨 CRITICAL RULE - FORM QUESTIONS ARE MANDATORY PRIMARY EVIDENCE:

VALIDATION REQUIREMENT: Your response will be REJECTED if you omit formQuestions.
- Each table object has a "formQuestions" array containing pre-extracted question-answer pairs
- If formQuestions array is NOT EMPTY, you MUST output every question-answer pair BEFORE the table
- Format (EXACT): "[Full question text]: [answer]" (NO "Answer:" prefix, just question: value)
- Example: "How many unduplicated patients do you project to serve in the assessment period? For a 4-year period of performance, the assessment period is CY 2028: 15617"

GRADING CRITERIA:
✅ CORRECT: Output formQuestions first, then table
❌ WRONG: Output only table, skip formQuestions
❌ WRONG: Output "Answer: 15617" without the question text

This applies to ALL sections (3.1.x, 3.2.x, 3.3.x, etc.). Questions are PRIMARY EVIDENCE, tables are SECONDARY.

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
How many unduplicated patients do you project to serve in the assessment period? For a 4-year period of performance, the assessment period is CY 2028: 15617

Unduplicated Patients and Visits by Population Type:
Population Type | UDS Patients | UDS Visits | Projected Patients | Projected Visits
Total | 15617 | 89085 | 15617 | 88181
Medically Underserved Populations (CHC) | 0 | 0 | 0 | 0
Migratory and Seasonal Agricultural Workers (MSAW) | 0 | 0 | 0 | 0
Residents of Public Housing (RPH) | 15617 | 89085 | 15617 | 88181
Homeless Population (HP) | 0 | 0 | 0 | 0"

⚠️ MANDATORY TABLE FORMATTING REQUIREMENT (CRITICAL - MUST FOLLOW FOR ALL TABLES):

FOR **ANY TABLE DATA** (Income Analysis, Staffing, Patient/Visit, Service Sites, etc.), YOU **MUST** USE PIPE-DELIMITED FORMAT:

RULES FOR EVIDENCE STRUCTURE:
1. INCLUDE form questions/prompts that have answers (e.g., "How many unduplicated patients do you project to serve? Answer: 15617")
2. INCLUDE descriptive labels before tables (e.g., "Unduplicated Patients and Visits by Population Type:")
3. EXCLUDE empty form instructions that don't have answers (e.g., "Click here to add a row")
4. For TABLE DATA specifically:
   - FIRST ROW = HEADERS (column names separated by pipes)
   - SUBSEQUENT ROWS = DATA (values separated by pipes)
   - Each row must have the SAME number of pipe-separated values
   - DO NOT mix regular text with pipe-delimited rows

Example 1 - Patient/Visit Table (5 columns):
  2c. Patients and Visits
  Population Type | UDS Patients | UDS Visits | Projected Patients | Projected Visits
  Total | 15617 | 89085 | 15617 | 88181
  Medically Underserved Populations (CHC) | 0 | 0 | 0 | 0
  Residents of Public Housing (RPH) | 15617 | 89085 | 15617 | 88181

Example 2 - Income Analysis Table (6 columns):
  Form 3 - Income Analysis
  Payer Category | Patients (a) | Billable Visits (b) | Income Per Visit (c) | Projected Income (d) | Prior FY Income (e)
  1. Medicaid | 7,206 | 50,442 | $275.80 | $13,911,903.60 | $15,223,241.00
  2. Medicare | 5,562 | 5,562 | $161.22 | $896,705.64 | $1,203,493.00
  3. Other Public | 0 | 0 | $0.00 | $0.00 | $0.00
  4. Private | 3,151 | 12,604 | $73.72 | $929,166.88 | $1,149,427.00

Example 3 - Staffing Table (4 columns):
  Form 2 - Staffing Profile
  Position Type | FTE | Salary | Total Cost
  Physicians | 5.0 | $180,000 | $900,000
  Nurses | 12.0 | $75,000 | $900,000

✅ CORRECT FORMAT: Header row + data rows, all pipe-delimited
❌ WRONG: Raw text, standalone numbers, form questions, or unstructured data

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

3. INCLUDE ALL FORM QUESTIONS WITH ANSWERS:
   - If a form has a question/prompt with an answer, INCLUDE BOTH in evidence
   - Example: "How many unduplicated patients do you project to serve in the assessment period? For a 4-year period of performance, the assessment period is CY 2028. Answer: 15617"
   - Example: "What is your organization's fiscal year end date? Answer: June 30"
   - Example: "Total number of service sites? Answer: 5"
   - DO NOT exclude questions just because they look like "instructions" - if they have answers, include them
   - This applies to ALL sections (3.1, 3.2, 3.3, 3.4, 3.5) and ALL forms

4. STRICT RULES:
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
   
   🚨🚨🚨 MANDATORY STEP 1 - OUTPUT formQuestions FIRST (NON-NEGOTIABLE):
   - Each table object contains a "formQuestions" array with question-answer pairs
   - If formQuestions array has ANY entries, you MUST output them FIRST, BEFORE the table
   - This is NOT optional - formQuestions are PRIMARY EVIDENCE, tables are SECONDARY
   - Output format (EXACT): "[Full question text]: [answer value]"
   - Example: "How many unduplicated patients do you project to serve in the assessment period? For a 4-year period of performance, the assessment period is CY 2028: 15617"
   - Then add a blank line, then output the table
   - FAILURE TO INCLUDE formQuestions = INCOMPLETE EVIDENCE = VALIDATION FAILURE
   - If you output ONLY the table without the formQuestions, your response is WRONG
   
   STEP 2 - Extract table data:
   - Search for tables containing "2. Proposed Service Area", "2a.", "2b.", "2c." in structuredData keys
   - Look for tables with keys like "2b. Service Area Type", "2c. Patients and Visits"
   - structuredData is an ARRAY of row objects - read the correct row index
   - For "2c. Patients and Visits" - look for a SEPARATE table with patient data (e.g., table with "Population Type", "Total" rows)
   
   STEP 3 - Fallback to raw text:
   - If field NOT found in tables, search the "pages" array for raw text on the relevant page
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
  // Helper function to extract form questions from page text
  const extractFormQuestions = (pageText) => {
    const questions = [];
    const lines = pageText.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Look for multi-line questions that start with common question words
      // and eventually end with '?' (may span multiple lines)
      if (line.toLowerCase().startsWith('how many') && line.length > 20) {
        // Collect the full multi-line question
        let fullQuestion = line;
        let questionEndIndex = i;
        
        // Look ahead to find where the question ends (with '?')
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const nextLine = lines[j].trim();
          
          // Skip empty lines
          if (nextLine === '') continue;
          
          // If we hit a table header or other structural element, stop
          if (nextLine.includes('|') || nextLine.toLowerCase().includes('population type') || 
              nextLine.toLowerCase().includes('uds') || nextLine.toLowerCase().includes('baseline')) {
            break;
          }
          
          // Append this line to the question
          fullQuestion += ' ' + nextLine;
          questionEndIndex = j;
          
          // If this line ends with '?', the question is complete
          if (nextLine.endsWith('?')) {
            break;
          }
          
          // If this line ends with '.', it might be the end of the question
          if (nextLine.endsWith('.')) {
            break;
          }
        }
        
        // Now look for the answer immediately after the question
        for (let k = questionEndIndex + 1; k < Math.min(questionEndIndex + 5, lines.length); k++) {
          const answerLine = lines[k].trim();
          
          // Skip empty lines
          if (answerLine === '') continue;
          
          // If we hit a table or structural element, stop
          if (answerLine.includes('|') || answerLine.toLowerCase().includes('population type')) {
            break;
          }
          
          // If this looks like a pure number (the answer), capture it
          if (/^\d+$/.test(answerLine)) {
            questions.push({
              question: fullQuestion.trim(),
              answer: answerLine,
              lineIndex: i
            });
            break;
          }
        }
      }
    }
    
    return questions;
  };
  
  // Filter tables to include only form-related tables (reduce from 94 to ~30-40)
  const formKeywords = ['Form', 'Applicant', 'Service Area', 'Patient', 'Visit', 'Organization', 'Business Entity', 'Fiscal Year', 'Application Type', 'Population Type', 'MUA', 'MUP', 'Designation'];
  const relevantTables = applicationData.tables?.filter(t => {
    if (!t.structuredData || t.structuredData.length === 0) return false;
    const tableText = JSON.stringify(t.structuredData).toLowerCase();
    return formKeywords.some(keyword => tableText.includes(keyword.toLowerCase()));
  }).map(t => {
    // Find the page where this table appears
    const tablePage = applicationData.pages?.find(p => p.pageNumber === t.pageNumber);
    const pageText = tablePage?.lines?.map(l => l.content).join('\n') || '';
    
    // Extract form questions from the page
    const formQuestions = extractFormQuestions(pageText);
    
    return {
      id: t.id,
      pageNumber: t.pageNumber,
      structuredData: t.structuredData,
      formQuestions: formQuestions
    };
  }) || [];
  
  // Include pages with forms: 1-50 (cover, TOC, general info, SF-424) and 125-160 (Form 1A, patient tables)
  const relevantPages = applicationData.pages?.filter(p => 
    (p.pageNumber >= 1 && p.pageNumber <= 50) || 
    (p.pageNumber >= 125 && p.pageNumber <= 160)
  ).map(p => ({
    pageNumber: p.pageNumber,
    text: compressText(p.lines?.map(l => l.content).join('\n') || '')
  })).filter(p => p.text.length > 20) || [];
  
  console.log(`📊 Filtered tables: ${relevantTables.length} of ${applicationData.tables?.length || 0} (form-related only)`);
  console.log(`📄 Including pages: ${relevantPages.length} (pages 1-50, 125-160, full compressed text)`);
  
  // DEBUG: Check if formQuestions were extracted for page 135
  const table135 = relevantTables.find(t => t.pageNumber === 135);
  if (table135) {
    console.log('\n🔍 DEBUG: Table on page 135 (patient table):');
    console.log('  - Table ID:', table135.id);
    console.log('  - formQuestions count:', table135.formQuestions?.length || 0);
    if (table135.formQuestions && table135.formQuestions.length > 0) {
      console.log('  - First question:', table135.formQuestions[0].question?.substring(0, 100));
      console.log('  - First answer:', table135.formQuestions[0].answer);
    } else {
      console.log('  - ⚠️ NO formQuestions extracted!');
      console.log('  - pageContext length:', table135.pageContext?.length || 0);
      console.log('  - pageContext preview:', table135.pageContext?.substring(0, 300));
    }
  }
  
  return JSON.stringify({
    tables: relevantTables,
    pages: relevantPages,
    totalPages: applicationData.pages?.length || 0
  });
})()}

Checklist Sections to Validate:
${(checklistData.sections || []).map((s, i) => `${i + 1}. [${s.sectionNumber || ''}] ${s.title}`).join('\n')}

🚨 CRITICAL REQUIREMENT 🚨

You are receiving ${checklistData.sections?.length || 0} checklist sections to validate.
You MUST return exactly ONE validation entry for EACH section provided — no more, no less.
Expected output: ${checklistData.sections?.length || 0} validation entries.

DO NOT create entries for sections not in the list.
DO NOT skip any section in the list.
DO NOT combine multiple sections into one entry.
DO NOT create duplicate entries for the same section.

SECTIONS TO VALIDATE (create exactly one entry per section):
${(checklistData.sections || []).map((s, i) => `${i + 1}. ${s.title}`).join('\n')}

RULES:
1. Create one validation entry per section listed above
2. Provide COMPLETE evidence (don't truncate)
3. Use ACTUAL page numbers from the application
4. Copy exact text from application
5. For tables: use pipe-delimited format as instructed earlier
6. Each entry must have its own evidence, status, and explanation

Return results in JSON format with this structure:
{
  "overallCompliance": "percentage (0-100)",
  "summary": "brief overall summary",
  "sections": [
    {
      "checklistSection": "section name from checklist",
      "requirement": "specific requirement text",
      "status": "met" | "partial" | "not_met" | "not_applicable",
      "applicationSection": "corresponding section in application",
      "pageReferences": ["page 1", "page 3"],
      "evidence": "exact quote from application",
      "explanation": "why this meets/doesn't meet the requirement. For not_applicable: why this section doesn't apply.",
      "recommendation": "what needs to be done (if not met or partial)"
    }
  ],
  "criticalIssues": ["list of critical missing requirements"],
  "recommendations": ["overall recommendations for improvement"]
}

APPLICABILITY STATUS RULES:
- Use "not_applicable" when a section explicitly requires a specific application type (e.g., renewal-only sections for a new application).
- Use "partial" for sections like 3.1.1.5 (Patients and Visits) where data is present but requires SAAT cross-referencing to confirm the 75% threshold. Include explanation: "SAAT integration needed for full validation."
- "not_applicable" sections are excluded from overall compliance calculation.`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    // Log ACTUAL prompt size for performance monitoring
    const totalChars = systemPrompt.length + userPrompt.length
    console.log(`📤 ACTUAL prompt: ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`)
    
    // Dynamic maxTokens and timeout based on section count
    const sectionCount = checklistData.sections?.length || 1
    const maxTokens = Math.min(32000, Math.max(4000, sectionCount * 600))
    const timeoutMinutes = Math.min(8, Math.max(3, Math.ceil(sectionCount / 6)))
    const timeoutMs = timeoutMinutes * 60 * 1000

    console.log(`🤖 Sending to model: ${deployment}`)
    console.log('🌡️  Temperature: 0.1 (for maximum consistency)')
    console.log('📡 OpenAI API Endpoint:', endpoint)
    console.log(`📊 Sections: ${sectionCount}, maxTokens: ${maxTokens}, timeout: ${timeoutMinutes}min`)

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`AI comparison timed out after ${timeoutMinutes} minutes`)), timeoutMs)
    )
    
    const result = await Promise.race([
      client.getChatCompletions(deployment, messages, {
        maxTokens,
        temperature: 0,
        topP: 1,
        responseFormat: { type: 'json_object' }
      }),
      timeoutPromise
    ])

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
      
      // POST-PROCESS: Inject formQuestions into evidence when AI fails to include them
      if (comparisonResult.sections && applicationData.tables) {
        // Re-extract formQuestions using the same logic that was used when sending to AI
        const extractFormQuestions = (pageText) => {
          const questions = [];
          const lines = pageText.split('\n');
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.toLowerCase().startsWith('how many') && line.length > 20) {
              let fullQuestion = line;
              let questionEndIndex = i;
              
              for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                const nextLine = lines[j].trim();
                if (nextLine === '') continue;
                if (nextLine.includes('|') || nextLine.toLowerCase().includes('population type') || 
                    nextLine.toLowerCase().includes('uds') || nextLine.toLowerCase().includes('baseline')) {
                  break;
                }
                fullQuestion += ' ' + nextLine;
                questionEndIndex = j;
                if (nextLine.endsWith('?') || nextLine.endsWith('.')) break;
              }
              
              for (let k = questionEndIndex + 1; k < Math.min(questionEndIndex + 5, lines.length); k++) {
                const answerLine = lines[k].trim();
                if (answerLine === '') continue;
                if (answerLine.includes('|') || answerLine.toLowerCase().includes('population type')) break;
                if (/^\d+$/.test(answerLine)) {
                  questions.push({
                    question: fullQuestion.trim(),
                    answer: answerLine
                  });
                  break;
                }
              }
            }
          }
          return questions;
        };
        
        let injectionCount = 0;
        comparisonResult.sections = comparisonResult.sections.map(section => {
          let evidence = section.evidence || '';
          let requirement = section.requirement || '';
          
          // GENERIC FIX: Move any form questions from requirement to evidence
          // Check if requirement contains form questions (questions ending with ? followed by numbers)
          const questionInRequirement = requirement.match(/^[^?]*\?\s*[\d,]+/m);
          if (questionInRequirement) {
            console.log('🔧 GENERIC FIX: Moving form question from requirement to evidence');
            console.log('  - Original requirement:', requirement.substring(0, 100));
            
            // Extract the question-answer pair
            const questionAnswer = requirement.match(/^[^?]*\?\s*[\d,]+/m)[0];
            
            // Remove from requirement
            requirement = requirement.replace(/^[^?]*\?\s*[\d,]+\s*/m, '').trim();
            
            // Add to evidence at the beginning
            evidence = `${questionAnswer}\n\n${evidence}`;
            
            console.log('  - Moved to evidence:', questionAnswer);
            console.log('  - New requirement:', requirement.substring(0, 100));
            
            // If requirement is now empty, provide a default description
            if (!requirement.trim()) {
              requirement = "Complete this section by providing the required patient and visit data for the assessment period.";
              console.log('  - Added default requirement description');
            }
          }
          
          // For section 3.1.1.5 (Patients and Visits), check if formQuestions are missing
          if (section.checklistSection?.includes('3.1.1.5') || 
              section.checklistSection?.includes('2c. Patients and Visits')) {
            
            console.log('🔍 POST-PROCESS DEBUG: Found section 3.1.1.5:', section.checklistSection);
            console.log('  - Evidence length before injection:', evidence?.length);
            console.log('  - Evidence preview (first 200 chars):', evidence?.substring(0, 200));
            
            // Find page 135 and extract formQuestions from it
            const page135 = applicationData.pages?.find(p => p.pageNumber === 135);
            if (page135) {
              const pageText = page135.lines?.map(l => l.content).join('\n') || '';
              const formQuestions = extractFormQuestions(pageText);
              
              console.log('  - Page 135 found:', true);
              console.log('  - formQuestions extracted:', formQuestions.length);
              if (formQuestions.length > 0) {
                console.log('  - First question preview:', formQuestions[0].question.substring(0, 50));
                console.log('  - First answer:', formQuestions[0].answer);
                console.log('  - Full question:', formQuestions[0].question);
                
                // Check if evidence already contains the question
                const searchString = formQuestions[0].question.substring(0, 30);
                const hasQuestion = evidence.includes(searchString);
                
                console.log('  - Searching for:', searchString);
                console.log('  - Evidence already has question:', hasQuestion);
                console.log('  - Evidence full content:', evidence);
                
                if (!hasQuestion) {
                  console.log('🔧 POST-PROCESS: Injecting missing formQuestions into section 3.1.1.5');
                  // Prepend formQuestions to evidence
                  const questionsText = formQuestions
                    .map(fq => `${fq.question}: ${fq.answer}`)
                    .join('\n\n');
                  evidence = `${questionsText}\n\n${evidence}`;
                  injectionCount++;
                  console.log('  - Evidence length after injection:', evidence.length);
                  console.log('  - Injected text preview:', questionsText.substring(0, 100));
                }
              } else {
                console.log('  - ⚠️ NO formQuestions extracted from page 135');
              }
            } else {
              console.log('  - ⚠️ Page 135 not found in applicationData.pages');
            }
          }
          
          return {
            ...section,
            evidence,
            requirement
          };
        });
        
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
        
        // DEBUG: Log section 3.1.1.5 evidence in detail
        const section3115 = comparisonResult.sections.find(s => 
          s.checklistSection?.includes('3.1.1.5') || 
          s.checklistSection?.includes('2c. Patients and Visits')
        )
        if (section3115) {
          console.log('\n🔍 DEBUG: Section 3.1.1.5 Evidence Detail:')
          console.log('  - Checklist Section:', section3115.checklistSection)
          console.log('  - Evidence Length:', section3115.evidence?.length, 'chars')
          console.log('  - Evidence Preview (first 500 chars):')
          console.log(section3115.evidence?.substring(0, 500))
          console.log('  - Evidence Full (if < 1000 chars):')
          if (section3115.evidence?.length < 1000) {
            console.log(section3115.evidence)
          }
        } else {
          console.log('\n⚠️ DEBUG: Section 3.1.1.5 NOT FOUND in AI response')
        }
      }
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
    console.error('❌ Comparison error:', error.message)
    console.error('❌ Error name:', error.name)
    console.error('❌ Error stack:', error.stack)
    if (error.code) console.error('❌ Error code:', error.code)
    if (error.statusCode) console.error('❌ Status code:', error.statusCode)
    res.status(500).json({
      error: 'Failed to compare documents',
      message: error.message
    })
  }
})

export default router
