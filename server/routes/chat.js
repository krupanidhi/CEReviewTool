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
      hasSingleDoc: !!context?.singleDocument
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
    let systemPrompt = `You are an expert compliance validation assistant specialized in CE (Continuing Education) review and grant application analysis.

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

    // Add context-specific instructions
    if (context?.application && context?.checklist) {
      systemPrompt += `AVAILABLE DOCUMENTS:
✓ Application Document: ${context.application.name}
✓ Checklist/Guide Document: ${context.checklist.name}

IMPORTANT: Both documents include structured table data in JSON format. When answering questions about forms, service sites, or any tabular information:
- The application document contains 94 tables - you must search through ALL tables to find the specific form requested
- Use the "tables" array with "structuredData" field
- Each table has a "tableTitle" field to help identify it (e.g., tables with "Site Name" key are likely Form 5B)
- Each table has structured JSON with column headers as keys
- For example, Form 5B service sites have fields like "Site Name", "Physical Site Address", "Site Type", etc.
- SEARCH ALL TABLES: Look through the entire tables array to find tables with relevant column names matching the user's question

INTELLIGENT Q&A APPROACH:
When the user asks a question:
1. Identify which checklist section(s) are relevant
2. Extract the specific requirements from the checklist
3. Search BOTH text sections AND structured table data in the application
4. For questions about forms (e.g., Form 5B, Form 6A), look in the tables array
5. Provide:
   - Checklist requirement reference (section number and title)
   - Evidence from application (exact quotes with page numbers OR table data)
   - Compliance status (met/partial/not met)
   - Clear explanation of your findings
   - Recommendations if needed

EXAMPLE RESPONSE FORMAT FOR TABLE DATA:
"Based on your question about Form 5B Service Sites:

**Checklist Requirement:**
Section 3.3.2 requires completion of Form 5B with service site details

**Evidence Found:**
The application includes Form 5B data on page X with the following service sites:

| Site Name | Physical Address | Site Type | Phone Number |
|-----------|------------------|-----------|--------------|
| [data from structuredData] | ... | ... | ... |

**Compliance Status:** Met/Partial/Not Met

**Explanation:** [reasoning based on table data]

**Recommendation:** [if needed]"

