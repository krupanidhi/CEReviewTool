import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

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
 * POST /api/chat
 * Interactive chat with fine-tuned model
 */
router.post('/', async (req, res) => {
  try {
    const { message, history, context } = req.body

    if (!message) {
      return res.status(400).json({ error: 'Message is required' })
    }

    console.log('💬 Chat request received')
    console.log('📋 Context available:', {
      hasApplication: !!context?.application,
      hasChecklist: !!context?.checklist,
      hasSingleDoc: !!context?.singleDocument,
      hasAnalysisResults: !!context?.analysisResults,
      hasPfContext: !!context?.pfContext,
      standardQs: context?.analysisResults?.standardQuestions?.length || 0,
      programSpecificQs: context?.analysisResults?.programSpecificQuestions?.length || 0
    })
    
    // Validate that actual document data exists
    if (context?.application) {
      console.log('📊 Application data validation:', {
        hasSections: !!context.application.data?.sections,
        sectionCount: context.application.data?.sections?.length || 0,
        hasTables: !!context.application.data?.tables,
        tableCount: context.application.data?.tables?.length || 0,
        hasStructuredData: context.application.data?.tables?.some(t => t.structuredData?.length > 0)
      })
    }
    
    if (context?.checklist) {
      console.log('📋 Checklist data validation:', {
        hasSections: !!context.checklist.data?.sections,
        sectionCount: context.checklist.data?.sections?.length || 0
      })
    }

    // Build intelligent system prompt based on available context
    const isPfMode = !!context?.pfContext
    let systemPrompt

    if (isPfMode) {
      // Pre-Funding Review mode — system prompt tailored for PF compliance results
      systemPrompt = `You are an expert pre-funding compliance review assistant specialized in HRSA Health Center program requirements.

CRITICAL RULES - YOU MUST FOLLOW THESE STRICTLY:
1. ONLY use data from the pre-funding review results provided in [PRE-FUNDING REVIEW RESULTS] below
2. NEVER use examples, assumptions, or generic data
3. If you don't find specific data in the provided results, say "I cannot find this information in the pre-funding review results"
4. Every answer must be traceable to the actual compliance findings provided

You have access to a completed pre-funding review analysis for application: ${context.pfContext.filename || context.pfContext.applicationNumber}

The review covers 8 compliance sections:
- Sliding Fee Discount Program
- Key Management Staff
- Contracts and Subawards
- Collaborative Relationships
- Billing and Collections
- Budget
- Board Authority
- Board Composition

Each section contains items categorized as COMPLIANT, NON-COMPLIANT, or NOT APPLICABLE.
Each item includes: element name, requirement, status, evidence, evidence location, evidence section, and reasoning.

Your role is to:
1. Answer questions about specific compliance sections, elements, or findings
2. Summarize compliance status across sections or for specific areas
3. Explain evidence and reasoning behind compliance determinations
4. Identify non-compliant items and explain what is missing or deficient
5. Compare findings across sections when asked
6. Provide page references from the evidence location data

RESPONSE FORMAT:
- When discussing specific items, include the element name, status, and evidence
- Always cite page numbers from evidenceLocation when available
- Use clear formatting with headers, bullet points, and tables as appropriate
- For summary questions, provide counts and percentages

`
    } else {
      // CE Review mode — original system prompt
      systemPrompt = `You are an expert compliance validation assistant specialized in CE (Continuing Education) review and grant application analysis.

CRITICAL RULES - YOU MUST FOLLOW THESE STRICTLY:
1. ONLY use data from the actual documents provided in the context below
2. NEVER use examples, assumptions, or generic data
3. NEVER say "based on a generic example" or "my previous answer was based on..."
4. If you don't find specific data in the provided context, say "I cannot find this information in the uploaded documents"
5. Every answer must be traceable to the actual JSON data provided in [APPLICATION DOCUMENT DATA] and [CHECKLIST/GUIDE DOCUMENT DATA]

Your role is to provide intelligent, evidence-based answers by:
1. Understanding checklist requirements and validation criteria
2. Searching the application document for relevant evidence
3. Providing specific page references and exact quotes from the actual data
4. Explaining compliance status with clear reasoning based on actual data
5. Offering actionable recommendations when requirements are not met

`
    }

    // Add context-specific instructions (PF mode checked FIRST — it takes priority)
    if (isPfMode) {
      // PF mode system prompt already fully built above — no additional context instructions needed
    } else if (context?.application && context?.checklist) {
      systemPrompt += `AVAILABLE DOCUMENTS:
✓ Application Document: ${context.application.name}
✓ Checklist/Guide Document: ${context.checklist.name}

THE APPLICATION DATA CONTAINS TWO KEY SECTIONS:

1. "tables" — ALL structured form data from the application (Form 1A, 2B, 5B, 5C, 6A, 6B, budgets, SF-424, etc.)
   - Each table has "structuredData" with column headers as keys and row data as values
   - Each table has "pageNumber" showing where it appears in the PDF
   - When user asks about any form (e.g., "show Form 5B", "what's in Form 1A"), search ALL tables by their column headers and page numbers
   - Forms may span multiple tables — combine data from tables on consecutive pages

2. "pageTexts" — Full text content of EVERY page in the application
   - Contains project narratives, attachment text, cover pages, abstracts, and all unstructured content
   - Each entry has "page" (page number) and "text" (full page content)
   - When user asks about narratives, attachments, or any text content, search pageTexts
   - Provide exact quotes with page numbers

SEARCH STRATEGY: For any user question, search BOTH tables AND pageTexts to find all relevant data.

${context.analysisResults ? `
COMPLETED ANALYSIS AVAILABLE:
A full checklist compliance analysis has ALREADY been completed for this application. The results are provided in [COMPLETED ANALYSIS RESULTS] below.
This includes:
- Standard Q&A questions with AI answers, evidence, reasoning, and page references
- Program-specific checklist questions (Q1-Q${context.analysisResults.programSpecificQuestions?.length || '?'}) with answers, evidence, and reasoning
- Applicant profile information (applicant type, service area ID, organization name)
- SAAT (Service Area Analysis Tool) data: service area details, funding, zip codes, patient targets, service types
- Overall compliance summary

HOW TO USE THE CONTEXT — READ CAREFULLY:

TYPE 1: CHECKLIST QUESTION REFERENCES (user mentions Q2, Q5, "question 10", etc.)
→ Look up that exact question number in [COMPLETED ANALYSIS RESULTS] programSpecificQuestions or standardQuestions
→ Show the answer, evidence, reasoning, and page references from the analysis
→ Supplement with raw document data if the user wants more depth

TYPE 2: FACT-FINDING / DATA QUERIES (user asks "show SAAT data", "what is the service area", "list attachments", "what is the budget", "service area id", etc.)
→ Do NOT default to a checklist question answer
→ Pull the actual data directly from [COMPLETED ANALYSIS RESULTS] (applicantProfile, saatInfo) and/or [APPLICATION DOCUMENT DATA] (pageTexts, tables, sections, keyValuePairs)
→ Show the raw data as-is so the user can verify facts independently
→ For SAAT queries: show service area ID, city/state, patient target, funding, zip codes, service types from the saatInfo and applicantProfile fields

TYPE 3: VERIFICATION QUERIES (user asks "is Q2 correct?", "verify Q5", "why is Q10 yes?")
→ Show the completed analysis answer AND independently search the raw document data to confirm or challenge it
→ Present both the analysis result and the raw evidence side by side

TYPE 4: GENERAL QUESTIONS (user asks about topics not tied to a specific Q#)
→ Search the raw application document data (pageTexts, tables, sections) for relevant information
→ Also check if any completed analysis questions are relevant and mention them
→ Provide exact quotes with page numbers
` : ''}
INTELLIGENT Q&A APPROACH:
When the user asks a question:
1. Determine the question TYPE (1-4 above) based on what the user is actually asking
2. For data/fact queries: extract and present the actual data from the context
3. For checklist questions: reference the completed analysis
4. For verification: show both analysis results AND raw document evidence
5. Always provide:
   - Exact data from the context (quotes, numbers, table rows)
   - Page references where the data was found
   - Clear, factual presentation — let the user draw their own conclusions

RESPONSE FORMAT:
- For checklist questions: "**From Completed Analysis (Q[number]):** [answer] ..."
- For data queries: Present the actual data in a clear, structured format (tables, lists, key-value pairs)
- For SAAT data: Show service area ID, location, patient target, funding breakdown, service types, zip codes
- Always include page references when citing application data

Be thorough, specific, and present actual data from the documents.`
    } else if (context?.singleDocument) {
      systemPrompt += `Current Document Context:
Document: ${context.singleDocument.name}
Extracted Data Available: Yes

Provide clear, accurate analysis of this document.`
    } else {
      systemPrompt += `No documents currently loaded. Provide general guidance about CE review and compliance validation.`
    }

    // Build conversation history
    const messages = [
      {
        role: 'system',
        content: systemPrompt
      }
    ]

    // Add conversation history
    if (history && Array.isArray(history)) {
      history.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({
            role: msg.role,
            content: msg.content
          })
        }
      })
    }

    // Add current user message with comprehensive context
    let userMessageContent = message

    // Append document context (PF mode checked FIRST — it takes priority)
    if (isPfMode) {
      // Pre-funding review mode — append PF results as context
      const pfJson = JSON.stringify(context.pfContext.results, null, 2).substring(0, 200000)
      userMessageContent += `\n\n[PRE-FUNDING REVIEW RESULTS]:\n${pfJson}`
      console.log(`📊 PF context: ${Object.keys(context.pfContext.results || {}).length} sections (${(pfJson.length/1024).toFixed(0)}KB)`)
    } else if (context?.application && context?.checklist) {
      const allTables = context.application.data?.tables || []

      // Include ALL tables — they contain form data (1A, 2B, 5B, 6A, budgets, etc.)
      const tablesToInclude = allTables.map(table => ({
        id: table.id,
        pageNumber: table.pageNumber,
        rowCount: table.rowCount,
        columnCount: table.columnCount,
        structuredData: table.structuredData
      }))

      // Build condensed page text — contains narratives, attachments, unstructured content
      const pageTexts = (context.application.data?.pages || []).map(p => ({
        page: p.pageNumber,
        text: (p.lines || []).map(l => l.content).join('\n')
      }))

      // Build application context in priority order:
      // 1. Tables (structured form data) — most important for form queries
      // 2. Page text (narratives, attachments, unstructured) — important for fact-finding
      // 3. Sections, TOC, key-value pairs — supplementary
      const tablesJson = JSON.stringify(tablesToInclude, null, 1)
      const pageTextsJson = JSON.stringify(pageTexts, null, 1)
      const supplementary = JSON.stringify({
        tableOfContents: context.application.data?.tableOfContents || [],
        keyValuePairs: context.application.data?.keyValuePairs || [],
        pageCount: context.application.data?.pages?.length || 0
      }, null, 1)

      // Budget: tables first (up to 400K), then page text (up to 200K), then supplementary
      const tablesBudget = tablesJson.substring(0, 400000)
      const pageTextBudget = pageTextsJson.substring(0, 200000)
      const suppBudget = supplementary.substring(0, 20000)

      const applicationSummary = `{"tables":${tablesBudget},"pageTexts":${pageTextBudget},"supplementary":${suppBudget}}`

      const checklistSummary = JSON.stringify({
        sections: context.checklist.data?.sections?.slice(0, 100) || [],
        tableOfContents: context.checklist.data?.tableOfContents || [],
        tables: context.checklist.data?.tables?.map(table => ({
          id: table.id,
          pageNumber: table.pageNumber,
          rowCount: table.rowCount,
          columnCount: table.columnCount,
          structuredData: table.structuredData
        })) || [],
        pages: context.checklist.data?.pages?.length || 0
      }, null, 2).substring(0, 20000)

      // Append completed analysis results if available
      let analysisSection = ''
      if (context.analysisResults) {
        const ar = context.analysisResults
        const analysisData = {
          applicantProfile: ar.applicantProfile,
          saatInfo: ar.saatInfo,
          overallCompliance: ar.overallCompliance,
          summary: ar.summary,
          standardQuestions: ar.standardQuestions,
          programSpecificQuestions: ar.programSpecificQuestions,
          complianceSections: ar.complianceSections
        }
        analysisSection = `\n\n[COMPLETED ANALYSIS RESULTS]:\n${JSON.stringify(analysisData, null, 2).substring(0, 80000)}`
        console.log(`📊 Analysis results included: ${ar.standardQuestions?.length || 0} standard + ${ar.programSpecificQuestions?.length || 0} program-specific questions`)
      }

      userMessageContent += `\n\n[APPLICATION DOCUMENT DATA]:\n${applicationSummary}\n\n[CHECKLIST/GUIDE DOCUMENT DATA]:\n${checklistSummary}${analysisSection}`
      
      // Log what data is being sent to AI
      console.log('📊 Sending to AI:')
      console.log(`   Tables: ${allTables.length} (${(tablesBudget.length/1024).toFixed(0)}KB)`)
      console.log(`   Page text: ${pageTexts.length} pages (${(pageTextBudget.length/1024).toFixed(0)}KB)`)
      console.log(`   Analysis results: ${context.analysisResults ? 'YES' : 'NO'}`)
      console.log(`   Total context size: ${applicationSummary.length + checklistSummary.length + analysisSection.length} chars`)
    } else if (context?.singleDocument) {
      // Legacy single document support
      const docSummary = JSON.stringify(context.singleDocument.data, null, 2).substring(0, 10000)
      userMessageContent += `\n\n[Document Context]:\n${docSummary}`
    }

    messages.push({
      role: 'user',
      content: userMessageContent
    })

    console.log(`🤖 Sending to model: ${deployment}`)
    console.log(`📊 Message length: ${userMessageContent.length} chars`)
    console.log('🌡️  Temperature: 0.3 (for focused, factual responses)')
    console.log('📡 OpenAI API Endpoint:', endpoint)
    console.log('📊 Request parameters:', {
      maxTokens: 3000,
      temperature: 0.3,
      topP: 0.95
    })

    const result = await client.getChatCompletions(deployment, messages, {
      maxTokens: 3000,
      temperature: 0.3, // Lower temperature for more focused, factual responses
      topP: 0.95
    })

    const response = result.choices[0]?.message?.content

    console.log('✅ Chat response generated')
    console.log('� OpenAI API Response:')
    console.log('  - Model:', result.model)
    console.log('  - Token usage:', {
      prompt: result.usage?.promptTokens,
      completion: result.usage?.completionTokens,
      total: result.usage?.totalTokens
    })
    console.log('  - Finish reason:', result.choices[0]?.finishReason)
    console.log('  - Response length:', response?.length || 0, 'chars')
    console.log('📄 Response preview (first 300 chars):', response?.substring(0, 300))

    res.json({
      success: true,
      message: response,
      usage: {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens
      },
      metadata: {
        model: deployment,
        finishReason: result.choices[0]?.finishReason,
        timestamp: new Date().toISOString()
      }
    })
  } catch (error) {
    console.error('❌ Chat error:', error)
    console.error('Error details:', error.message)
    res.status(500).json({
      error: 'Failed to process chat message',
      message: error.message,
      details: error.response?.data || error.toString()
    })
  }
})

export default router
