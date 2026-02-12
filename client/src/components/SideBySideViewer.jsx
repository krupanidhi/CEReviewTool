import { useState, useRef, useEffect, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Search,
  FileText,
  GripVertical
} from 'lucide-react'

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

export default function SideBySideViewer({ comparisonData, onBack }) {
  const [numPages, setNumPages] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.0)
  const [splitPosition, setSplitPosition] = useState(50) // percentage
  const [isResizing, setIsResizing] = useState(false)
  const [expandedFindings, setExpandedFindings] = useState({})
  const [highlightedPage, setHighlightedPage] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [pdfError, setPdfError] = useState(null)
  const containerRef = useRef(null)
  const pdfContainerRef = useRef(null)

  // Extract data from comparisonData
  const { results, applications } = comparisonData || {}
  const primaryResult = results?.[0]
  const comparison = primaryResult?.comparison
  const sections = comparison?.sections || []
  const applicationDoc = primaryResult?.applicationDoc || applications?.[0]
  const applicationId = applicationDoc?.id

  // PDF URL
  const pdfUrl = applicationId ? `/api/documents/${applicationId}/file` : null

  // Group findings by page for quick lookup
  const findingsByPage = useCallback(() => {
    const map = {}
    sections.forEach((section, idx) => {
      const pages = section.pageReferences || []
      // Try to extract page numbers from evidence text
      const evidencePageMatch = section.evidence?.match(/page\s*(\d+)/gi)
      const allPages = [...pages]
      if (evidencePageMatch) {
        evidencePageMatch.forEach(m => {
          const num = parseInt(m.replace(/page\s*/i, ''))
          if (num && !allPages.includes(num)) allPages.push(num)
        })
      }
      allPages.forEach(p => {
        if (!map[p]) map[p] = []
        map[p].push({ ...section, _index: idx })
      })
    })
    return map
  }, [sections])

  // Filter sections based on search
  const filteredSections = searchQuery
    ? sections.filter(s =>
        (s.checklistSection || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.evidence || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.requirement || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : sections

  // Status helpers
  const getStatusIcon = (status) => {
    const s = (status || '').toLowerCase()
    if (s === 'met' || s === 'compliant') return <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
    if (s === 'not met' || s === 'non-compliant') return <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
    return <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
  }

  const getStatusColor = (status) => {
    const s = (status || '').toLowerCase()
    if (s === 'met' || s === 'compliant') return 'border-green-500/30 bg-green-500/5'
    if (s === 'not met' || s === 'non-compliant') return 'border-red-500/30 bg-red-500/5'
    return 'border-yellow-500/30 bg-yellow-500/5'
  }

  // Navigate PDF to a specific page when a finding is clicked
  const navigateToPage = (pageNum) => {
    if (pageNum && pageNum >= 1 && pageNum <= (numPages || 999)) {
      setCurrentPage(pageNum)
      setHighlightedPage(pageNum)
      setTimeout(() => setHighlightedPage(null), 2000)
    }
  }

  // Extract page reference from a section
  const getPageRef = (section) => {
    if (section.pageReferences && section.pageReferences.length > 0) return section.pageReferences[0]
    const match = section.evidence?.match(/page\s*(\d+)/i)
    if (match) return parseInt(match[1])
    return null
  }

  // Resizer logic
  const handleMouseDown = (e) => {
    setIsResizing(true)
    e.preventDefault()
  }

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newPos = ((e.clientX - rect.left) / rect.width) * 100
      setSplitPosition(Math.max(25, Math.min(75, newPos)))
    }
    const handleMouseUp = () => setIsResizing(false)

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

  const onDocumentLoadSuccess = ({ numPages }) => {
    setNumPages(numPages)
    setPdfError(null)
  }

  const onDocumentLoadError = (error) => {
    console.error('PDF load error:', error)
    setPdfError('Failed to load PDF. The document may not be available.')
  }

  // Compliance summary
  const metCount = sections.filter(s => (s.status || '').toLowerCase() === 'met' || (s.status || '').toLowerCase() === 'compliant').length
  const notMetCount = sections.filter(s => (s.status || '').toLowerCase() === 'not met' || (s.status || '').toLowerCase() === 'non-compliant').length
  const partialCount = sections.length - metCount - notMetCount
  const compliancePercent = sections.length > 0 ? Math.round((metCount / sections.length) * 100) : 0

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] bg-slate-900">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center space-x-4">
          <button
            onClick={onBack}
            className="flex items-center space-x-1 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm">Back to Report</span>
          </button>
          <div className="h-5 w-px bg-slate-600" />
          <div className="flex items-center space-x-2">
            <FileText className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-white font-medium">
              {applicationDoc?.originalName || applicationDoc?.name || 'Document'}
            </span>
          </div>
        </div>

        {/* Compliance Summary Badge */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 text-xs">
            <span className="flex items-center space-x-1 text-green-400">
              <CheckCircle className="w-3 h-3" />
              <span>{metCount}</span>
            </span>
            <span className="flex items-center space-x-1 text-yellow-400">
              <AlertTriangle className="w-3 h-3" />
              <span>{partialCount}</span>
            </span>
            <span className="flex items-center space-x-1 text-red-400">
              <XCircle className="w-3 h-3" />
              <span>{notMetCount}</span>
            </span>
          </div>
          <div className={`px-3 py-1 rounded-full text-xs font-bold ${
            compliancePercent >= 80 ? 'bg-green-500/20 text-green-400' :
            compliancePercent >= 50 ? 'bg-yellow-500/20 text-yellow-400' :
            'bg-red-500/20 text-red-400'
          }`}>
            {compliancePercent}% Compliant
          </div>
        </div>
      </div>

      {/* Split Pane Container */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden relative">
        {/* LEFT PANE: PDF Viewer */}
        <div
          className="flex flex-col overflow-hidden bg-slate-950"
          style={{ width: `${splitPosition}%` }}
        >
          {/* PDF Controls */}
          <div className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700">
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="flex items-center space-x-1">
                <input
                  type="number"
                  value={currentPage}
                  onChange={(e) => {
                    const val = parseInt(e.target.value)
                    if (val >= 1 && val <= (numPages || 1)) setCurrentPage(val)
                  }}
                  className="w-12 bg-slate-700 text-white text-center text-sm rounded px-1 py-0.5 border border-slate-600"
                  min={1}
                  max={numPages || 1}
                />
                <span className="text-xs text-gray-400">/ {numPages || '...'}</span>
              </div>
              <button
                onClick={() => setCurrentPage(p => Math.min(numPages || 1, p + 1))}
                disabled={currentPage >= (numPages || 1)}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={() => setScale(s => Math.max(0.5, s - 0.1))}
                className="p-1 rounded hover:bg-slate-700 transition-colors"
                title="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs text-gray-400 w-12 text-center">{Math.round(scale * 100)}%</span>
              <button
                onClick={() => setScale(s => Math.min(2.5, s + 0.1))}
                className="p-1 rounded hover:bg-slate-700 transition-colors"
                title="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => setScale(1.0)}
                className="p-1 rounded hover:bg-slate-700 transition-colors text-xs text-gray-400 ml-1"
                title="Reset zoom"
              >
                Fit
              </button>
            </div>
          </div>

          {/* PDF Content */}
          <div
            ref={pdfContainerRef}
            className={`flex-1 overflow-auto flex justify-center p-4 ${
              highlightedPage === currentPage ? 'ring-2 ring-blue-500 ring-inset' : ''
            }`}
          >
            {pdfUrl ? (
              <Document
                file={pdfUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                loading={
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-3"></div>
                      <p className="text-sm text-gray-400">Loading PDF...</p>
                    </div>
                  </div>
                }
              >
                <Page
                  pageNumber={currentPage}
                  scale={scale}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  loading={
                    <div className="flex items-center justify-center h-96">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                    </div>
                  }
                />
              </Document>
            ) : pdfError ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-3" />
                  <p className="text-sm text-gray-400">{pdfError}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <FileText className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                  <p className="text-sm text-gray-400">No PDF available</p>
                  <p className="text-xs text-gray-500 mt-1">Upload a document to view it here</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Resizer Handle */}
        <div
          className={`w-2 flex-shrink-0 cursor-col-resize flex items-center justify-center group transition-colors ${
            isResizing ? 'bg-blue-500' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          onMouseDown={handleMouseDown}
        >
          <GripVertical className={`w-3 h-3 ${isResizing ? 'text-white' : 'text-gray-500 group-hover:text-gray-300'}`} />
        </div>

        {/* RIGHT PANE: Compliance Findings */}
        <div
          className="flex flex-col overflow-hidden bg-slate-900"
          style={{ width: `${100 - splitPosition}%` }}
        >
          {/* Findings Header */}
          <div className="px-3 py-2 bg-slate-800 border-b border-slate-700">
            <div className="flex items-center space-x-2">
              <Search className="w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search findings..."
                className="flex-1 bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-500">{filteredSections.length} findings</span>
            </div>
          </div>

          {/* Findings List */}
          <div className="flex-1 overflow-auto">
            {filteredSections.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-gray-500">No findings match your search</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/50">
                {filteredSections.map((section, idx) => {
                  const isExpanded = expandedFindings[idx]
                  const pageRef = getPageRef(section)
                  const status = section.status || 'Unknown'

                  return (
                    <div
                      key={idx}
                      className={`border-l-2 transition-colors ${getStatusColor(status)} ${
                        pageRef === currentPage ? 'ring-1 ring-blue-500/50' : ''
                      }`}
                    >
                      {/* Finding Header */}
                      <div
                        className="flex items-start space-x-2 px-3 py-2.5 cursor-pointer hover:bg-slate-800/50 transition-colors"
                        onClick={() => setExpandedFindings(prev => ({ ...prev, [idx]: !prev[idx] }))}
                      >
                        {getStatusIcon(status)}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-white truncate pr-2">
                              {section.checklistSection || `Finding ${idx + 1}`}
                            </p>
                            <div className="flex items-center space-x-2 flex-shrink-0">
                              {pageRef && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    navigateToPage(pageRef)
                                  }}
                                  className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded hover:bg-blue-500/30 transition-colors"
                                  title={`Go to page ${pageRef}`}
                                >
                                  p.{pageRef}
                                </button>
                              )}
                              {isExpanded ? (
                                <ChevronUp className="w-3 h-3 text-gray-500" />
                              ) : (
                                <ChevronDown className="w-3 h-3 text-gray-500" />
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {status}
                            {section.requirement && ` — ${section.requirement.substring(0, 80)}${section.requirement.length > 80 ? '...' : ''}`}
                          </p>
                        </div>
                      </div>

                      {/* Expanded Detail */}
                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-2">
                          {section.requirement && (
                            <div className="bg-slate-800/50 rounded p-2">
                              <p className="text-xs font-medium text-gray-400 mb-1">Requirement</p>
                              <p className="text-xs text-gray-300">{section.requirement}</p>
                            </div>
                          )}
                          {section.evidence && (
                            <div className="bg-slate-800/50 rounded p-2">
                              <p className="text-xs font-medium text-gray-400 mb-1">Evidence Found</p>
                              <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans">{section.evidence}</pre>
                            </div>
                          )}
                          {section.notes && (
                            <div className="bg-slate-800/50 rounded p-2">
                              <p className="text-xs font-medium text-gray-400 mb-1">Notes</p>
                              <p className="text-xs text-gray-300">{section.notes}</p>
                            </div>
                          )}
                          {section.criticalIssues && section.criticalIssues.length > 0 && (
                            <div className="bg-red-500/10 border border-red-500/20 rounded p-2">
                              <p className="text-xs font-medium text-red-400 mb-1">Critical Issues</p>
                              <ul className="text-xs text-red-300 space-y-1">
                                {section.criticalIssues.map((issue, i) => (
                                  <li key={i}>- {typeof issue === 'string' ? issue : issue.issue || issue.description}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {section.recommendations && section.recommendations.length > 0 && (
                            <div className="bg-blue-500/10 border border-blue-500/20 rounded p-2">
                              <p className="text-xs font-medium text-blue-400 mb-1">Recommendations</p>
                              <ul className="text-xs text-blue-300 space-y-1">
                                {section.recommendations.map((rec, i) => (
                                  <li key={i}>- {typeof rec === 'string' ? rec : rec.recommendation || rec.description}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
