import { useState, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { getProcessedApplications, getProcessedApplication, deleteProcessedApplication, deleteAllProcessedApplications } from '../services/api'
import { bulkExportComplianceReport, bulkExportChecklistComparison } from '../utils/bulkExport'

export default function Dashboard({ onViewResults }) {
  const [applications, setApplications] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [processingStatus, setProcessingStatus] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage] = useState(12)
  const [exporting, setExporting] = useState(null) // 'compliance' | 'checklist' | null
  const [exportProgress, setExportProgress] = useState('')
  const pollRef = useRef(null)

  useEffect(() => {
    loadApplications()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // Start/stop polling based on whether any apps are processing
  useEffect(() => {
    const hasProcessing = applications.some(a => a.status === 'processing' || a.status === 'queued')
    if (hasProcessing && !pollRef.current) {
      pollRef.current = setInterval(loadApplications, 5000)
    } else if (!hasProcessing && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [applications])

  const loadApplications = async () => {
    try {
      const result = await getProcessedApplications()
      setApplications(result.applications || [])
      setProcessingStatus(result.status || null)
    } catch (error) {
      console.error('Failed to load applications:', error)
      setApplications([])
    } finally {
      setLoading(false)
    }
  }

  const handleViewResults = async (app) => {
    if (app.status !== 'completed') return
    try {
      const result = await getProcessedApplication(app.id)
      if (result.application?.data && onViewResults) {
        onViewResults({
          id: app.id,
          name: app.name,
          data: result.application.data
        })
      }
    } catch (error) {
      console.error('Failed to load application data:', error)
    }
  }

  const handleDelete = async (id, e) => {
    e.stopPropagation()
    if (!confirm('Delete this application and its cached results?')) return
    try {
      await deleteProcessedApplication(id)
      setApplications(prev => prev.filter(a => a.id !== id))
    } catch (error) {
      console.error('Failed to delete application:', error)
    }
  }

  const handleDeleteAll = async () => {
    if (!confirm(`Delete all ${applications.length} processed applications? This cannot be undone.`)) return
    try {
      await deleteAllProcessedApplications()
      setApplications([])
      setCurrentPage(1)
    } catch (error) {
      console.error('Failed to delete all applications:', error)
    }
  }

  const getComplianceColor = (score) => {
    const num = parseInt(score)
    if (num >= 80) return '#16a34a'
    if (num >= 60) return '#ca8a04'
    return '#dc2626'
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    })
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px' }}>
        <Loader2 style={{ width: 32, height: 32, color: '#3b82f6' }} className="animate-spin" />
      </div>
    )
  }

  const filteredApps = applications.filter(app =>
    !searchQuery ||
    app.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    app.id?.toLowerCase().includes(searchQuery.toLowerCase())
  ).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))

  const totalPages = Math.ceil(filteredApps.length / itemsPerPage)
  const startIdx = (currentPage - 1) * itemsPerPage
  const currentApps = filteredApps.slice(startIdx, startIdx + itemsPerPage)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <h2 style={{ color: '#0B4778', fontSize: '1.5rem', fontWeight: '700', margin: 0 }}>
          Dashboard - Analyzed Applications
        </h2>
        {applications.filter(a => a.status === 'completed').length > 0 && (
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={async () => {
                setExporting('compliance')
                setExportProgress('Loading...')
                try {
                  const count = await bulkExportComplianceReport((i, total, name) => setExportProgress(`${i}/${total}: ${name}`))
                  setExportProgress(`Exported ${count} rows`)
                  setTimeout(() => { setExporting(null); setExportProgress('') }, 2000)
                } catch (err) {
                  setExportProgress(`Error: ${err.message}`)
                  setTimeout(() => { setExporting(null); setExportProgress('') }, 3000)
                }
              }}
              disabled={!!exporting}
              style={{ padding: '8px 16px', background: exporting === 'compliance' ? '#D9E8F6' : '#0B4778', color: exporting === 'compliance' ? '#0B4778' : 'white', border: 'none', borderRadius: '6px', fontSize: '0.85rem', fontWeight: '600', cursor: exporting ? 'not-allowed' : 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {exporting === 'compliance' ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : '📊'}
              Bulk Export Compliance Report
            </button>
            <button
              onClick={async () => {
                setExporting('checklist')
                setExportProgress('Loading...')
                try {
                  const count = await bulkExportChecklistComparison((i, total, name) => setExportProgress(`${i}/${total}: ${name}`))
                  setExportProgress(`Exported ${count} rows`)
                  setTimeout(() => { setExporting(null); setExportProgress('') }, 2000)
                } catch (err) {
                  setExportProgress(`Error: ${err.message}`)
                  setTimeout(() => { setExporting(null); setExportProgress('') }, 3000)
                }
              }}
              disabled={!!exporting}
              style={{ padding: '8px 16px', background: exporting === 'checklist' ? '#D9E8F6' : '#0B4778', color: exporting === 'checklist' ? '#0B4778' : 'white', border: 'none', borderRadius: '6px', fontSize: '0.85rem', fontWeight: '600', cursor: exporting ? 'not-allowed' : 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {exporting === 'checklist' ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : '📋'}
              Bulk Export Checklist Comparison
            </button>
            <button
              onClick={handleDeleteAll}
              disabled={!!exporting}
              style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', fontSize: '0.85rem', fontWeight: '600', cursor: exporting ? 'not-allowed' : 'pointer', transition: 'all 0.3s', display: 'flex', alignItems: 'center', gap: '6px', opacity: exporting ? 0.5 : 1 }}
              onMouseEnter={(e) => { if (!exporting) e.currentTarget.style.background = '#b91c1c' }}
              onMouseLeave={(e) => { if (!exporting) e.currentTarget.style.background = '#dc2626' }}
            >
              🗑️ Clear All
            </button>
          </div>
        )}
      </div>
      {exporting && exportProgress && (
        <div style={{ background: '#DBEAFE', border: '2px solid #93C5FD', borderRadius: '8px', padding: '10px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: '#0B4778', fontSize: '0.85rem', fontWeight: '500' }}>
          <Loader2 style={{ width: 14, height: 14, color: '#3b82f6', flexShrink: 0 }} className="animate-spin" />
          {exportProgress}
        </div>
      )}

      {processingStatus && (processingStatus.processing > 0 || processingStatus.queued > 0) && (
        <div style={{ background: '#DBEAFE', border: '2px solid #93C5FD', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px', color: '#0B4778', fontSize: '0.9rem', fontWeight: '500' }}>
          <Loader2 style={{ width: 18, height: 18, color: '#3b82f6', flexShrink: 0 }} className="animate-spin" />
          <span>
            {processingStatus.processing > 0 && `${processingStatus.processing} application(s) processing`}
            {processingStatus.processing > 0 && processingStatus.queued > 0 && ', '}
            {processingStatus.queued > 0 && `${processingStatus.queued} queued`}
          </span>
        </div>
      )}

      <div style={{ marginBottom: '30px' }}>
        <input
          type="text"
          placeholder="Search by application name..."
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
          style={{ width: '100%', padding: '12px 20px', fontSize: '1rem', background: '#EFF6FB', border: '2px solid #D9E8F6', borderRadius: '8px', color: '#0B4778', outline: 'none', boxSizing: 'border-box' }}
          onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
          onBlur={(e) => e.target.style.borderColor = '#D9E8F6'}
        />
      </div>

      {filteredApps.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', background: '#FFFFFF', borderRadius: '12px', border: '2px dashed #D9E8F6' }}>
          <div style={{ fontSize: '4rem', marginBottom: '20px' }}>📂</div>
          <h3 style={{ color: '#0B4778', marginBottom: '10px' }}>
            {applications.length === 0 ? 'No Analyzed Applications Yet' : 'No Matching Applications'}
          </h3>
          <p style={{ color: '#0B4778', fontSize: '0.9rem' }}>
            {applications.length === 0 ? 'Upload and analyze your first application to see it here' : 'Try a different search term'}
          </p>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '20px', color: '#0B4778', fontSize: '1rem', fontWeight: '600' }}>
            Showing {startIdx + 1}-{Math.min(startIdx + itemsPerPage, filteredApps.length)} of {filteredApps.length} applications
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
            {currentApps.map((app) => (
              <div
                key={app.id}
                style={{ background: '#EFF6FB', border: '2px solid #D9E8F6', borderRadius: '12px', padding: '20px', transition: 'all 0.3s', cursor: app.status === 'completed' ? 'pointer' : 'default', position: 'relative' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.transform = 'translateY(-5px)'; e.currentTarget.style.boxShadow = '0 10px 25px rgba(59, 130, 246, 0.2)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#D9E8F6'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
                onClick={() => app.status === 'completed' && handleViewResults(app)}
              >
                <button
                  onClick={(e) => handleDelete(app.id, e)}
                  style={{ position: 'absolute', top: '10px', right: '10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.85rem', color: '#94a3b8', padding: '4px', borderRadius: '4px' }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#dc2626'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#94a3b8'}
                  title="Delete application"
                >🗑️</button>

                <div style={{ marginBottom: '15px' }}>
                  <div style={{ fontSize: '2rem', marginBottom: '10px' }}>
                    {app.status === 'processing' ? '⏳' : '📄'}
                  </div>
                  <h3 style={{ color: '#0B4778', fontSize: '1.1rem', marginBottom: '8px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={app.name}>
                    {(app.name || 'Unnamed Application').replace(/\.pdf$/i, '')}
                  </h3>

                  {app.status === 'completed' && app.complianceScore && (
                    <p style={{ color: getComplianceColor(app.complianceScore), fontSize: '1.5rem', fontWeight: '700', marginBottom: '5px' }}>
                      {app.complianceScore}% <span style={{ fontSize: '0.75rem', fontWeight: '500', color: '#0B4778' }}>Compliance</span>
                    </p>
                  )}

                  {app.status === 'error' && app.error && (
                    <p style={{ color: '#dc2626', fontSize: '0.85rem', marginBottom: '5px', background: '#FEE2E2', padding: '6px 8px', borderRadius: '6px' }}>
                      ❌ {app.error}
                    </p>
                  )}

                  <p style={{ color: '#0B4778', fontSize: '0.9rem', marginBottom: '5px', fontWeight: '500' }}>
                    📅 {formatDate(app.processedAt || app.createdAt)}
                  </p>

                  {app.checklistName && (
                    <p style={{ color: '#0B4778', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '500' }}>
                      📋 {app.checklistName}
                    </p>
                  )}

                  <p style={{ color: '#0B4778', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontWeight: '500' }}>
                    🔑 {app.id?.substring(0, 12)}...
                  </p>
                </div>

                {app.status === 'completed' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewResults(app) }}
                    style={{ width: '100%', padding: '10px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '6px', fontSize: '0.9rem', fontWeight: '600', cursor: 'pointer', transition: 'all 0.3s' }}
                    onMouseEnter={(e) => e.target.style.background = '#2563eb'}
                    onMouseLeave={(e) => e.target.style.background = '#3b82f6'}
                  >View Results</button>
                )}
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', marginTop: '30px', flexWrap: 'wrap' }}>
              <button
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                disabled={currentPage === 1}
                style={{ padding: '10px 20px', background: currentPage === 1 ? '#D9E8F6' : '#3b82f6', color: currentPage === 1 ? '#3b82f6' : 'white', border: 'none', borderRadius: '6px', fontSize: '0.9rem', fontWeight: '600', cursor: currentPage === 1 ? 'not-allowed' : 'pointer', transition: 'all 0.3s' }}
              >← Previous</button>

              <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => {
                  const show = page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1
                  if (!show) {
                    if (page === currentPage - 2 || page === currentPage + 2) return <span key={page} style={{ color: '#3b82f6', padding: '0 5px' }}>...</span>
                    return null
                  }
                  return (
                    <button key={page} onClick={() => setCurrentPage(page)}
                      style={{ padding: '10px 15px', background: currentPage === page ? '#3b82f6' : 'white', color: currentPage === page ? 'white' : '#3b82f6', border: currentPage === page ? 'none' : '2px solid #3b82f6', borderRadius: '6px', fontSize: '0.9rem', fontWeight: currentPage === page ? '600' : '400', cursor: 'pointer', transition: 'all 0.3s', minWidth: '40px' }}
                    >{page}</button>
                  )
                })}
              </div>

              <button
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                disabled={currentPage === totalPages}
                style={{ padding: '10px 20px', background: currentPage === totalPages ? '#D9E8F6' : '#3b82f6', color: currentPage === totalPages ? '#3b82f6' : 'white', border: 'none', borderRadius: '6px', fontSize: '0.9rem', fontWeight: '600', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer', transition: 'all 0.3s' }}
              >Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
