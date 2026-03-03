import { useState, useEffect, useCallback } from 'react'
import Dashboard from './components/Dashboard'
import ChatInterface from './components/ChatInterface'
import ComparisonWorkflow from './components/ComparisonWorkflow'
import CategorizedComplianceReport from './components/CategorizedComplianceReport'
import ChecklistComparison from './components/ChecklistComparison'
import Settings from './components/Settings'
import ApplicationPageViewer from './components/ApplicationPageViewer'
import LogViewer from './components/LogViewer'
import PrefundingReviewResults from './components/PrefundingReviewResults'
import PfUploadManual from './components/PfUploadManual'
import PfAnalyzeApplication from './components/PfAnalyzeApplication'
import PfCompareWithPO from './components/PfCompareWithPO'
import Login from './components/Login'
import { getConfig, getDocumentById, getStoredChecklists, loadStoredChecklist, getPfResults } from './services/api'
import { bulkExportComplianceReport, bulkExportChecklistComparison } from './utils/bulkExport'
import { MessageSquare, Loader2 } from 'lucide-react'

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [reviewMode, setReviewMode] = useState('ce') // 'ce' or 'pf'
  const [activeTab, setActiveTab] = useState('dashboard')
  const [pfRules, setPfRules] = useState(null)
  const [pfRulesYear, setPfRulesYear] = useState('')
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [comparisonResult, setComparisonResult] = useState(null)
  const [cachedUploadedDocs, setCachedUploadedDocs] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDocuments, setChatDocuments] = useState({ application: null, checklist: null })
  const [pfResults, setPfResults] = useState(null)
  const [ceChatMessages, setCeChatMessages] = useState([])
  const [pfChatMessages, setPfChatMessages] = useState([])
  const [chatWidth, setChatWidth] = useState(384) // 96 * 4 = 384px (w-96)
  const [isResizing, setIsResizing] = useState(false)
  const [bulkExporting, setBulkExporting] = useState(null) // 'compliance' | 'checklist' | null
  const [bulkExportProgress, setBulkExportProgress] = useState('')
  const [pageViewerOpen, setPageViewerOpen] = useState(false)
  const [pageViewerContext, setPageViewerContext] = useState(null) // { page, sectionPages, sectionName }
  const [logViewerOpen, setLogViewerOpen] = useState(false)
  const [processingLogs, setProcessingLogs] = useState(() => {
    try {
      const saved = localStorage.getItem('ce_review_logs')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })

  // Check for stored authentication on mount
  useEffect(() => {
    const storedAuth = localStorage.getItem('hrsaAuth')
    if (storedAuth) {
      try {
        const authData = JSON.parse(storedAuth)
        setIsAuthenticated(true)
        setCurrentUser(authData)
      } catch (error) {
        localStorage.removeItem('hrsaAuth')
      }
    }
  }, [])

  // Authentication handlers
  const handleLogin = (userData) => {
    setIsAuthenticated(true)
    setCurrentUser(userData)
    localStorage.setItem('hrsaAuth', JSON.stringify(userData))
  }

  const handleLogout = () => {
    setIsAuthenticated(false)
    setCurrentUser(null)
    localStorage.removeItem('hrsaAuth')
    setActiveTab('dashboard')
    setPfResults(null)
    setComparisonResult(null)
  }

  const handleLog = (entry) => {
    setProcessingLogs(prev => {
      const updated = [...prev, entry]
      try { localStorage.setItem('ce_review_logs', JSON.stringify(updated.slice(-500))) } catch {}
      return updated
    })
  }

  const handleClearLogs = () => {
    setProcessingLogs([])
    try { localStorage.removeItem('ce_review_logs') } catch {}
  }

  // Listen for navigate-to-page events from checklist comparison — auto-open the page viewer
  useEffect(() => {
    const handler = (e) => {
      const page = e.detail?.page
      const pageOffset = e.detail?.pageOffset || 0
      if (page && page >= 1 && comparisonResult) {
        setPageViewerContext({ page, sectionPages: [page], sectionName: '', pageOffset })
        setPageViewerOpen(true)
      }
    }
    window.addEventListener('navigate-to-page', handler)
    return () => window.removeEventListener('navigate-to-page', handler)
  }, [comparisonResult])

  // Fetch and log server config (endpoints + folder paths) on first mount
  useEffect(() => {
    let mounted = true
    getConfig().then(config => {
      if (!mounted || !config) return
      const logEntry = (msg) => handleLog({ timestamp: new Date().toISOString(), level: 'info', message: msg })
      logEntry('── External Endpoints ──')
      logEntry(`  🌐 Azure Document Intelligence: ${config.endpoints?.azureDocIntelligence || '(not set)'}`)
      logEntry(`  🌐 Azure OpenAI: ${config.endpoints?.azureOpenAI || '(not set)'}`)
      logEntry(`  🤖 OpenAI Deployment: ${config.endpoints?.openAIDeployment || '(not set)'}`)
      logEntry('── API Endpoints ──')
      logEntry(`  🔗 CE Review Server: ${config.endpoints?.ceServer || '(not set)'}`)
      logEntry('── Folder Paths ──')
      if (config.folders) {
        Object.entries(config.folders).forEach(([key, val]) => {
          logEntry(`  📂 ${key}: ${val}`)
        })
      }
    })
    return () => { mounted = false }
  }, [])

  const handleComparisonComplete = (result) => {
    setComparisonResult(result)
    setActiveTab('report')
  }

  const handleViewResultsFromDashboard = (app) => {
    // Data from processed applications service contains the full comparison response
    // Structure: { success, comparison, usage, metadata }
    const data = app.data
    if (data) {
      const appName = app.name || 'Application'
      const checklistName = data.metadata?.checklistName || app.checklistName || 'Checklist'
      const applicationId = data.metadata?.applicationId || app.applicationId || null
      
      // Use persisted selectedSections from metadata if available, otherwise reconstruct
      let selectedSections = data.metadata?.selectedSections
      if (!selectedSections || selectedSections.length === 0) {
        const comparisonSections = data.comparison?.sections || []
        const sectionTitles = [...new Set(comparisonSections.map(s => {
          const match = (s.checklistSection || '').match(/^(\d+)\./) 
          return match ? `${match[1]}.` : null
        }).filter(Boolean))]
        selectedSections = sectionTitles.map(title => ({
          sectionTitle: title,
          checklistId: 'cached',
          checklistName: checklistName
        }))
      }

      // Build a result structure compatible with what ComparisonWorkflow produces
      const result = {
        results: [{
          ...data,
          applicationDoc: { id: applicationId, name: appName, originalName: appName },
          checklistDoc: { name: checklistName, originalName: checklistName }
        }],
        applications: [{ id: applicationId, name: appName, originalName: appName }],
        checklists: [{ name: checklistName, originalName: checklistName }],
        selectedSections
      }
      setComparisonResult(result)
      setReviewMode('ce')
      setActiveTab('report')

      // Load pre-funding review results by application number (async, non-blocking)
      const appNumMatch = (app.name || '').match(/Application-(\d+)/)
      if (appNumMatch) {
        getPfResults(appNumMatch[1]).then(pfResult => {
          if (pfResult?.success) {
            setPfResults(pfResult)
            console.log('📋 PF review results loaded for application', appNumMatch[1])
          } else {
            setPfResults(null)
            console.log('ℹ️ No PF review results for application', appNumMatch[1])
          }
        }).catch(e => {
          setPfResults(null)
          console.warn('⚠️ Could not load PF results:', e.message)
        })
      } else {
        setPfResults(null)
      }

      // Load application extraction data + matching checklist into chat context (async, non-blocking)
      // This does NOT affect the comparison result or any rules/prompts — only populates the chat panel
      ;(async () => {
        try {
          let appDoc = null
          let clDoc = null

          // 1. Load raw application extraction data by applicationId
          if (applicationId) {
            try {
              const docResult = await getDocumentById(applicationId)
              if (docResult?.document?.analysis?.data) {
                appDoc = {
                  name: appName,
                  originalName: docResult.document.originalName || appName,
                  data: docResult.document.analysis.data,
                  analysis: docResult.document.analysis
                }
              }
            } catch (e) {
              console.warn('⚠️ Could not load application extraction for chat:', e.message)
            }
          }

          // 2. Find and load the matching stored checklist by name
          if (checklistName) {
            try {
              const storedResult = await getStoredChecklists()
              const checklists = storedResult?.checklists || []
              const match = checklists.find(c =>
                (c.originalName || '').toLowerCase() === checklistName.toLowerCase() ||
                (c.displayName || '').toLowerCase() === checklistName.toLowerCase()
              )
              if (match) {
                const clResult = await loadStoredChecklist(match.id)
                if (clResult?.data) {
                  clDoc = {
                    name: checklistName,
                    originalName: clResult.originalName || checklistName,
                    data: clResult.data,
                    analysis: { data: clResult.data }
                  }
                }
              }
            } catch (e) {
              console.warn('⚠️ Could not load checklist for chat:', e.message)
            }
          }

          // Only update chat context if we found at least the application
          if (appDoc || clDoc) {
            setChatDocuments({
              application: appDoc,
              checklist: clDoc
            })
            console.log('💬 Chat context loaded from dashboard:', {
              application: appDoc ? appDoc.originalName : '(not available)',
              checklist: clDoc ? clDoc.originalName : '(not available)'
            })
          }
        } catch (e) {
          console.warn('⚠️ Failed to load chat context from dashboard:', e.message)
        }
      })()
    }
  }

  const handleDocumentsUploaded = (docs) => {
    setCachedUploadedDocs(docs)
    // Set documents for chat context
    if (docs.applications && docs.applications.length > 0) {
      setChatDocuments({
        application: docs.applications[0],
        checklist: docs.checklists && docs.checklists.length > 0 ? docs.checklists[0] : null
      })
    }
  }

  const handleMouseDown = (e) => {
    setIsResizing(true)
    e.preventDefault()
  }

  const handleMouseMove = (e) => {
    if (!isResizing) return
    
    const newWidth = window.innerWidth - e.clientX
    // Min width: 320px, Max width: 80% of screen
    const minWidth = 320
    const maxWidth = window.innerWidth * 0.8
    
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      setChatWidth(newWidth)
    }
  }

  const handleMouseUp = () => {
    setIsResizing(false)
  }

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isResizing])

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div style={{ minHeight: '100vh', background: '#EFF6FB', color: '#0B4778' }}>
      {/* Container */}
      <div style={{ maxWidth: '100%', margin: '0 auto', padding: '20px 20px 0 20px' }}>
        {/* HRSA Header */}
        <div className="ce-header" style={{ position: 'relative' }}>
          <div style={{
            position: 'absolute',
            top: '8px',
            right: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '0.8rem',
            color: '#FFFFFF'
          }}>
            <span>{currentUser?.username}</span>
            <span style={{ opacity: '0.5' }}>|</span>
            <button
              onClick={handleLogout}
              style={{
                background: 'none',
                color: '#FFFFFF',
                border: 'none',
                fontSize: '0.8rem',
                fontWeight: '400',
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: '0',
                transition: 'opacity 0.3s'
              }}
              onMouseEnter={(e) => e.target.style.opacity = '0.8'}
              onMouseLeave={(e) => e.target.style.opacity = '1'}
            >
              Logout
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <div style={{
              width: '60px', height: '60px',
              border: '3px solid #FFFFFF', borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, background: 'rgba(255, 255, 255, 0.1)'
            }}>
              <svg width="38" height="38" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="8" y="6" width="24" height="28" rx="2" stroke="#FFFFFF" strokeWidth="2" fill="none"/>
                <line x1="13" y1="14" x2="27" y2="14" stroke="#FFFFFF" strokeWidth="2"/>
                <line x1="13" y1="19" x2="27" y2="19" stroke="#FFFFFF" strokeWidth="2"/>
                <line x1="13" y1="24" x2="22" y2="24" stroke="#FFFFFF" strokeWidth="2"/>
                <path d="M22 26 L26 30 L34 20" stroke="#3b82f6" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: '600', color: '#FFFFFF', lineHeight: '1.3' }}>
                AI Review Assistant
              </h1>
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#FFFFFF', opacity: '0.9', lineHeight: '1.3' }}>
                AI-Powered Document Intelligence for CE & Pre-Funding Review
              </p>
            </div>
          </div>
        </div>

        {/* Card with red top accent */}
        <div className="ce-card">
          {/* Top-Level Navigation: Dashboard | CE Review | Pre-Funding Review | Settings */}
          <div style={{
            display: 'flex', gap: '4px', marginBottom: '0',
            background: '#f1f5f9', borderRadius: '10px', padding: '4px'
          }}>
            <button
              onClick={() => { setActiveTab('dashboard') }}
              style={{
                padding: '10px 24px', border: 'none', borderRadius: '8px',
                cursor: 'pointer', fontSize: '0.95rem', fontWeight: '600',
                transition: 'all 0.3s',
                background: activeTab === 'dashboard' ? '#0B4778' : 'transparent',
                color: activeTab === 'dashboard' ? '#FFFFFF' : '#64748b'
              }}
            >
              📊 Dashboard
            </button>
            <button
              onClick={() => {
                setReviewMode('ce')
                // Navigate to best CE tab
                if (!['compare', 'report', 'qa-comparison'].includes(activeTab)) {
                  setActiveTab(comparisonResult ? 'report' : 'compare')
                }
              }}
              style={{
                padding: '10px 24px', border: 'none', borderRadius: '8px',
                cursor: 'pointer', fontSize: '0.95rem', fontWeight: '600',
                transition: 'all 0.3s',
                background: reviewMode === 'ce' && activeTab !== 'dashboard' && activeTab !== 'settings' ? '#0B4778' : 'transparent',
                color: reviewMode === 'ce' && activeTab !== 'dashboard' && activeTab !== 'settings' ? '#FFFFFF' : '#64748b'
              }}
            >
              📄 CE Review
            </button>
            <button
              onClick={() => {
                setReviewMode('pf')
                // Navigate to best PF tab
                if (!['pf-upload', 'pf-analyze', 'pf-view-results', 'pf-compare-po'].includes(activeTab)) {
                  if (pfResults?.success) setActiveTab('pf-view-results')
                  else if (pfRules) setActiveTab('pf-analyze')
                  else setActiveTab('pf-upload')
                }
              }}
              style={{
                padding: '10px 24px', border: 'none', borderRadius: '8px',
                cursor: 'pointer', fontSize: '0.95rem', fontWeight: '600',
                transition: 'all 0.3s',
                background: reviewMode === 'pf' && activeTab !== 'dashboard' && activeTab !== 'settings' ? '#0B4778' : 'transparent',
                color: reviewMode === 'pf' && activeTab !== 'dashboard' && activeTab !== 'settings' ? '#FFFFFF' : '#64748b'
              }}
            >
              📋 Pre-Funding Review
            </button>
            <button
              onClick={() => { setActiveTab('settings') }}
              style={{
                padding: '10px 24px', border: 'none', borderRadius: '8px',
                cursor: 'pointer', fontSize: '0.95rem', fontWeight: '600',
                transition: 'all 0.3s', marginLeft: 'auto',
                background: activeTab === 'settings' ? '#0B4778' : 'transparent',
                color: activeTab === 'settings' ? '#FFFFFF' : '#64748b'
              }}
            >
              ⚙️ Settings
            </button>
          </div>

          {/* Sub-tabs — only show when in CE or PF mode (not dashboard/settings) */}
          {activeTab !== 'dashboard' && activeTab !== 'settings' && (
            <div className="ce-tabs" style={{ marginTop: '0', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
              {reviewMode === 'ce' && (
                <>
                  <button className={`ce-tab ${activeTab === 'compare' ? 'active' : ''}`} onClick={() => setActiveTab('compare')}>
                    Compare & Validate
                  </button>
                  {comparisonResult && (
                    <button className={`ce-tab ${activeTab === 'report' ? 'active' : ''}`} onClick={() => setActiveTab('report')}>
                      Compliance Report
                    </button>
                  )}
                  {comparisonResult && (
                    <button className={`ce-tab ${activeTab === 'qa-comparison' ? 'active' : ''}`} onClick={() => setActiveTab('qa-comparison')}>
                      Checklist Comparison
                    </button>
                  )}

                  {/* Bulk Export buttons — right-aligned */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {bulkExportProgress && (
                      <span style={{ fontSize: '0.8rem', color: '#0B4778', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Loader2 style={{ width: 14, height: 14, color: '#3b82f6' }} className="animate-spin" />
                        {bulkExportProgress}
                      </span>
                    )}
                    <button
                      onClick={async () => {
                        setBulkExporting('compliance')
                        setBulkExportProgress('Loading...')
                        try {
                          const count = await bulkExportComplianceReport((i, total, name) => setBulkExportProgress(`${i}/${total}: ${name}`))
                          setBulkExportProgress(`Exported ${count} rows`)
                          setTimeout(() => { setBulkExporting(null); setBulkExportProgress('') }, 2000)
                        } catch (err) {
                          setBulkExportProgress(`Error: ${err.message}`)
                          setTimeout(() => { setBulkExporting(null); setBulkExportProgress('') }, 3000)
                        }
                      }}
                      disabled={!!bulkExporting}
                      style={{ padding: '6px 12px', background: bulkExporting === 'compliance' ? '#D9E8F6' : '#0B4778', color: bulkExporting === 'compliance' ? '#0B4778' : 'white', border: 'none', borderRadius: '6px', fontSize: '0.8rem', fontWeight: '600', cursor: bulkExporting ? 'not-allowed' : 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                    >
                      {bulkExporting === 'compliance' ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : '\u2B07'} Export Compliance
                    </button>
                    <button
                      onClick={async () => {
                        setBulkExporting('checklist')
                        setBulkExportProgress('Loading...')
                        try {
                          const count = await bulkExportChecklistComparison((i, total, name) => setBulkExportProgress(`${i}/${total}: ${name}`))
                          setBulkExportProgress(`Exported ${count} rows`)
                          setTimeout(() => { setBulkExporting(null); setBulkExportProgress('') }, 2000)
                        } catch (err) {
                          setBulkExportProgress(`Error: ${err.message}`)
                          setTimeout(() => { setBulkExporting(null); setBulkExportProgress('') }, 3000)
                        }
                      }}
                      disabled={!!bulkExporting}
                      style={{ padding: '6px 12px', background: bulkExporting === 'checklist' ? '#D9E8F6' : '#0B4778', color: bulkExporting === 'checklist' ? '#0B4778' : 'white', border: 'none', borderRadius: '6px', fontSize: '0.8rem', fontWeight: '600', cursor: bulkExporting ? 'not-allowed' : 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                    >
                      {bulkExporting === 'checklist' ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : '\u2B07'} Export Checklist
                    </button>
                  </div>
                </>
              )}

              {reviewMode === 'pf' && (
                <>
                  <button className={`ce-tab ${activeTab === 'pf-upload' ? 'active' : ''}`} onClick={() => setActiveTab('pf-upload')}>
                    1. Upload Manual
                  </button>
                  <button
                    className={`ce-tab ${activeTab === 'pf-analyze' ? 'active' : ''}`}
                    onClick={() => setActiveTab('pf-analyze')}
                    disabled={!pfRules}
                  >
                    2. Analyze Application
                  </button>
                  <button
                    className={`ce-tab ${activeTab === 'pf-view-results' ? 'active' : ''}`}
                    onClick={() => setActiveTab('pf-view-results')}
                    disabled={!pfResults?.success}
                  >
                    3. View Results
                  </button>
                  <button
                    className={`ce-tab ${activeTab === 'pf-compare-po' ? 'active' : ''}`}
                    onClick={() => setActiveTab('pf-compare-po')}
                    disabled={!pfResults?.success}
                  >
                    Compare with PO Review
                  </button>
                </>
              )}
            </div>
          )}

          {/* Main Content */}
          {activeTab === 'dashboard' && (
            <Dashboard onViewResults={handleViewResultsFromDashboard} />
          )}

          {/* CE Mode Tabs */}
          {activeTab === 'compare' && (
            <ComparisonWorkflow 
              onComparisonComplete={handleComparisonComplete}
              cachedDocs={cachedUploadedDocs}
              onDocumentsUploaded={handleDocumentsUploaded}
              onLog={handleLog}
            />
          )}
          {activeTab === 'report' && (
            <CategorizedComplianceReport comparisonData={comparisonResult} onOpenPageViewer={(page, sectionPages, sectionName) => { setPageViewerContext({ page, sectionPages: sectionPages || [page], sectionName: sectionName || '' }); setPageViewerOpen(true); window.__pageViewerGoTo = page; }} />
          )}
          {activeTab === 'qa-comparison' && (
            <ChecklistComparison comparisonData={comparisonResult} />
          )}

          {/* PF Mode Tabs */}
          {activeTab === 'pf-upload' && (
            <PfUploadManual onRulesLoaded={(rules, year) => { setPfRules(rules); setPfRulesYear(year) }} />
          )}
          {activeTab === 'pf-analyze' && (
            <PfAnalyzeApplication
              pfRules={pfRules}
              onAnalysisComplete={(result) => {
                setPfResults(result)
                setActiveTab('pf-view-results')
              }}
            />
          )}
          {activeTab === 'pf-view-results' && pfResults?.success && (
            <PrefundingReviewResults pfData={pfResults.data} />
          )}
          {activeTab === 'pf-compare-po' && (
            <PfCompareWithPO pfResults={pfResults?.success ? pfResults.data : null} />
          )}

          {activeTab === 'settings' && (
            <Settings />
          )}
        </div>
      </div>

      {/* Compact Floating Toolbar — horizontal, bottom-right */}
      {!chatOpen && (
        <div style={{
          position: 'fixed', bottom: '16px', right: '16px',
          display: 'flex', gap: '6px', alignItems: 'center',
          background: '#0B4778', borderRadius: '24px', padding: '6px 10px',
          boxShadow: '0 4px 16px rgba(11,71,120,0.3)', zIndex: 50
        }}>
          {processingLogs.length > 0 && !logViewerOpen && (
            <button
              onClick={() => setLogViewerOpen(true)}
              style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.15)', color: '#FFFFFF', border: 'none', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', transition: 'background 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.3)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
              title="Processing Logs"
            >
              📋
              {processingLogs.filter(l => l.level === 'error').length > 0 && (
                <span style={{ position: 'absolute', top: '-2px', right: '-2px', background: '#dc2626', color: 'white', fontSize: '0.55rem', width: '14px', height: '14px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {processingLogs.filter(l => l.level === 'error').length}
                </span>
              )}
            </button>
          )}
          {comparisonResult && !pageViewerOpen && (
            <button
              onClick={() => setPageViewerOpen(true)}
              style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.15)', color: '#FFFFFF', border: 'none', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.3)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
              title="View Application Pages"
            >
              📖
            </button>
          )}
          <button
            onClick={() => setChatOpen(true)}
            style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.2)', color: '#FFFFFF', border: 'none', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.35)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
            title="Chat with AI"
          >
            💬
          </button>
        </div>
      )}

      {/* Slide-out Log Viewer */}
      <LogViewer
        logs={processingLogs}
        isOpen={logViewerOpen}
        onClose={() => setLogViewerOpen(false)}
        onClear={handleClearLogs}
      />

      {/* Slide-out Application Page Viewer */}
      <ApplicationPageViewer
        comparisonData={comparisonResult}
        isOpen={pageViewerOpen}
        onClose={() => { setPageViewerOpen(false); setPageViewerContext(null); }}
        sectionContext={pageViewerContext}
      />

      {/* Slide-out Chat Panel */}
      {chatOpen && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: `${chatWidth}px`,
          background: '#FFFFFF', borderLeft: '2px solid #D9E8F6',
          boxShadow: '-4px 0 20px rgba(0,0,0,0.15)', zIndex: 50,
          display: 'flex', flexDirection: 'column'
        }}>
          {/* Resize Handle */}
          <div
            style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: isResizing ? '4px' : '2px',
              background: isResizing ? '#7c3aed' : '#D9E8F6',
              cursor: 'col-resize', transition: 'all 0.2s'
            }}
            onMouseDown={handleMouseDown}
            onMouseEnter={(e) => { e.currentTarget.style.width = '4px'; e.currentTarget.style.background = '#7c3aed' }}
            onMouseLeave={(e) => { if (!isResizing) { e.currentTarget.style.width = '2px'; e.currentTarget.style.background = '#D9E8F6' } }}
            title="Drag to resize"
          />
          
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderBottom: '2px solid #D9E8F6', background: '#0B4778' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.2rem' }}>💬</span>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '600', color: '#FFFFFF', margin: 0 }}>
                Chat — {reviewMode === 'pf' ? 'Pre-Funding Review' : 'CE Review'}
              </h3>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              style={{ background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', padding: '6px 10px', borderRadius: '6px', color: '#FFFFFF', fontSize: '1rem', transition: 'background 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.25)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
              title="Close chat"
            >
              ✕
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ChatInterface 
              document={selectedDocument}
              applicationDoc={chatDocuments.application}
              checklistDoc={chatDocuments.checklist}
              comparisonResult={comparisonResult}
              activeTab={activeTab}
              reviewMode={reviewMode}
              pfData={pfResults?.success ? pfResults.data : null}
              messages={reviewMode === 'pf' ? pfChatMessages : ceChatMessages}
              setMessages={reviewMode === 'pf' ? setPfChatMessages : setCeChatMessages}
            />
          </div>
        </div>
      )}

      {/* Overlay when chat is open */}
      {chatOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }}
          onClick={() => setChatOpen(false)}
        />
      )}
    </div>
  )
}

export default App
