import express from 'express'
import { OpenAIClient, AzureKeyCredential } from '@azure/openai'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import applicationProcessingService from '../services/applicationProcessingService.js'
import cacheService from '../services/cacheService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
dotenv.config({ path: join(__dirname, '../../.env') })

const router = express.Router()

const endpoint = process.env.VITE_AZURE_OPENAI_ENDPOINT
const key = process.env.VITE_AZURE_OPENAI_KEY
const deployment = process.env.VITE_AZURE_OPENAI_DEPLOYMENT

let client = null
if (endpoint && key) {
  client = new OpenAIClient(endpoint, new AzureKeyCredential(key))
}

// Initialize service
await applicationProcessingService.initialize()

// Inject the compare function into the processing service
applicationProcessingService.setCompareFunction(async (applicationData, checklistData, selectedSections) => {
  if (!client) {
    throw new Error('Azure OpenAI not configured')
  }

  // Filter checklist sections based on selectedSections
  const selectedTitles = (selectedSections || []).map(s => s.sectionTitle)
  const selectedSectionNumbers = selectedTitles.map(title => {
    const match = title.match(/^(\d+)\./)
    return match ? match[1] : null
  }).filter(Boolean)

  const filteredSections = checklistData.sections?.filter(section => {
    const sectionTitle = section.title || ''
    const isMainSection = selectedTitles.some(title =>
      sectionTitle === title || sectionTitle.startsWith(title.substring(0, 10))
    )
    const isSubsection = selectedSectionNumbers.some(num => {
      const subsectionPattern = new RegExp(`^${num}\\.(\\d+)`)
      return subsectionPattern.test(sectionTitle)
    })
    return isMainSection || isSubsection
  }) || []

  const filteredTOC = checklistData.tableOfContents?.filter(toc =>
    selectedTitles.some(title => toc.title === title)
  ) || []

  const sectionsContent = filteredSections
    .map(section => {
      const sectionText = section.content?.map(c => c.text).join('\n') || ''
      return `\n=== ${section.title} ===\n${sectionText}`
    })
    .join('\n\n')

  const filteredChecklistData = {
    ...checklistData,
    sections: filteredSections,
    tableOfContents: filteredTOC,
    content: sectionsContent,
    selectedSectionNumbers
  }

  // Build the same system prompt used by the compare route
  const systemPrompt = `You are an expert CE (Continuing Education) compliance validator.
Your task is to compare an application document against a checklist or guide document.

CRITICAL VALIDATION RULES:
1. When a checklist requires a FORM to be completed, you MUST locate and verify all fields.
2. Use ACTUAL PDF page numbers from the extraction data.
3. EXTRACT EXACT TEXT - DO NOT INTERPRET OR PARAPHRASE.
4. For each requirement, determine if met/partial/not_met/not_applicable with exact evidence.

APPLICABILITY RULES:
- Determine the Application Type from the application data (e.g., "New", "Renewal", "Competing Continuation", "Supplemental").
- If a checklist section only applies to certain application types and the current application is a different type, mark as "not_applicable".
- Sections requiring SAAT data cross-referencing should be marked "partial" with explanation that SAAT verification is pending.
- "not_applicable" sections should NOT count toward the overall compliance percentage.

Return results in JSON format:
{
  "overallCompliance": "percentage (0-100, excluding not_applicable sections)",
  "applicationInfo": {
    "applicationType": "New | Renewal | Competing Continuation | Supplemental",
    "applicantName": "extracted applicant name",
    "grantNumber": "extracted grant number or N/A"
  },
  "summary": "brief overall summary",
  "sections": [
    {
      "checklistSection": "section name",
      "requirement": "requirement text",
      "status": "met" | "partial" | "not_met" | "not_applicable",
      "applicationSection": "corresponding section",
      "pageReferences": [],
      "evidence": "exact text from application",
      "explanation": "why meets/doesn't meet. For not_applicable: why this section doesn't apply.",
      "recommendation": "what needs to be done",
      "missingFields": []
    }
  ],
  "criticalIssues": [],
  "recommendations": []
}`

  const userMessage = `CHECKLIST/GUIDE DOCUMENT:
${JSON.stringify(filteredChecklistData, null, 2).substring(0, 30000)}

APPLICATION DOCUMENT:
${JSON.stringify(applicationData, null, 2).substring(0, 80000)}

Compare the application against the checklist requirements. Return JSON only.`

  // Add timeout to prevent infinite hangs (5 minutes)
  const timeoutMs = 5 * 60 * 1000
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI comparison timed out after 5 minutes')), timeoutMs)
  )
  
  const result = await Promise.race([
    client.getChatCompletions(deployment, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ], {
      temperature: 0,
      maxTokens: 16000,
      responseFormat: { type: 'json_object' }
    }),
    timeoutPromise
  ])

  const response = result.choices[0]?.message?.content
  let comparisonResult

  try {
    comparisonResult = JSON.parse(response)
  } catch (parseError) {
    comparisonResult = {
      overallCompliance: "0",
      summary: "Error: AI response was malformed or truncated.",
      sections: [],
      criticalIssues: ["Failed to parse AI response"],
      recommendations: ["Try selecting fewer sections"]
    }
  }

  return {
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
})

/**
 * GET /api/processed-applications
 * List all processed applications (metadata only)
 */
router.get('/', async (req, res) => {
  try {
    const applications = applicationProcessingService.listApplications()
    const status = applicationProcessingService.getStatus()
    res.json({ success: true, applications, status })
  } catch (error) {
    console.error('❌ List applications error:', error)
    res.status(500).json({ error: 'Failed to list applications', message: error.message })
  }
})

/**
 * GET /api/processed-applications/status
 * Get processing queue status
 */
