import { useState, useEffect, useRef } from 'react'
import { Search, FileText, Calendar, Hash, Eye, LayoutDashboard, Loader2, CheckCircle, AlertCircle, Clock, RefreshCw, Trash2 } from 'lucide-react'
import { getProcessedApplications, getProcessedApplication, deleteProcessedApplication } from '../services/api'

export default function Dashboard({ onViewResults }) {
  const [applications, setApplications] = useState([])
  const [filteredApplications, setFilteredApplications] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [processingStatus, setProcessingStatus] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    loadApplications()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  useEffect(() => {
    if (searchQuery.trim() === '') {
      setFilteredApplications(applications)
    } else {
      const query = searchQuery.toLowerCase()
      const filtered = applications.filter(app => 
        app.name.toLowerCase().includes(query) ||
        app.id.toLowerCase().includes(query)
      )
      setFilteredApplications(filtered)
    }
  }, [searchQuery, applications])

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

  const getStatusBadge = (status) => {
    switch (status) {
      case 'completed':
        return (
          <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded-full">
            <CheckCircle className="w-3 h-3" /> Completed
          </span>
        )
      case 'processing':
        return (
          <span className="flex items-center gap-1 text-xs font-medium text-blue-400 bg-blue-500/10 px-2 py-1 rounded-full">
            <Loader2 className="w-3 h-3 animate-spin" /> Processing
          </span>
        )
      case 'queued':
        return (
          <span className="flex items-center gap-1 text-xs font-medium text-yellow-400 bg-yellow-500/10 px-2 py-1 rounded-full">
            <Clock className="w-3 h-3" /> Queued
          </span>
        )
      case 'error':
        return (
          <span className="flex items-center gap-1 text-xs font-medium text-red-400 bg-red-500/10 px-2 py-1 rounded-full">
            <AlertCircle className="w-3 h-3" /> Error
          </span>
        )
      default:
        return (
          <span className="flex items-center gap-1 text-xs font-medium text-gray-400 bg-gray-500/10 px-2 py-1 rounded-full">
            <Clock className="w-3 h-3" /> {status}
          </span>
        )
    }
  }

  const getComplianceColor = (score) => {
    const num = parseInt(score)
    if (num >= 80) return 'text-green-400'
    if (num >= 60) return 'text-yellow-400'
    return 'text-red-400'
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
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-500/10 p-2 rounded-lg">
              <LayoutDashboard className="w-6 h-6 text-blue-500" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white">Dashboard - Analyzed Applications</h2>
              <p className="text-sm text-gray-400">View and manage CE review validation results</p>
            </div>
          </div>
          <button
            onClick={loadApplications}
            className="bg-slate-700 hover:bg-slate-600 text-gray-300 p-2 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>

        {/* Processing Status Bar */}
        {processingStatus && (processingStatus.processing > 0 || processingStatus.queued > 0) && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 mb-4 flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-blue-400 animate-spin flex-shrink-0" />
            <span className="text-sm text-blue-300">
              {processingStatus.processing > 0 && `${processingStatus.processing} application(s) processing`}
              {processingStatus.processing > 0 && processingStatus.queued > 0 && ', '}
              {processingStatus.queued > 0 && `${processingStatus.queued} queued`}
            </span>
          </div>
        )}

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search by application name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-900 text-white rounded-lg pl-12 pr-4 py-3 border border-slate-600 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Results Count */}
        <div className="mt-4 flex items-center justify-between text-sm text-gray-400">
          <span>Showing {filteredApplications.length} of {applications.length} applications</span>
          {processingStatus && (
            <span>{processingStatus.completed} completed • {processingStatus.total} total</span>
          )}
        </div>
      </div>

      {/* Application Tiles */}
      {filteredApplications.length === 0 ? (
        <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700">
          <FileText className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-300 mb-2">
            {applications.length === 0 ? 'No analyzed applications yet' : 'No matching applications'}
          </h3>
          <p className="text-gray-500">
            {applications.length === 0 
              ? 'Go to Compare & Validate to process applications'
              : 'Try a different search term'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredApplications.map((app) => (
            <div
              key={app.id}
              className={`bg-slate-800 rounded-lg border transition-all ${
                app.status === 'completed'
                  ? 'border-slate-700 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-500/10 cursor-pointer'
                  : app.status === 'processing' || app.status === 'queued'
                  ? 'border-blue-500/30'
                  : 'border-red-500/30'
              }`}
              onClick={() => app.status === 'completed' && handleViewResults(app)}
            >
              <div className="p-5">
                {/* Status + Delete */}
                <div className="flex items-center justify-between mb-3">
                  {getStatusBadge(app.status)}
                  <button
                    onClick={(e) => handleDelete(app.id, e)}
                    className="text-gray-500 hover:text-red-400 transition-colors p-1"
                    title="Delete application"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Document Icon */}
                <div className="mb-4">
                  <div className={`rounded-lg p-4 border ${
                    app.status === 'completed' ? 'bg-slate-900 border-slate-600' :
                    app.status === 'processing' ? 'bg-blue-900/20 border-blue-500/30' :
                    app.status === 'error' ? 'bg-red-900/20 border-red-500/30' :
                    'bg-slate-900 border-slate-600'
                  }`}>
                    {app.status === 'processing' ? (
                      <Loader2 className="w-8 h-8 text-blue-400 mx-auto animate-spin" />
                    ) : (
                      <FileText className="w-8 h-8 text-blue-400 mx-auto" />
                    )}
                  </div>
                </div>

                {/* Application Name */}
                <h3 className="text-white font-medium mb-2 line-clamp-2 min-h-[2.5rem] text-sm" title={app.name}>
                  {app.name}
                </h3>

                {/* Compliance Score */}
                {app.status === 'completed' && app.complianceScore && (
                  <div className="mb-3">
                    <div className={`text-2xl font-bold ${getComplianceColor(app.complianceScore)}`}>
                      {app.complianceScore}%
                    </div>
                    <div className="text-xs text-gray-500">Compliance Score</div>
                  </div>
                )}

                {/* Error Message */}
                {app.status === 'error' && app.error && (
                  <div className="mb-3 text-xs text-red-400 bg-red-500/10 rounded p-2 line-clamp-2">
                    {app.error}
                  </div>
                )}

                {/* Metadata */}
                <div className="space-y-1.5 mb-4">
                  {app.checklistName && (
                    <div className="flex items-center space-x-2 text-xs text-gray-400">
                      <FileText className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{app.checklistName}</span>
                    </div>
                  )}
                  <div className="flex items-center space-x-2 text-xs text-gray-400">
                    <Calendar className="w-3 h-3 flex-shrink-0" />
                    <span>{formatDate(app.processedAt || app.createdAt)}</span>
                  </div>
                </div>

                {/* View Results Button */}
                {app.status === 'completed' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewResults(app) }}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2 text-sm"
                  >
                    <Eye className="w-4 h-4" />
                    <span>View Results</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
