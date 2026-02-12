import { useState, useRef, useEffect, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  ChevronLeft,
  ChevronRight,
  X,
  ZoomIn,
  ZoomOut,
  FileText,
  Maximize2,
  Minimize2,
  ChevronsLeft,
  ChevronsRight,
  BookOpen
} from 'lucide-react'

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
  const getPageStatusDot = (pageNum) => {
    const refs = referencedPages.get(pageNum)
    if (!refs || refs.length === 0) return null
    const hasNotMet = refs.some(r => r.status === 'not_met')
    const hasPartial = refs.some(r => r.status === 'partial')
    if (hasNotMet) return 'bg-red-500'
    if (hasPartial) return 'bg-yellow-500'
    return 'bg-green-500'
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
        className="fixed inset-0 bg-black/40 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Sliding Panel */}
      <div
        className="fixed inset-y-0 right-0 z-50 flex flex-col bg-slate-900 border-l border-slate-700 shadow-2xl transition-transform duration-300 ease-out"
        style={{
          width: `${effectiveWidth}px`,
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)'
        }}
      >
        {/* Resize Handle */}
        <div
          className={`absolute left-0 top-0 bottom-0 w-1.5 hover:w-2 cursor-col-resize transition-all z-10 ${
            isResizing ? 'w-2 bg-blue-500' : 'bg-slate-600 hover:bg-blue-400'
          }`}
          onMouseDown={handleMouseDown}
        >
          <div className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 w-1 h-16 bg-slate-400 rounded-full opacity-40" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-500/10 p-1.5 rounded-lg">
              <BookOpen className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white truncate max-w-[250px]">
                {applicationDoc?.originalName || applicationDoc?.name || 'Application Document'}
              </h3>
              {numPages && (
                <p className="text-xs text-gray-400">{numPages} pages</p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setIsFullWidth(!isFullWidth)}
              className="p-1.5 hover:bg-slate-700 rounded-lg transition-colors text-gray-400 hover:text-white"
              title={isFullWidth ? 'Restore size' : 'Maximize'}
            >
              {isFullWidth ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-slate-700 rounded-lg transition-colors text-gray-400 hover:text-white"
              title="Close viewer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Navigation Bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-slate-800/50 border-b border-slate-700/50 flex-shrink-0">
          {/* Page Navigation */}
          <div className="flex items-center space-x-2">
            <button
              onClick={() => goToPage(1)}
              disabled={currentPage <= 1}
              className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 transition-colors text-gray-300"
              title="First page"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-30 transition-colors text-gray-300"
              title="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <div className="flex items-center space-x-1.5 bg-slate-700/50 rounded-lg px-2 py-1">
              <span className="text-xs text-gray-400">Page</span>
              <input
                type="text"
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value)}
                onKeyDown={handlePageInputSubmit}
                onBlur={handlePageInputBlur}
                className="w-10 bg-slate-700 text-white text-center text-sm rounded px-1 py-0.5 border border-slate-600 focus:border-blue-500 focus:outline-none"
              />
              <span className="text-xs text-gray-400">of {numPages || '...'}</span>
            </div>

            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= (numPages || 1)}
              className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-30 transition-colors text-gray-300"
              title="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => goToPage(numPages || 1)}
              disabled={currentPage >= (numPages || 1)}
              className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 transition-colors text-gray-300"
              title="Last page"
            >
              <ChevronsRight className="w-4 h-4" />
            </button>
          </div>

          {/* Zoom + Page Grid Toggle */}
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setScale(s => Math.max(0.5, +(s - 0.15).toFixed(2)))}
              className="p-1 rounded hover:bg-slate-700 transition-colors text-gray-300"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs text-gray-400 w-10 text-center">{Math.round(scale * 100)}%</span>
            <button
              onClick={() => setScale(s => Math.min(3, +(s + 0.15).toFixed(2)))}
              className="p-1 rounded hover:bg-slate-700 transition-colors text-gray-300"
              title="Zoom in"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-slate-600 mx-1" />
            <button
              onClick={() => setShowPageGrid(!showPageGrid)}
              className={`p-1.5 rounded transition-colors ${
                showPageGrid ? 'bg-blue-600 text-white' : 'hover:bg-slate-700 text-gray-300'
              }`}
              title="Page navigator"
            >
              <FileText className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Referenced Pages Quick-Jump Bar */}
        {referencedPages.size > 0 && (
          <div className="flex items-center px-4 py-1.5 bg-slate-800/30 border-b border-slate-700/30 flex-shrink-0 overflow-x-auto gap-1">
            <span className="text-xs text-gray-500 mr-1 flex-shrink-0">{sectionLabel ? `${sectionLabel}:` : 'Referenced:'}</span>
            {[...referencedPages.keys()].sort((a, b) => a - b).map(pageNum => {
              const statusDot = getPageStatusDot(pageNum)
              const isActive = currentPage === pageNum
              return (
                <button
                  key={pageNum}
                  onClick={() => goToPage(pageNum)}
                  className={`relative flex items-center px-2 py-0.5 rounded text-xs font-medium transition-all flex-shrink-0 ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                      : 'bg-slate-700/50 text-gray-300 hover:bg-slate-600 hover:text-white'
                  }`}
                  title={referencedPages.get(pageNum).map(r => `${r.section} (${r.status})`).join('\n')}
                >
                  {statusDot && (
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot} mr-1`} />
                  )}
                  p.{pageNum}
                </button>
              )
            })}
          </div>
        )}

        {/* Page Grid Overlay */}
        {showPageGrid && numPages && (
          <div className="absolute top-[120px] left-4 right-4 bottom-4 z-20 bg-slate-900/95 backdrop-blur-sm rounded-xl border border-slate-700 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h4 className="text-sm font-semibold text-white">Go to Page</h4>
              <button
                onClick={() => setShowPageGrid(false)}
                className="p-1 hover:bg-slate-700 rounded transition-colors text-gray-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <div className="grid grid-cols-8 gap-1.5">
                {pageGridItems().map(pageNum => {
                  const statusDot = getPageStatusDot(pageNum)
                  const isActive = currentPage === pageNum
                  const isReferenced = referencedPages.has(pageNum)
                  return (
                    <button
                      key={pageNum}
                      onClick={() => goToPage(pageNum)}
                      className={`relative p-2 rounded-lg text-xs font-medium transition-all ${
                        isActive
                          ? 'bg-blue-600 text-white ring-2 ring-blue-400'
                          : isReferenced
                          ? 'bg-slate-700 text-white hover:bg-slate-600 ring-1 ring-slate-500'
                          : 'bg-slate-800 text-gray-400 hover:bg-slate-700 hover:text-gray-200'
                      }`}
                    >
                      {pageNum}
                      {statusDot && (
                        <span className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full ${statusDot}`} />
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
          className="flex-1 overflow-auto flex justify-center bg-slate-950 p-4"
        >
          {pdfUrl ? (
            <Document
              file={pdfUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={
                <div className="flex items-center justify-center h-64">
                  <div className="text-center">
                    <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-sm text-gray-400">Loading document...</p>
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
                  <div className="flex items-center justify-center h-64 w-[400px]">
                    <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                }
              />
            </Document>
          ) : pdfError ? (
            <div className="flex items-center justify-center h-64 text-center">
              <div>
                <FileText className="w-16 h-16 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">{pdfError}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-64 text-center">
              <div>
                <FileText className="w-16 h-16 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 text-sm">No PDF document available</p>
                <p className="text-gray-500 text-xs mt-1">Upload an application to view it here</p>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Page Scrubber */}
        {numPages && (
          <div className="flex items-center px-4 py-2 bg-slate-800 border-t border-slate-700 flex-shrink-0">
            <span className="text-xs text-gray-500 mr-3 flex-shrink-0">Page {currentPage}</span>
            <input
              type="range"
              min={1}
              max={numPages}
              value={currentPage}
              onChange={(e) => setCurrentPage(parseInt(e.target.value))}
              className="flex-1 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
              style={{
                background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${((currentPage - 1) / (numPages - 1)) * 100}%, #334155 ${((currentPage - 1) / (numPages - 1)) * 100}%, #334155 100%)`
              }}
            />
            <span className="text-xs text-gray-500 ml-3 flex-shrink-0">{numPages}</span>
          </div>
        )}
      </div>
    </>
  )
}
