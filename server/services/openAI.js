import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const endpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const key = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

if (!endpoint || !key || !deployment) {
  throw new Error('Azure OpenAI credentials not configured')
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(key))

/**
 * Analyze document data with Azure OpenAI
 * @param {Object} documentData - Extracted document data
 * @param {string} prompt - Analysis prompt/instructions
 * @returns {Promise<Object>} AI analysis results
 */
export async function analyzeWithAI(documentData, prompt) {
  try {
    console.log('🤖 Starting AI analysis...')
    
    const systemPrompt = `You are an expert CE (Continuing Education) Review Check List Validator. 
Your task is to analyze documents and extract structured information according to CE review standards.
Provide detailed, accurate analysis and return results in JSON format.`

    const userPrompt = prompt || `Analyze the following document data and extract key information:

${JSON.stringify(documentData, null, 2)}

Please provide:
1. Document type and purpose
2. Key findings and observations
3. Compliance check results
4. Recommendations
5. Any issues or concerns

Return your analysis in structured JSON format.`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    const result = await client.getChatCompletions(deployment, messages, {
      maxTokens: 4000,
      temperature: 0.3,
      topP: 0.95
    })

    const response = result.choices[0]?.message?.content

    console.log('✅ AI analysis complete')

    return {
      success: true,
      analysis: response,
      usage: {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens
      },
      metadata: {
        model: deployment,
        finishReason: result.choices[0]?.finishReason,
        analyzedAt: new Date().toISOString()
      }
    }
  } catch (error) {
    console.error('❌ AI analysis error:', error)
    throw new Error(`AI analysis failed: ${error.message}`)
  }
}

/**
 * Validate document against checklist using fine-tuned model
 * @param {Object} documentData - Extracted document data
 * @param {Array} checklist - Validation checklist items
 * @returns {Promise<Object>} Validation results
 */
export async function validateWithChecklist(documentData, checklist) {
  try {
    console.log('✅ Starting checklist validation...')
    
    const systemPrompt = `You are a CE Review Check List Validator. Validate the document against the provided checklist items.
For each checklist item, determine if it is satisfied, partially satisfied, or not satisfied.
Provide evidence from the document for each determination.`

    const userPrompt = `Document Data:
${JSON.stringify(documentData, null, 2)}

Checklist Items:
${JSON.stringify(checklist, null, 2)}

For each checklist item, provide:
- status: "satisfied" | "partial" | "not_satisfied"
- evidence: Text from document supporting the determination
- notes: Additional observations or concerns

Return results in JSON format with structure:
{
  "validationResults": [
    {
      "checklistItem": "item description",
      "status": "satisfied",
      "evidence": "quote from document",
      "notes": "additional notes"
    }
  ],
  "overallCompliance": "percentage",
  "summary": "brief summary"
}`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    const result = await client.getChatCompletions(deployment, messages, {
      maxTokens: 4000,
      temperature: 0.2,
      topP: 0.9
    })

    const response = result.choices[0]?.message?.content

    console.log('✅ Checklist validation complete')

    return {
      success: true,
      validation: response,
      usage: {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        totalTokens: result.usage?.totalTokens
      },
      metadata: {
        model: deployment,
        checklistItemCount: checklist?.length || 0,
        analyzedAt: new Date().toISOString()
      }
    }
  } catch (error) {
    console.error('❌ Checklist validation error:', error)
    throw new Error(`Checklist validation failed: ${error.message}`)
  }
}
