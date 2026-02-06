import { useState, useEffect } from 'react'
import { Search, FileText, Calendar, Hash, Eye, LayoutDashboard } from 'lucide-react'
import { getCacheData } from '../services/api'

export default function Dashboard({ onViewResults }) {
  const [applications, setApplications] = useState([])
  const [filteredApplications, setFilteredApplications] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadApplications()
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

  const loadApplications = async () => {
    try {
      const result = await getCacheData('analysis')
      const analysisCache = result.cache.analysis || []
      
      const apps = analysisCache
        .filter(entry => entry.type === 'comparison')
        .map(entry => ({
          id: entry.documentId,
          name: entry.documentName,
          date: new Date(entry.timestamp).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          }),
          timestamp: entry.timestamp,
          data: entry.analysisData
        }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

      setApplications(apps)
      setFilteredApplications(apps)
    } catch (error) {
      console.error('Failed to load applications:', error)
      setApplications([])
      setFilteredApplications([])
    } finally {
      setLoading(false)
    }
  }

  const handleViewResults = (app) => {
    if (onViewResults) {
      onViewResults(app)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading applications...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center space-x-3 mb-6">
          <div className="bg-blue-500/10 p-2 rounded-lg">
            <LayoutDashboard className="w-6 h-6 text-blue-500" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Dashboard - Analyzed Applications</h2>
            <p className="text-sm text-gray-400">View and manage CE review validation results</p>
          </div>
        </div>

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
        <div className="mt-4 text-sm text-gray-400">
          Showing {filteredApplications.length} of {applications.length} applications
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
              ? 'Complete a comparison validation to see results here'
              : 'Try a different search term'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {filteredApplications.map((app) => (
            <div
              key={app.id}
              className="bg-slate-800 rounded-lg border border-slate-700 hover:border-blue-500 transition-all hover:shadow-lg hover:shadow-blue-500/10"
            >
              <div className="p-5">
                {/* Document Icon */}
                <div className="mb-4">
                  <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
                    <FileText className="w-8 h-8 text-blue-400 mx-auto" />
                  </div>
                </div>

                {/* Application Name */}
                <h3 className="text-white font-medium mb-3 line-clamp-2 min-h-[3rem]" title={app.name}>
                  {app.name}
                </h3>

                {/* Metadata */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-center space-x-2 text-xs text-gray-400">
                    <Calendar className="w-3 h-3" />
                    <span>{app.date}</span>
                  </div>
                  <div className="flex items-center space-x-2 text-xs text-gray-400">
                    <Hash className="w-3 h-3" />
                    <span className="truncate" title={app.id}>{app.id}</span>
                  </div>
                </div>

                {/* View Results Button */}
                <button
                  onClick={() => handleViewResults(app)}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
                >
                  <Eye className="w-4 h-4" />
                  <span>View Results</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
