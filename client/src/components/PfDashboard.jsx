import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { listPfResults, getPfResults } from '../services/api'

export default function PfDashboard({ onViewResults }) {
  const [results, setResults] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage] = useState(12)
  const [loadingApp, setLoadingApp] = useState(null)

  useEffect(() => {
    loadResults()
  }, [])

  const loadResults = async () => {
    try {
      const data = await listPfResults()
      setResults(data.results || [])
    } catch (error) {
      console.error('Failed to load PF results:', error)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const handleViewResults = async (item) => {
    if (!item.applicationNumber) return
    setLoadingApp(item.applicationNumber)
    try {
      const result = await getPfResults(item.applicationNumber)
      if (result?.success && onViewResults) {
        onViewResults(result)
      }
    } catch (error) {
      console.error('Failed to load PF result:', error)
    } finally {
      setLoadingApp(null)
    }
  }

  const getComplianceColor = (rate) => {
    const num = parseFloat(rate)
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

  const extractDisplayName = (item) => {
    // Extract readable name from filename: "HRSA-26-006_SOME_NAME_Application-242744" → "SOME NAME"
    let name = item.applicationName || item.filename || ''
    name = name.replace(/\.pdf$/i, '').replace(/\.json$/i, '')
    // Remove HRSA prefix
    name = name.replace(/^HRSA[-_]\d{2}[-_]\d{3}[-_]?/i, '')
    // Remove Application-NNNNNN suffix
    name = name.replace(/[-_]?Application[-_]\d+$/i, '')
    // Replace underscores with spaces
    name = name.replace(/_/g, ' ').trim()
    return name || `Application ${item.applicationNumber}`
  }

  const extractNofo = (item) => {
    const match = (item.relPath || item.filename || '').match(/HRSA[-_](\d{2})[-_](\d{3})/i)
    return match ? `HRSA-${match[1]}-${match[2]}` : ''
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px' }}>
        <Loader2 style={{ width: 32, height: 32, color: '#3b82f6' }} className="animate-spin" />
      </div>
    )
  }

  // Filter by search query
  const filtered = results.filter(r => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      (r.applicationNumber || '').includes(q) ||
      (r.applicationName || '').toLowerCase().includes(q) ||
      (r.filename || '').toLowerCase().includes(q) ||
      (r.relPath || '').toLowerCase().includes(q)
    )
  })

  // Pagination
  const totalPages = Math.ceil(filtered.length / itemsPerPage)
  const startIdx = (currentPage - 1) * itemsPerPage
  const pageItems = filtered.slice(startIdx, startIdx + itemsPerPage)

  return (
    <div style={{ padding: '20px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, color: '#0B4778', fontSize: '1.3rem' }}>
            📋 Pre-Funding Review Results
          </h2>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '0.9rem' }}>
            {results.length} cached result{results.length !== 1 ? 's' : ''} — click to view details
          </p>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: '16px' }}>
        <input
          type="text"
          placeholder="Search by name, application number, or NOFO..."
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1) }}
          style={{
            width: '100%', padding: '10px 16px', fontSize: '0.95rem',
            border: '2px solid #D9E8F6', borderRadius: '8px',
            background: 'white', color: '#0B4778', boxSizing: 'border-box'
          }}
        />
      </div>

      {/* Results Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#64748b' }}>
          <div style={{ fontSize: '3rem', marginBottom: '12px', opacity: 0.4 }}>📋</div>
          <p style={{ fontSize: '1.1rem', fontWeight: '600' }}>
            {searchQuery ? 'No matching results found' : 'No pre-funding review results yet'}
          </p>
          <p style={{ fontSize: '0.9rem' }}>
            {searchQuery ? 'Try a different search term' : 'Run a batch process or analyze an application to generate results'}
          </p>
        </div>
      ) : (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '12px', marginBottom: '16px'
          }}>
            {pageItems.map((item, idx) => {
              const displayName = extractDisplayName(item)
              const nofo = extractNofo(item)
              const isLoading = loadingApp === item.applicationNumber

              return (
                <div
                  key={`${item.applicationNumber}-${idx}`}
                  onClick={() => !isLoading && handleViewResults(item)}
                  style={{
                    background: 'white', borderRadius: '10px', padding: '16px',
                    border: '2px solid #D9E8F6', cursor: isLoading ? 'wait' : 'pointer',
                    transition: 'all 0.2s', position: 'relative',
                    opacity: isLoading ? 0.7 : 1
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(59,130,246,0.15)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#D9E8F6'; e.currentTarget.style.boxShadow = 'none' }}
                >
                  {isLoading && (
                    <div style={{ position: 'absolute', top: '10px', right: '10px' }}>
                      <Loader2 style={{ width: 18, height: 18, color: '#3b82f6' }} className="animate-spin" />
                    </div>
                  )}

                  {/* Application Name */}
                  <div style={{ fontSize: '0.95rem', fontWeight: '600', color: '#0B4778', marginBottom: '6px', lineHeight: '1.3' }}>
                    {displayName}
                  </div>

                  {/* Application Number & NOFO */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <span style={{
                      padding: '2px 8px', background: '#EFF6FB', borderRadius: '4px',
                      fontSize: '0.8rem', color: '#0B4778', fontWeight: '600'
                    }}>
                      #{item.applicationNumber}
                    </span>
                    {nofo && (
                      <span style={{
                        padding: '2px 8px', background: '#f0fdf4', borderRadius: '4px',
                        fontSize: '0.8rem', color: '#16a34a', fontWeight: '600'
                      }}>
                        {nofo}
                      </span>
                    )}
                  </div>

                  {/* Stats Row */}
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', fontSize: '0.8rem' }}>
                    <span style={{ color: '#16a34a', fontWeight: '600' }}>✅ {item.compliant}</span>
                    <span style={{ color: '#dc2626', fontWeight: '600' }}>❌ {item.nonCompliant}</span>
                    <span style={{ color: '#64748b', fontWeight: '600' }}>⊘ {item.notApplicable}</span>
                    <span style={{ marginLeft: 'auto', fontWeight: '700', color: getComplianceColor(item.complianceRate) }}>
                      {item.complianceRate}%
                    </span>
                  </div>

                  {/* Compliance Bar */}
                  <div style={{ height: '4px', background: '#f1f5f9', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px' }}>
                    <div style={{
                      height: '100%', borderRadius: '4px',
                      width: `${item.complianceRate}%`,
                      background: getComplianceColor(item.complianceRate),
                      transition: 'width 0.5s ease'
                    }} />
                  </div>

                  {/* Timestamp */}
                  <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                    {formatDate(item.timestamp)}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', alignItems: 'center' }}>
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                style={{
                  padding: '6px 14px', border: '1px solid #D9E8F6', borderRadius: '6px',
                  background: 'white', color: '#0B4778', cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                  opacity: currentPage === 1 ? 0.5 : 1, fontWeight: '600', fontSize: '0.85rem'
                }}
              >
                ← Prev
              </button>
              <span style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '600' }}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                style={{
                  padding: '6px 14px', border: '1px solid #D9E8F6', borderRadius: '6px',
                  background: 'white', color: '#0B4778', cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                  opacity: currentPage === totalPages ? 0.5 : 1, fontWeight: '600', fontSize: '0.85rem'
                }}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
