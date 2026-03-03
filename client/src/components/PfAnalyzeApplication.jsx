import { useState } from 'react'
import { uploadDocument } from '../services/api'
import { runPfAnalysis } from '../services/api'

export default function PfAnalyzeApplication({ pfRules, onAnalysisComplete }) {
  const [applicationFile, setApplicationFile] = useState(null)
  const [applicationName, setApplicationName] = useState('')
  const [processing, setProcessing] = useState(false)
  const [status, setStatus] = useState('')
  const [progressLog, setProgressLog] = useState([])

  const addLog = (msg) => setProgressLog(prev => [...prev, msg])

  const handleAnalysis = async () => {
    if (!applicationFile || !applicationName || !pfRules) return
    setProcessing(true)
    setStatus('')
    setProgressLog([])

    try {
      addLog('📄 Step 1/3: Uploading and extracting text from application PDF...')

      const uploadResult = await uploadDocument(applicationFile)
      if (!uploadResult.success) throw new Error('Failed to extract text from PDF')

      // Build plain text from extracted pages using page.lines (ALL text on every page)
      // page.lines is the complete text from Azure DI — sections[] is a lossy restructuring
      // that only captures paragraphs after DI-tagged headings, losing most content.
      // This matches how AIPrefundingReview uses raw paragraphs from Azure DI.
      const data = uploadResult.data || {}
      const pages = data.pages || []
      const tables = data.tables || []

      // Build footer page number map (Azure page → PDF footer page)
      const footerPageMap = {}
      pages.forEach((page, idx) => {
        const azurePageNum = page.pageNumber || (idx + 1)
        const lines = page.lines || []
        for (const line of lines) {
          const m = (line.content || '').match(/Page Number:\s*(\d+)/i)
          if (m) { footerPageMap[azurePageNum] = m[1]; break }
        }
        if (!footerPageMap[azurePageNum]) footerPageMap[azurePageNum] = String(azurePageNum)
      })

      // Group ALL page lines by footer page number
      const pageContent = {}
      pages.forEach((page, idx) => {
        const azurePageNum = page.pageNumber || (idx + 1)
        const pageNum = footerPageMap[azurePageNum] || azurePageNum
        if (!pageContent[pageNum]) pageContent[pageNum] = []
        ;(page.lines || []).forEach(line => {
          const text = line.content || ''
          if (text && !text.match(/Page Number:\s*\d+/i) && !text.match(/Tracking Number/i)) {
            pageContent[pageNum].push(`[TEXT] ${text}`)
          }
        })
      })

      // Add tables to their respective pages
      tables.forEach((table, tIdx) => {
        const pageNum = footerPageMap[table.pageNumber] || table.pageNumber || 1
        if (!pageContent[pageNum]) pageContent[pageNum] = []
        let tableText = `[TABLE] Table ${tIdx + 1}:\n`
        ;(table.structuredData || []).forEach(row => {
          tableText += Object.values(row).join(' | ') + '\n'
        })
        pageContent[pageNum].push(tableText)
      })

      // Build final text sorted by page number
      let applicationText = ''
      const sortedPages = Object.keys(pageContent).sort((a, b) => parseInt(a) - parseInt(b))
      sortedPages.forEach(pageNum => {
        applicationText += `\n\n========== PAGE ${pageNum} (from PDF footer) ==========\n\n`
        pageContent[pageNum].forEach(line => {
          applicationText += line + '\n\n'
        })
      })

      if (!applicationText || applicationText.length < 500) {
        throw new Error('Extracted text is too short. Please ensure the PDF contains readable text.')
      }

      addLog(`✅ Extracted ${(applicationText.length / 1024).toFixed(0)}KB of text from ${pages.length} pages`)
      addLog(`🤖 Step 2/3: Sending to AI for compliance analysis (this may take 30-90 seconds)...`)

      // Step 2: Run PF analysis
      const result = await runPfAnalysis(applicationText, pfRules, applicationName)

      if (result.success) {
        addLog(`✅ Step 3/3: Analysis complete!`)

        // Count results
        let compliant = 0, nonCompliant = 0, na = 0
        Object.values(result.results).forEach(s => {
          compliant += s.compliantItems?.length || 0
          nonCompliant += s.nonCompliantItems?.length || 0
          na += s.notApplicableItems?.length || 0
        })
        addLog(`📊 Results: ✅ ${compliant} Compliant | ❌ ${nonCompliant} Non-Compliant | ⊘ ${na} N/A`)

        setStatus('✅ Analysis complete! Switching to View Results...')

        if (onAnalysisComplete) {
          onAnalysisComplete({
            success: true,
            data: {
              results: result.results,
              filename: applicationName,
              applicationName
            }
          })
        }
      } else {
        throw new Error(result.error || 'Analysis failed')
      }
    } catch (err) {
      addLog(`❌ Error: ${err.message}`)
      setStatus(`❌ ${err.message}`)
    } finally {
      setProcessing(false)
    }
  }

  const handleDragOver = (e) => { e.preventDefault(); e.currentTarget.style.borderColor = '#3b82f6' }
  const handleDragLeave = (e) => { e.currentTarget.style.borderColor = '#D9E8F6' }
  const handleDrop = (e) => {
    e.preventDefault()
    e.currentTarget.style.borderColor = '#D9E8F6'
    const file = e.dataTransfer.files[0]
    if (file && file.type === 'application/pdf') {
      setApplicationFile(file)
      setApplicationName(file.name.replace('.pdf', ''))
    }
  }

  const rulesReady = pfRules && pfRules.length > 0

  return (
    <div style={{ padding: '20px 0' }}>
      <h2 style={{ color: '#0B4778', marginBottom: '20px' }}>Analyze Health Center Application</h2>

      {!rulesReady && (
        <div style={{
          padding: '20px', background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: '10px', marginBottom: '20px', textAlign: 'center'
        }}>
          <p style={{ color: '#dc2626', fontWeight: '600', fontSize: '1rem', margin: 0 }}>
            ⚠️ Please upload a Guiding Principles document first (Step 1: Upload Manual)
          </p>
        </div>
      )}

      {/* Application Name */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', color: '#0B4778', fontSize: '1rem' }}>
          Application Name
        </label>
        <input
          type="text"
          placeholder="e.g., Community Health Center 2024"
          value={applicationName}
          onChange={(e) => setApplicationName(e.target.value)}
          style={{
            width: '100%', padding: '12px 16px', fontSize: '1rem',
            border: '2px solid #D9E8F6', borderRadius: '8px',
            background: 'white', color: '#0B4778', fontWeight: '500',
            boxSizing: 'border-box'
          }}
        />
      </div>

      {/* File Upload */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => document.getElementById('pf-app-input').click()}
        style={{
          padding: '40px 20px', textAlign: 'center', cursor: rulesReady ? 'pointer' : 'not-allowed',
          border: '2px dashed #D9E8F6', borderRadius: '12px',
          background: rulesReady ? '#f8fafc' : '#f1f5f9', marginBottom: '20px',
          opacity: rulesReady ? 1 : 0.6, transition: 'all 0.3s'
        }}
      >
        <div style={{ fontSize: '2.5rem', marginBottom: '10px' }}>📑</div>
        <h3 style={{ color: '#0B4778', fontWeight: '600', marginBottom: '8px' }}>
          {applicationFile ? applicationFile.name : 'Drop PDF here or click to upload'}
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.9rem' }}>Health Center Application PDF</p>
        <input
          id="pf-app-input"
          type="file"
          accept=".pdf"
          style={{ display: 'none' }}
          disabled={!rulesReady}
          onChange={(e) => {
            const file = e.target.files[0]
            if (file) {
              setApplicationFile(file)
              if (!applicationName) setApplicationName(file.name.replace('.pdf', ''))
            }
          }}
        />
      </div>

      <button
        onClick={handleAnalysis}
        disabled={!applicationFile || !applicationName || processing || !rulesReady}
        style={{
          width: '100%', padding: '14px',
          background: (!applicationFile || !applicationName || processing || !rulesReady) ? '#94a3b8' : '#0B4778',
          color: 'white', border: 'none', borderRadius: '8px', fontSize: '1rem',
          fontWeight: '600', cursor: (!applicationFile || !applicationName || processing || !rulesReady) ? 'not-allowed' : 'pointer',
          transition: 'all 0.3s'
        }}
      >
        {processing ? '⏳ Analyzing...' : '🚀 Analyze Compliance'}
      </button>

      {/* Status */}
      {status && progressLog.length === 0 && (
        <div style={{
          marginTop: '20px', padding: '12px 16px',
          background: status.startsWith('❌') ? '#fef2f2' : '#EFF6FB',
          border: `1px solid ${status.startsWith('❌') ? '#fecaca' : '#D9E8F6'}`,
          borderRadius: '8px', color: status.startsWith('❌') ? '#dc2626' : '#0B4778'
        }}>
          {status}
        </div>
      )}

      {/* Progress Log */}
      {progressLog.length > 0 && (
        <div style={{
          marginTop: '20px', padding: '15px',
          background: '#FFFFFF', border: '1px solid #D9E8F6',
          borderRadius: '8px', maxHeight: '300px', overflowY: 'auto'
        }}>
          <div style={{ fontSize: '0.9rem', color: '#0B4778', fontFamily: 'monospace' }}>
            {progressLog.map((log, index) => (
              <div key={index} style={{ marginBottom: '5px', padding: '3px 0' }}>{log}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
