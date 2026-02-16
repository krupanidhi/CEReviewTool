import { useState, useRef, useEffect, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

export default function ApplicationPageViewer({ comparisonData, isOpen, onClose, sectionContext }) {
  const [numPages, setNumPages] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.0)
  const [panelWidth, setPanelWidth] = useState(520)
  const [isResizing, setIsResizing] = useState(false)
  const [pdfError, setPdfError] = useState(null)
  const [pageInputValue, setPageInputValue] = useState('1')
  const [isFullWidth, setIsFullWidth] = useState(false)
  const [showPageGrid, setShowPageGrid] = useState(false)
  const pageContainerRef = useRef(null)

  // Extract application doc info
  const { results, applications } = comparisonData || {}
  const primaryResult = results?.[0]
  const applicationDoc = primaryResult?.applicationDoc || applications?.[0]
  const applicationId = applicationDoc?.id
  const pdfUrl = applicationId ? `/api/documents/${applicationId}/file` : null

  // Use section-specific page references when opened from a section click,
  // otherwise show no referenced pages (avoids overwhelming list of ALL pages)
  const referencedPages = useCallback(() => {
    if (!sectionContext?.sectionPages || sectionContext.sectionPages.length === 0) {
      return new Map()
    }
    const refs = new Map()
    sectionContext.sectionPages.forEach(p => {
      const pageNum = typeof p === 'number' ? p : parseInt(String(p).replace(/[^0-9]/g, ''))
      if (pageNum && !isNaN(pageNum)) {
        refs.set(pageNum, [{ section: sectionContext.sectionName || '', status: 'met' }])
      }
    })
    return refs
  }, [sectionContext])()

  const sectionLabel = sectionContext?.sectionName || null
  const pageOffset = sectionContext?.pageOffset || 0

  // Listen for external page navigation requests (from report page reference clicks)
  useEffect(() => {
    if (isOpen && window.__pageViewerGoTo) {
      const targetPage = parseInt(window.__pageViewerGoTo)
      if (targetPage >= 1) {
        setCurrentPage(targetPage)
      }
      window.__pageViewerGoTo = null
    }
  }, [isOpen])

  // Listen for navigate-to-page custom events (from checklist comparison page links)
  useEffect(() => {
    const handler = (e) => {
      const page = e.detail?.page
      if (page && page >= 1 && (!numPages || page <= numPages)) {
        setCurrentPage(page)
        // Scroll page into view
        if (pageContainerRef.current) {
          pageContainerRef.current.scrollTop = 0
        }
      }
    }
    window.addEventListener('navigate-to-page', handler)
    return () => window.removeEventListener('navigate-to-page', handler)
  }, [numPages])

  // Sync input with current page
  useEffect(() => {
    setPageInputValue(String(currentPage))
  }, [currentPage])

  // Handle page input submit
  const handlePageInputSubmit = (e) => {
    if (e.key === 'Enter') {
      const val = parseInt(pageInputValue)
      if (val >= 1 && val <= (numPages || 1)) {
        setCurrentPage(val)
      } else {
        setPageInputValue(String(currentPage))
      }
    }
  }

  const handlePageInputBlur = () => {
    const val = parseInt(pageInputValue)
    if (val >= 1 && val <= (numPages || 1)) {
      setCurrentPage(val)
    } else {
      setPageInputValue(String(currentPage))
    }
  }

  // Navigate to specific page
  const goToPage = (page) => {
    if (page >= 1 && page <= (numPages || 999)) {
      setCurrentPage(page)
      setShowPageGrid(false)
    }
  }

  // Resize handle
  const handleMouseDown = (e) => {
    setIsResizing(true)
    e.preventDefault()
  }

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing) return
      const newWidth = window.innerWidth - e.clientX
      const minWidth = 380
      const maxWidth = window.innerWidth * 0.85
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setPanelWidth(newWidth)
      }
    }
    const handleMouseUp = () => {
      setIsResizing(false)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  const onDocumentLoadSuccess = ({ numPages: n }) => {
    setNumPages(n)
    setPdfError(null)
  }

  const onDocumentLoadError = (error) => {
    console.error('PDF load error:', error)
    setPdfError('Failed to load PDF document.')
  }

  // Get status dot color for page references
  const getPageStatusColor = (pageNum) => {
    const refs = referencedPages.get(pageNum)
    if (!refs || refs.length === 0) return null
    const hasNotMet = refs.some(r => r.status === 'not_met')
    const hasPartial = refs.some(r => r.status === 'partial')
    if (hasNotMet) return '#dc2626'
    if (hasPartial) return '#ca8a04'
    return '#16a34a'
  }

  // Generate page grid items
  const pageGridItems = useCallback(() => {
    if (!numPages) return []
    const items = []
    for (let i = 1; i <= numPages; i++) {
      items.push(i)
    }
    return items
  }, [numPages])

  if (!isOpen) return null

  const effectiveWidth = isFullWidth ? window.innerWidth * 0.85 : panelWidth

  return (
    <>
      {/* Backdrop overlay */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }}
        onClick={onClose}
      />

      {/* Sliding Panel */}
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 50,
          display: 'flex', flexDirection: 'column',
          background: '#FFFFFF', borderLeft: '2px solid #D9E8F6',
          boxShadow: '-4px 0 20px rgba(0,0,0,0.15)',
          width: `${effectiveWidth}px`,
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s ease-out'
        }}
      >
        {/* Resize Handle */}
        <div
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: isResizing ? '4px' : '3px',
            background: isResizing ? '#3b82f6' : '#D9E8F6',
            cursor: 'col-resize', transition: 'all 0.2s', zIndex: 10
          }}
          onMouseDown={handleMouseDown}
          onMouseEnter={(e) => { e.currentTarget.style.width = '4px'; e.currentTarget.style.background = '#3b82f6' }}
          onMouseLeave={(e) => { if (!isResizing) { e.currentTarget.style.width = '3px'; e.currentTarget.style.background = '#D9E8F6' } }}
        />

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#0B4778', borderBottom: '2px solid #D9E8F6', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.3rem' }}>📖</span>
            <div>
              <h3 style={{ fontSize: '0.9rem', fontWeight: '600', color: '#FFFFFF', margin: 0, maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {applicationDoc?.originalName || applicationDoc?.name || 'Application Document'}
              </h3>
              {numPages && (
                <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)', margin: 0 }}>{numPages} pages</p>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button
              onClick={() => setIsFullWidth(!isFullWidth)}
              style={{ background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', color: '#FFFFFF', fontSize: '0.85rem' }}
              title={isFullWidth ? 'Restore size' : 'Maximize'}
            >{isFullWidth ? '🗗' : '🗖'}</button>
            <button
              onClick={onClose}
              style={{ background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', padding: '6px 10px', borderRadius: '6px', color: '#FFFFFF', fontSize: '1rem' }}
              title="Close viewer"
            >✕</button>
          </div>
        </div>

        {/* Navigation Bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', background: '#EFF6FB', borderBottom: '1px solid #D9E8F6', flexShrink: 0 }}>
          {/* Page Navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button onClick={() => goToPage(1)} disabled={currentPage <= 1} style={{ background: 'none', border: 'none', cursor: currentPage <= 1 ? 'not-allowed' : 'pointer', padding: '4px', borderRadius: '4px', color: '#0B4778', fontSize: '0.85rem', opacity: currentPage <= 1 ? 0.3 : 1 }} title="First page">⏮</button>
            <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} style={{ background: 'none', border: 'none', cursor: currentPage <= 1 ? 'not-allowed' : 'pointer', padding: '4px 6px', borderRadius: '4px', color: '#0B4778', fontSize: '0.85rem', opacity: currentPage <= 1 ? 0.3 : 1 }} title="Previous page">◀</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#FFFFFF', borderRadius: '6px', padding: '4px 8px', border: '1px solid #D9E8F6' }}>
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>Page</span>
              <input type="text" value={pageInputValue} onChange={(e) => setPageInputValue(e.target.value)} onKeyDown={handlePageInputSubmit} onBlur={handlePageInputBlur} style={{ width: '36px', background: '#EFF6FB', color: '#0B4778', textAlign: 'center', fontSize: '0.85rem', borderRadius: '4px', padding: '2px', border: '1px solid #D9E8F6', outline: 'none' }} />
              <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>of {numPages || '...'}</span>
            </div>
            <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= (numPages || 1)} style={{ background: 'none', border: 'none', cursor: currentPage >= (numPages || 1) ? 'not-allowed' : 'pointer', padding: '4px 6px', borderRadius: '4px', color: '#0B4778', fontSize: '0.85rem', opacity: currentPage >= (numPages || 1) ? 0.3 : 1 }} title="Next page">▶</button>
            <button onClick={() => goToPage(numPages || 1)} disabled={currentPage >= (numPages || 1)} style={{ background: 'none', border: 'none', cursor: currentPage >= (numPages || 1) ? 'not-allowed' : 'pointer', padding: '4px', borderRadius: '4px', color: '#0B4778', fontSize: '0.85rem', opacity: currentPage >= (numPages || 1) ? 0.3 : 1 }} title="Last page">⏭</button>
          </div>
          {/* Zoom + Page Grid Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button onClick={() => setScale(s => Math.max(0.5, +(s - 0.15).toFixed(2)))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#0B4778', fontSize: '0.85rem' }} title="Zoom out">🔍−</button>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8', width: '36px', textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale(s => Math.min(3, +(s + 0.15).toFixed(2)))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#0B4778', fontSize: '0.85rem' }} title="Zoom in">🔍+</button>
            <div style={{ width: '1px', height: '16px', background: '#D9E8F6', margin: '0 4px' }} />
            <button onClick={() => setShowPageGrid(!showPageGrid)} style={{ background: showPageGrid ? '#3b82f6' : 'none', color: showPageGrid ? '#FFFFFF' : '#0B4778', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem' }} title="Page navigator">📄</button>
          </div>
        </div>

        {/* Referenced Pages Quick-Jump Bar */}
        {referencedPages.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', background: '#EFF6FB', borderBottom: '1px solid #D9E8F6', flexShrink: 0, overflowX: 'auto', gap: '4px' }}>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginRight: '4px', flexShrink: 0 }}>{sectionLabel ? `${sectionLabel}:` : 'Referenced:'}</span>
            {[...referencedPages.keys()].sort((a, b) => a - b).map(pageNum => {
              const statusColor = getPageStatusColor(pageNum)
              const isActive = currentPage === pageNum
              return (
                <button
                  key={pageNum}
                  onClick={() => goToPage(pageNum)}
                  style={{ display: 'flex', alignItems: 'center', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: '600', border: 'none', cursor: 'pointer', flexShrink: 0, transition: 'all 0.2s', background: isActive ? '#3b82f6' : '#FFFFFF', color: isActive ? '#FFFFFF' : '#0B4778', boxShadow: isActive ? '0 2px 8px rgba(59,130,246,0.3)' : 'none' }}
                  title={referencedPages.get(pageNum).map(r => `${r.section} (${r.status})`).join('\n')}
                >
                  {statusColor && (
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor, marginRight: '4px' }} />
                  )}
                  p.{pageOffset ? pageNum - pageOffset : pageNum}
                </button>
              )
            })}
          </div>
        )}

        {/* Page Grid Overlay */}
        {showPageGrid && numPages && (
          <div style={{ position: 'absolute', top: '120px', left: '16px', right: '16px', bottom: '16px', zIndex: 20, background: 'rgba(255,255,255,0.97)', backdropFilter: 'blur(4px)', borderRadius: '12px', border: '2px solid #D9E8F6', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #D9E8F6' }}>
              <h4 style={{ fontSize: '0.9rem', fontWeight: '600', color: '#0B4778', margin: 0 }}>Go to Page</h4>
              <button onClick={() => setShowPageGrid(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#94a3b8', fontSize: '1rem' }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '6px' }}>
                {pageGridItems().map(pageNum => {
                  const statusColor = getPageStatusColor(pageNum)
                  const isActive = currentPage === pageNum
                  const isReferenced = referencedPages.has(pageNum)
                  return (
                    <button key={pageNum} onClick={() => goToPage(pageNum)} style={{ position: 'relative', padding: '8px', borderRadius: '8px', fontSize: '0.75rem', fontWeight: '600', border: isActive ? '2px solid #3b82f6' : isReferenced ? '2px solid #93C5FD' : '1px solid #D9E8F6', cursor: 'pointer', transition: 'all 0.2s', background: isActive ? '#3b82f6' : isReferenced ? '#EFF6FF' : '#FFFFFF', color: isActive ? '#FFFFFF' : '#0B4778' }}>
                      {pageNum}
                      {statusColor && (
                        <span style={{ position: 'absolute', top: '2px', right: '2px', width: '8px', height: '8px', borderRadius: '50%', background: statusColor }} />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* PDF Content Area */}
        <div
          ref={pageContainerRef}
          style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', background: '#EFF6FB', padding: '16px' }}
        >
          {pdfUrl ? (
            <Document
              file={pdfUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ width: '40px', height: '40px', border: '3px solid #D9E8F6', borderTop: '3px solid #3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
                    <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Loading document...</p>
                  </div>
                </div>
              }
            >
              <Page
                pageNumber={currentPage}
                scale={scale}
                renderTextLayer={true}
                renderAnnotationLayer={false}
                className="shadow-2xl rounded-lg overflow-hidden"
                loading={
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px', width: '400px' }}>
                    <div style={{ width: '32px', height: '32px', border: '3px solid #D9E8F6', borderTop: '3px solid #3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                  </div>
                }
              />
            </Document>
          ) : pdfError ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px', textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: '4rem', marginBottom: '12px' }}>📄</div>
                <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>{pdfError}</p>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '256px', textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: '4rem', marginBottom: '12px' }}>📄</div>
                <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No PDF document available</p>
                <p style={{ color: '#94a3b8', fontSize: '0.75rem', marginTop: '4px' }}>Upload an application to view it here</p>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Page Scrubber */}
        {numPages && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', background: '#EFF6FB', borderTop: '1px solid #D9E8F6', flexShrink: 0 }}>
            <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginRight: '12px', flexShrink: 0 }}>Page {currentPage}</span>
            <input
              type="range"
              min={1}
              max={numPages}
              value={currentPage}
              onChange={(e) => setCurrentPage(parseInt(e.target.value))}
              style={{
                flex: 1, height: '6px', borderRadius: '4px', cursor: 'pointer', accentColor: '#3b82f6',
                background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${((currentPage - 1) / Math.max(numPages - 1, 1)) * 100}%, #D9E8F6 ${((currentPage - 1) / Math.max(numPages - 1, 1)) * 100}%, #D9E8F6 100%)`
              }}
            />
            <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginLeft: '12px', flexShrink: 0 }}>{numPages}</span>
          </div>
        )}
      </div>
    </>
  )
}