router.get('/status', async (req, res) => {
  try {
    const status = applicationProcessingService.getStatus()
    res.json({ success: true, status })
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status', message: error.message })
  }
})

/**
 * GET /api/processed-applications/:id
 * Get a single application with full cached data
 */
router.get('/:id', async (req, res) => {
  try {
    const app = await applicationProcessingService.getApplication(req.params.id)
    if (!app) {
      return res.status(404).json({ error: 'Application not found' })
    }
    res.json({ success: true, application: app })
  } catch (error) {
    console.error('❌ Get application error:', error)
    res.status(500).json({ error: 'Failed to get application', message: error.message })
  }
})

/**
 * POST /api/processed-applications/queue
 * Queue one or more applications for background processing
 * Body: { applications: [{ name, data }], checklistData, selectedSections, checklistName }
 */
router.post('/queue', async (req, res) => {
  try {
    const { applications, checklistData, selectedSections, checklistName } = req.body

    if (!applications || applications.length === 0) {
      return res.status(400).json({ error: 'At least one application is required' })
    }
    if (!checklistData) {
      return res.status(400).json({ error: 'Checklist data is required' })
    }

    const queued = []
    for (const app of applications) {
      const meta = await applicationProcessingService.queueApplication({
        applicationName: app.name || app.originalName || 'Unknown Application',
        applicationData: app.data || app.analysis?.data,
        checklistData,
        selectedSections,
        checklistName
      })
      queued.push(meta)
    }

    console.log(`📋 Queued ${queued.length} application(s) for processing`)

    res.json({
      success: true,
      queued,
      status: applicationProcessingService.getStatus()
    })
  } catch (error) {
    console.error('❌ Queue applications error:', error)
    res.status(500).json({ error: 'Failed to queue applications', message: error.message })
  }
})

/**
 * POST /api/processed-applications/save
 * Save already-completed comparison results directly (no re-processing)
 * Body: { applicationName, checklistName, comparisonResult, selectedSections, applicationId }
 */
router.post('/save', async (req, res) => {
  try {
    const { applicationName, checklistName, comparisonResult, selectedSections, applicationId } = req.body

    if (!applicationName || !comparisonResult) {
      return res.status(400).json({ error: 'applicationName and comparisonResult are required' })
    }

    const meta = await applicationProcessingService.saveCompleted({
      applicationName,
      checklistName,
      comparisonResult,
      selectedSections,
      applicationId
    })

    console.log(`💾 Saved completed result: ${applicationName}`)

    res.json({
      success: true,
      application: meta
    })
  } catch (error) {
    console.error('❌ Save completed result error:', error)
    res.status(500).json({ error: 'Failed to save result', message: error.message })
  }
})

/**
 * DELETE /api/processed-applications/by-filter?fy=FY26&nofo=HRSA-26-006&checklistName=FY24
 * Delete CE processed applications matching FY, NOFO, and/or checklistName filter.
 * checklistName is the most reliable filter — matches the User Guide name stored in each app's metadata.
 * Also removes companion _checklist_comparison.json files. Does NOT touch pf-results/.
 */
router.delete('/by-filter', async (req, res) => {
  try {
    const { fy, nofo, checklistName } = req.query
    if (!fy && !nofo && !checklistName) {
      return res.status(400).json({ error: 'At least one of fy, nofo, or checklistName query param is required' })
    }
    const result = await applicationProcessingService.deleteByFilter({ fy, nofo, checklistName })
    res.json({
      success: true,
      message: `Deleted ${result.deleted} app(s) + ${result.companionFiles} checklist comparison file(s)`,
      ...result
    })
  } catch (error) {
    console.error('❌ Delete by filter error:', error)
    res.status(500).json({ error: 'Failed to delete by filter', message: error.message })
  }
})

/**
 * DELETE /api/processed-applications/all
 * Delete ALL processed applications and their cached data
 */
router.delete('/all', async (req, res) => {
  try {
    const count = await applicationProcessingService.deleteAllApplications()
    res.json({ success: true, message: `Deleted ${count} processed applications`, count })
  } catch (error) {
    console.error('❌ Delete all applications error:', error)
    res.status(500).json({ error: 'Failed to delete all applications', message: error.message })
  }
})

/**
 * DELETE /api/processed-applications/:id
 * Delete a processed application and its cached data
 */
router.delete('/:id', async (req, res) => {
  try {
    await applicationProcessingService.deleteApplication(req.params.id)
    res.json({ success: true, message: 'Application deleted' })
  } catch (error) {
    console.error('❌ Delete application error:', error)
    res.status(500).json({ error: 'Failed to delete application', message: error.message })
  }
})

/**
 * POST /api/processed-applications/:id/reprocess
 * Mark an application for reprocessing (requires re-submitting data)
 */
router.post('/:id/reprocess', async (req, res) => {
  try {
    const { applicationData, checklistData, selectedSections } = req.body
    const meta = applicationProcessingService.applications.get(req.params.id)
    
    if (!meta) {
      return res.status(404).json({ error: 'Application not found' })
    }

    // Delete old data
    await applicationProcessingService.deleteApplicationData(req.params.id)

    // Re-queue with fresh data
    meta.status = 'queued'
    meta.complianceScore = null
    meta.error = null
    await applicationProcessingService.saveIndex()

    // Add to processing queue
    applicationProcessingService.processingQueue.push({
      id: req.params.id,
      applicationData: applicationData || null,
      checklistData: checklistData || null,
      selectedSections: selectedSections || null
    })

    applicationProcessingService._processQueue()

    res.json({ success: true, application: meta })
  } catch (error) {
    console.error('❌ Reprocess error:', error)
    res.status(500).json({ error: 'Failed to reprocess', message: error.message })
  }
})

export default router
