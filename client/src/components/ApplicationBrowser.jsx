import { useState, useEffect } from 'react'
import { FolderOpen, FileText, ChevronRight, ChevronDown, Loader2, Search, RefreshCw, HardDrive } from 'lucide-react'
import { browseApplications, extractApplicationFromFolder } from '../services/api'

/**
 * ApplicationBrowser — Browse and select application PDFs from the
 * organized FY/NOFO folder structure on the server.
 *
 * Folder structure:
 *   applications/FY26/HRSA-26-002/*.pdf
 *   applications/FY25/HRSA-25-004/*.pdf
 *
 * Props:
 *   onSelect(result) — called with { originalName, data, source: 'folder' }
 *                       when user selects and extracts an application
 *   multiSelect       — allow selecting multiple applications (default false)
 */
export default function ApplicationBrowser({ onSelect, multiSelect = false }) {
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(null) // path being extracted
  const [error, setError] = useState(null)
  const [browseData, setBrowseData] = useState(null)
  const [expandedFYs, setExpandedFYs] = useState({})
  const [expandedNOFOs, setExpandedNOFOs] = useState({})
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedPaths, setSelectedPaths] = useState(new Set())

  useEffect(() => {
    loadBrowseData()
  }, [])

  const loadBrowseData = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await browseApplications()
      setBrowseData(data)
      // Auto-expand the first FY
      if (data.fiscalYears?.length > 0) {
        setExpandedFYs({ [data.fiscalYears[0].fy]: true })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const toggleFY = (fy) => {
    setExpandedFYs(prev => ({ ...prev, [fy]: !prev[fy] }))
  }

  const toggleNOFO = (key) => {
    setExpandedNOFOs(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSelectApp = async (app) => {
    if (extracting) return

    setExtracting(app.path)
    setError(null)
    try {
      const result = await extractApplicationFromFolder(app.path)
      if (result.success && result.data) {
        // Mark as selected
        setSelectedPaths(prev => new Set([...prev, app.path]))

        if (onSelect) {
          onSelect({
            originalName: result.originalName || app.name,
            name: result.originalName || app.name,
            data: result.data,
            analysis: { data: result.data },
            source: result.source || 'folder',
            folderPath: app.path
          })
        }
      }
    } catch (err) {
      setError(`Failed to extract ${app.name}: ${err.message}`)
    } finally {
      setExtracting(null)
    }
  }

  const formatSize = (bytes) => {
    if (!bytes) return ''
    const mb = bytes / (1024 * 1024)
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
  }

  // Filter applications by search term
  const matchesSearch = (name) => {
    if (!searchTerm) return true
    return name.toLowerCase().includes(searchTerm.toLowerCase())
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading applications...
      </div>
    )
  }

  if (error && !browseData) {
    return (
      <div className="text-center py-6">
        <p className="text-red-400 text-sm mb-2">{error}</p>
        <button onClick={loadBrowseData} className="text-blue-400 hover:text-blue-300 text-sm flex items-center mx-auto gap-1">
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
    )
  }

  if (!browseData || browseData.totalApplications === 0) {
    return (
      <div className="text-center py-6 text-gray-400">
        <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No applications found in the applications folder.</p>
        <p className="text-xs mt-1">Place PDFs in: applications/FY26/HRSA-26-002/</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <HardDrive className="w-4 h-4" />
          <span>{browseData.totalApplications} application(s) on server</span>
        </div>
        <button onClick={loadBrowseData} className="text-gray-400 hover:text-gray-200 p-1" title="Refresh">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          placeholder="Search applications..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full pl-9 pr-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded px-3 py-2 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Tree view */}
      <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
        {browseData.fiscalYears.map(fy => {
          const fyExpanded = expandedFYs[fy.fy]
          // Count matching apps in this FY
          const fyAppCount = fy.nofos.reduce((sum, n) => sum + n.applications.filter(a => matchesSearch(a.name)).length, 0)
            + (fy.loosePdfs || []).filter(a => matchesSearch(a.name)).length
          if (fyAppCount === 0 && searchTerm) return null

          return (
            <div key={fy.fy}>
              {/* FY Header */}
              <button
                onClick={() => toggleFY(fy.fy)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700/50 text-left transition-colors"
              >
                {fyExpanded ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                <FolderOpen className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                <span className="text-sm font-semibold text-yellow-300">{fy.fy}</span>
                <span className="text-xs text-gray-500 ml-auto">{fyAppCount} app(s)</span>
              </button>

              {/* FY Contents */}
              {fyExpanded && (
                <div className="ml-4 space-y-0.5">
                  {fy.nofos.map(nofo => {
                    const nofoKey = `${fy.fy}/${nofo.nofo}`
                    const nofoExpanded = expandedNOFOs[nofoKey]
                    const filteredApps = nofo.applications.filter(a => matchesSearch(a.name))
                    if (filteredApps.length === 0 && searchTerm) return null

                    return (
                      <div key={nofoKey}>
                        {/* NOFO Header */}
                        <button
                          onClick={() => toggleNOFO(nofoKey)}
                          className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-700/50 text-left transition-colors"
                        >
                          {nofoExpanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
                          <FolderOpen className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                          <span className="text-sm text-blue-300">{nofo.nofo}</span>
                          <span className="text-xs text-gray-500 ml-auto">{filteredApps.length}</span>
                        </button>

                        {/* Application PDFs */}
                        {nofoExpanded && (
                          <div className="ml-6 space-y-0.5">
                            {filteredApps.map(app => {
                              const isSelected = selectedPaths.has(app.path)
                              const isExtracting = extracting === app.path
                              // Extract org name from filename: HRSA-26-002_ORG_NAME_Application-XXXXXX.pdf
                              const orgName = app.name
                                .replace(/^HRSA-\d{2}-\d{3}_/, '')
                                .replace(/_Application-\d+\.pdf$/i, '')
                                .replace(/_/g, ' ')

                              return (
                                <button
                                  key={app.path}
                                  onClick={() => handleSelectApp(app)}
                                  disabled={isExtracting || (isSelected && !multiSelect)}
                                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors text-xs
                                    ${isSelected ? 'bg-green-900/30 border border-green-700' : 'hover:bg-slate-700/50 border border-transparent'}
                                    ${isExtracting ? 'opacity-70 cursor-wait' : ''}
                                    ${isSelected && !multiSelect ? 'cursor-default' : 'cursor-pointer'}
                                  `}
                                >
                                  {isExtracting ? (
                                    <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />
                                  ) : (
                                    <FileText className={`w-3.5 h-3.5 flex-shrink-0 ${isSelected ? 'text-green-400' : 'text-gray-400'}`} />
                                  )}
                                  <span className={`truncate flex-1 ${isSelected ? 'text-green-300' : 'text-gray-300'}`} title={app.name}>
                                    {orgName || app.name}
                                  </span>
                                  <span className="text-gray-600 flex-shrink-0">{formatSize(app.size)}</span>
                                  {isSelected && <span className="text-green-400 text-xs flex-shrink-0">✓</span>}
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Loose PDFs in FY folder */}
                  {(fy.loosePdfs || []).filter(a => matchesSearch(a.name)).map(app => (
                    <button
                      key={app.path}
                      onClick={() => handleSelectApp(app)}
                      disabled={extracting === app.path}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700/50 text-left transition-colors text-xs border border-transparent"
                    >
                      {extracting === app.path ? (
                        <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      )}
                      <span className="truncate flex-1 text-gray-300">{app.name}</span>
                      <span className="text-gray-600 flex-shrink-0">{formatSize(app.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* Ungrouped PDFs */}
        {browseData.ungrouped?.length > 0 && (
          <div>
            <div className="px-2 py-1 text-xs text-gray-500 font-medium">Ungrouped</div>
            {browseData.ungrouped.filter(a => matchesSearch(a.name)).map(app => (
              <button
                key={app.path}
                onClick={() => handleSelectApp(app)}
                disabled={extracting === app.path}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700/50 text-left transition-colors text-xs border border-transparent"
              >
                {extracting === app.path ? (
                  <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin flex-shrink-0" />
                ) : (
                  <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                )}
                <span className="truncate flex-1 text-gray-300">{app.name}</span>
                <span className="text-gray-600 flex-shrink-0">{formatSize(app.size)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {extracting && (
        <div className="flex items-center gap-2 text-xs text-blue-300 bg-blue-900/20 rounded px-3 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Extracting application data (uses cache if available)...
        </div>
      )}
    </div>
  )
}
