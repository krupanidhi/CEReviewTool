import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import uploadRoutes from './routes/upload.js'
import analyzeRoutes from './routes/analyze.js'
import documentsRoutes from './routes/documents.js'
import chatRoutes from './routes/chat.js'
import compareRoutes from './routes/compare.js'
import settingsRoutes from './routes/settings.js'

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