Be thorough, specific, and always reference both text sections and structured table data.`
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

    // Append document context intelligently with structured table data
    if (context?.application && context?.checklist) {
      // Intelligent table filtering: prioritize tables relevant to user's question
      const userQuestion = message.toLowerCase()
      const allTables = context.application.data?.tables || []
      
      // Identify relevant keywords from user's question
      const keywords = {
        form5b: userQuestion.includes('form 5b') || userQuestion.includes('form5b') || userQuestion.includes('service site'),
        form6a: userQuestion.includes('form 6a') || userQuestion.includes('form6a') || userQuestion.includes('board member'),
        site: userQuestion.includes('site') || userQuestion.includes('location') || userQuestion.includes('address'),
        board: userQuestion.includes('board') || userQuestion.includes('governance'),
        budget: userQuestion.includes('budget') || userQuestion.includes('funding') || userQuestion.includes('financial')
      }
      
      // Filter and prioritize tables based on relevance
      let relevantTables = []
      let otherTables = []
      
      allTables.forEach(table => {
        const firstRow = table.structuredData?.[0]
        if (!firstRow) {
          otherTables.push(table)
          return
        }
        
        const tableKeys = Object.keys(firstRow).map(k => k.toLowerCase())
        const tableValues = Object.values(firstRow).map(v => String(v).toLowerCase())
        const tableContent = [...tableKeys, ...tableValues].join(' ')
        
        // Score table relevance
        let relevanceScore = 0
        if (keywords.form5b && (tableKeys.includes('site name') || tableKeys.includes('physical site address'))) relevanceScore += 10
        if (keywords.form6a && (tableKeys.includes('board member') || tableContent.includes('board'))) relevanceScore += 10
        if (keywords.site && tableKeys.some(k => k.includes('site'))) relevanceScore += 5
        if (keywords.board && tableKeys.some(k => k.includes('board'))) relevanceScore += 5
        if (keywords.budget && tableKeys.some(k => k.includes('budget') || k.includes('funding'))) relevanceScore += 5
        
        // Extract table title
        const possibleTitle = tableKeys.find(key => 
          key.includes('form') || key.includes('table') || key.includes('site') || key.includes('board')
        )
        
        const tableWithMetadata = {
          id: table.id,
          pageNumber: table.pageNumber,
          rowCount: table.rowCount,
          columnCount: table.columnCount,
          tableTitle: possibleTitle || `Table on page ${table.pageNumber}`,
          structuredData: table.structuredData,
          relevanceScore: relevanceScore
        }
        
        if (relevanceScore > 0) {
          relevantTables.push(tableWithMetadata)
        } else {
          otherTables.push(tableWithMetadata)
        }
      })
      
      // Sort relevant tables by score
      relevantTables.sort((a, b) => b.relevanceScore - a.relevanceScore)
      
      // Include top relevant tables + sample of others
      const tablesToInclude = [
        ...relevantTables.slice(0, 20), // Top 20 relevant tables
        ...otherTables.slice(0, 10)      // First 10 other tables for context
      ]
      
      const applicationSummary = JSON.stringify({
        sections: context.application.data?.sections?.slice(0, 50) || [],
        tableOfContents: context.application.data?.tableOfContents || [],
        tables: tablesToInclude,
        figures: context.application.data?.figures?.map(fig => ({
          id: fig.id,
          pageNumber: fig.pageNumber,
          caption: fig.caption
        })) || [],
        keyValuePairs: context.application.data?.keyValuePairs || [],
        pages: context.application.data?.pages?.length || 0
      }, null, 2).substring(0, 150000) // Increased to 150K for relevant tables

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

      userMessageContent += `\n\n[APPLICATION DOCUMENT DATA]:\n${applicationSummary}\n\n[CHECKLIST/GUIDE DOCUMENT DATA]:\n${checklistSummary}`
      
      // Log what table data is being sent to AI for verification
      console.log('📊 Sending table data to AI:')
      console.log(`   Total application tables: ${allTables.length}`)
      console.log(`   Relevant tables found: ${relevantTables.length}`)
      console.log(`   Tables being sent to AI: ${tablesToInclude.length}`)
      console.log(`   Context size: ${applicationSummary.length} chars`)
      
      // Log top relevant tables
      if (relevantTables.length > 0) {
        console.log(`   Top relevant tables:`)
        relevantTables.slice(0, 5).forEach(t => {
          const firstRow = t.structuredData?.[0]
          const keys = firstRow ? Object.keys(firstRow).slice(0, 3).join(', ') : 'no data'
          console.log(`     - ${t.id} (page ${t.pageNumber}, score: ${t.relevanceScore}): ${keys}`)
        })
      }
      
      // Check if Form 5B is in the context
      const hasForm5B = applicationSummary.toLowerCase().includes('abbotsford') || 
                        applicationSummary.toLowerCase().includes('abbottsford')
      console.log(`   ⚠️  Form 5B data (Abbotsford) included in context: ${hasForm5B ? 'YES ✓' : 'NO ✗'}`)
      
      // Find and log the specific Form 5B service sites table
      const form5BTable = tablesToInclude.find(t => 
        t.structuredData?.some(row => {
          const rowStr = JSON.stringify(row).toLowerCase()
          return (rowStr.includes('abbotsford') || rowStr.includes('abbottsford')) &&
                 (rowStr.includes('site name') || rowStr.includes('physical'))
        })
      )
      
      if (form5BTable) {
        console.log(`   ✓ Form 5B service sites table: ${form5BTable.id} on page ${form5BTable.pageNumber}`)
        const sampleRow = form5BTable.structuredData?.find(row => 
          JSON.stringify(row).toLowerCase().includes('abbotsford')
        )
        if (sampleRow) {
          console.log(`   Form 5B sample:`, JSON.stringify(sampleRow, null, 2).substring(0, 400))
        }
      } else {
        console.log(`   ✗ Form 5B service sites table NOT found in selected tables`)
      }
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
