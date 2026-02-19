import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs/promises'
import uploadRoutes from './routes/upload.js'
import analyzeRoutes from './routes/analyze.js'
import documentsRoutes from './routes/documents.js'
import chatRoutes from './routes/chat.js'
import compareRoutes from './routes/compare.js'
import settingsRoutes from './routes/settings.js'
import qaComparisonRoutes from './routes/qaComparison.js'
import storedChecklistsRoutes from './routes/storedChecklists.js'
import processedApplicationsRoutes from './routes/processedApplications.js'
import adminRoutes from './routes/admin.js'
import saatRoutes from './routes/saat.js'
import applicationsRoutes from './routes/applications.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

dotenv.config({ path: join(__dirname, '../.env') })

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// Routes
app.use('/api/upload', uploadRoutes)
app.use('/api/analyze', analyzeRoutes)
app.use('/api/documents', documentsRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/compare', compareRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/qa-comparison', qaComparisonRoutes)
app.use('/api/stored-checklists', storedChecklistsRoutes)
app.use('/api/processed-applications', processedApplicationsRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/saat', saatRoutes)
app.use('/api/applications', applicationsRoutes)

// Logs endpoint — save and retrieve processing logs as text files
const logsDir = join(__dirname, '../logs')

app.post('/api/logs/save', async (req, res) => {
  try {
    await fs.mkdir(logsDir, { recursive: true })
    const { logs, sessionId } = req.body
    if (!logs || !Array.isArray(logs)) return res.status(400).json({ error: 'logs array required' })
    const text = logs.map(l => `[${l.timestamp}] [${l.level?.toUpperCase() || 'INFO'}] ${l.message}${l.data ? ' | ' + JSON.stringify(l.data) : ''}`).join('\n')
    const filename = `ce-review-logs_${sessionId || new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    const filepath = join(logsDir, filename)
    await fs.writeFile(filepath, text, 'utf-8')
    res.json({ success: true, filename, path: filepath })
  } catch (err) {
    console.error('Failed to save logs:', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/logs', async (req, res) => {
  try {
    await fs.mkdir(logsDir, { recursive: true })
    const files = await fs.readdir(logsDir)
    const logFiles = files.filter(f => f.endsWith('.txt')).sort().reverse()
    res.json({ success: true, files: logFiles, directory: logsDir })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Configuration endpoint — returns endpoints and folder paths for UI logging
const ceRoot = join(__dirname, '..')
app.get('/api/config', (req, res) => {
  res.json({
    endpoints: {
      azureDocIntelligence: process.env.VITE_AZURE_DOC_ENDPOINT || '(not set)',
      azureOpenAI: process.env.VITE_AZURE_OPENAI_ENDPOINT || '(not set)',
      openAIDeployment: process.env.VITE_AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
      ceServer: `http://localhost:${PORT}`,
    },
    folders: {
      applications: join(ceRoot, 'applications'),
      userGuides: join(ceRoot, 'userGuides'),
      checklistQuestions: join(ceRoot, 'checklistQuestions'),
      saat: join(ceRoot, 'SAAT'),
      data: join(ceRoot, 'data'),
      processedApplications: join(ceRoot, 'processed-applications'),
      extractions: join(ceRoot, 'extractions'),
      documents: join(ceRoot, 'documents'),
      storedChecklists: join(ceRoot, 'stored-checklists'),
      logs: join(ceRoot, 'logs'),
    }
  })
})

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      documentIntelligence: !!process.env.VITE_AZURE_DOC_ENDPOINT,
      openAI: !!process.env.VITE_AZURE_OPENAI_ENDPOINT
    }
  })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err)
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  })
})

app.listen(PORT, () => {
  console.log(`🚀 CE Review Tool API Server running on http://localhost:${PORT}`)
  console.log(`📄 Document Intelligence: ${process.env.VITE_AZURE_DOC_ENDPOINT ? '✓' : '✗'}`)
  console.log(`🤖 Azure OpenAI: ${process.env.VITE_AZURE_OPENAI_ENDPOINT ? '✓' : '✗'}`)
})

