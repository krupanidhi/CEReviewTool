import { useState, useEffect } from 'react'
import {
  Upload, FileText, CheckSquare, Square, Play, Loader2, AlertCircle,
  ChevronDown, ChevronRight, Trash2, CheckCircle, Clock, XCircle, RefreshCw,
  FolderOpen, ListChecks
} from 'lucide-react'
import { queueApplications, getProcessedApplications, getStoredChecklists, loadStoredChecklist } from '../services/api'
import EnhancedComparisonUpload from './EnhancedComparisonUpload'
import ChecklistSelector from './ChecklistSelector'

export default function BatchProcessor() {
  const [step, setStep] = useState(1) // 1=upload, 2=select sections, 3=queue status
  const [uploadedDocs, setUploadedDocs] = useState(null)
  const [selectedSections, setSelectedSections] = useState([])
  const [queueing, setQueueing] = useState(false)
  const [queueResult, setQueueResult] = useState(null)
  const [error, setError] = useState(null)
  const [storedChecklists, setStoredChecklists] = useState([])
  const [selectedStoredChecklist, setSelectedStoredChecklist] = useState(null)
  const [loadingChecklist, setLoadingChecklist] = useState(false)
  const [processingStatus, setProcessingStatus] = useState(null)

  // Load stored checklists on mount
  useEffect(() => {
    loadChecklists()
  }, [])

  // Poll for processing status when jobs are queued
  useEffect(() => {
    if (!queueResult) return
    const interval = setInterval(async () => {
      try {
        const result = await getProcessedApplications()
        setProcessingStatus(result)
        // Stop polling if all done
        const hasActive = (result.applications || []).some(a => a.status === 'processing' || a.status === 'queued')
        if (!hasActive) clearInterval(interval)
      } catch (e) { /* ignore */ }
    }, 5000)
    return () => clearInterval(interval)
  }, [queueResult])

  const loadChecklists = async () => {
    try {
      const result = await getStoredChecklists()
      setStoredChecklists(result.checklists || [])
    } catch (e) {
      console.warn('Could not load stored checklists:', e.message)
    }
  }

  const handleDocumentsUploaded = (docs) => {
    setUploadedDocs(docs)
    setStep(2)
  }

  const handleUseStoredChecklist = async (checklist) => {
    setLoadingChecklist(true)
    try {
      const result = await loadStoredChecklist(checklist.id)
      const checklistData = result.checklist
      // Build a checklist object compatible with the upload flow
      const checklistObj = {
        id: checklistData.id,
        name: checklistData.displayName || checklistData.originalName,
        originalName: checklistData.originalName,
        data: checklistData.data,
        analysis: { data: checklistData.data }
      }
      setSelectedStoredChecklist(checklistObj)
    } catch (e) {
      setError(`Failed to load checklist: ${e.message}`)
    } finally {
      setLoadingChecklist(false)
    }
  }

  const handleQueueBatch = async () => {
    setQueueing(true)
    setError(null)
    try {
      const applications = uploadedDocs.applications.map(app => ({
        name: app.originalName || app.name,
        data: app.analysis?.data || app.data
      }))

      const checklist = selectedStoredChecklist || uploadedDocs.checklists?.[0]
      if (!checklist) {
        setError('No checklist selected')
        return
      }

      const checklistData = checklist.analysis?.data || checklist.data
      const checklistName = checklist.originalName || checklist.name

      const result = await queueApplications(
        applications,
        checklistData,
        selectedSections,
        checklistName
      )

      setQueueResult(result)
      setStep(3)
    } catch (err) {
      setError(`Failed to queue batch: ${err.message}`)
    } finally {
      setQueueing(false)
    }
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-4 h-4 text-green-500" />
      case 'processing': return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
      case 'queued': return <Clock className="w-4 h-4 text-yellow-400" />
      case 'error': return <XCircle className="w-4 h-4 text-red-500" />
      default: return <Clock className="w-4 h-4 text-gray-400" />
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center space-x-3 mb-2">
          <div className="bg-purple-500/10 p-2 rounded-lg">
            <ListChecks className="w-6 h-6 text-purple-500" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Batch Processor</h2>
            <p className="text-sm text-gray-400">Queue multiple applications for background comparison against the same checklist</p>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center mt-4 space-x-4">
          {[
            { num: 1, label: 'Upload Applications & Checklist' },
            { num: 2, label: 'Select Sections' },
            { num: 3, label: 'Processing Queue' }
          ].map((s, idx) => (
            <div key={s.num} className="flex items-center">
              {idx > 0 && <div className={`w-8 h-px mx-2 ${step >= s.num ? 'bg-purple-500' : 'bg-slate-600'}`} />}
              <div className={`flex items-center space-x-2 ${step >= s.num ? 'text-purple-400' : 'text-gray-500'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                  step >= s.num ? 'bg-purple-500 text-white' : 'bg-slate-700 text-gray-400'
                }`}>{s.num}</div>
                <span className="text-sm font-medium hidden md:inline">{s.label}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Step 1: Upload */}
      {step === 1 && (
        <div className="space-y-6">
          {/* Stored Checklists Quick-Pick */}
          {storedChecklists.length > 0 && (
            <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
              <h3 className="text-lg font-semibold text-white mb-3 flex items-center space-x-2">
                <FolderOpen className="w-5 h-5 text-green-400" />
                <span>Use Stored Checklist</span>
              </h3>
              <p className="text-sm text-gray-400 mb-4">Select a previously uploaded checklist to use for batch processing</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {storedChecklists.map(cl => (
                  <button
                    key={cl.id}
                    onClick={() => handleUseStoredChecklist(cl)}
                    disabled={loadingChecklist}
                    className={`p-4 rounded-lg border text-left transition-all ${
                      selectedStoredChecklist?.id === cl.id
                        ? 'bg-green-500/10 border-green-500/40 ring-1 ring-green-500/30'
                        : 'bg-slate-900 border-slate-600 hover:border-green-500/30 hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center space-x-2 mb-1">
                      <FileText className="w-4 h-4 text-green-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-white truncate">{cl.displayName || cl.originalName}</span>
                    </div>
                    <div className="text-xs text-gray-400">
                      Saved {new Date(cl.savedAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
              {selectedStoredChecklist && (
                <div className="mt-3 flex items-center space-x-2 text-sm text-green-400">
                  <CheckCircle className="w-4 h-4" />
                  <span>Using: {selectedStoredChecklist.originalName || selectedStoredChecklist.name}</span>
                </div>
              )}
            </div>
          )}

          <EnhancedComparisonUpload
            onDocumentsUploaded={handleDocumentsUploaded}
            batchMode={true}
          />
        </div>
      )}

      {/* Step 2: Select Sections */}
      {step === 2 && uploadedDocs && (
        <div className="space-y-6">
          {/* Summary of what's being processed */}
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Batch Summary</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-gray-400 mb-1">Applications ({uploadedDocs.applications?.length || 0})</div>
                <div className="space-y-1">
                  {uploadedDocs.applications?.map((app, i) => (
                    <div key={i} className="flex items-center space-x-2 text-sm text-gray-300">
                      <FileText className="w-3 h-3 text-blue-400 flex-shrink-0" />
                      <span className="truncate">{app.originalName || app.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">Checklist</div>
                <div className="flex items-center space-x-2 text-sm text-gray-300">
                  <FileText className="w-3 h-3 text-green-400 flex-shrink-0" />
                  <span className="truncate">
                    {selectedStoredChecklist?.originalName || selectedStoredChecklist?.name || 
                     uploadedDocs.checklists?.[0]?.originalName || uploadedDocs.checklists?.[0]?.name || 'None'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <ChecklistSelector
            checklists={selectedStoredChecklist ? [selectedStoredChecklist] : uploadedDocs.checklists}
            onSelectionChange={setSelectedSections}
          />

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 flex items-center space-x-2">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={() => setStep(1)}
              className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleQueueBatch}
              disabled={selectedSections.length === 0 || queueing}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 text-white px-8 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2"
            >
              {queueing ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Queueing...</span>
                </>
              ) : (
                <>
                  <Play className="w-5 h-5" />
                  <span>Queue {uploadedDocs.applications?.length || 0} Application(s)</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Queue Status */}
      {step === 3 && queueResult && (
        <div className="space-y-6">
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-center space-x-3">
            <CheckCircle className="w-6 h-6 text-green-400 flex-shrink-0" />
            <div>
              <div className="text-green-300 font-medium">Batch queued successfully</div>
              <div className="text-sm text-green-400/70">
                {queueResult.queued?.length || 0} application(s) queued for background processing
              </div>
            </div>
          </div>

          {/* Queued Items */}
          <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
            <div className="p-4 border-b border-slate-700">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">Processing Queue</h3>
                <button
                  onClick={async () => {
                    try {
                      const result = await getProcessedApplications()
                      setProcessingStatus(result)
                    } catch (e) { /* ignore */ }
                  }}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors text-gray-400"
                  title="Refresh status"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-700">
              {(processingStatus?.applications || queueResult.queued || []).map((item) => (
                <div key={item.id} className="p-4 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    {getStatusIcon(item.status)}
                    <div>
                      <div className="text-sm font-medium text-white">{item.name}</div>
                      <div className="text-xs text-gray-400">
                        {item.status === 'completed' && item.complianceScore
                          ? `${item.complianceScore}% compliance`
                          : item.status === 'error'
                          ? item.error || 'Processing failed'
                          : item.status === 'processing'
                          ? 'Processing...'
                          : 'Waiting in queue'}
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full ${
                    item.status === 'completed' ? 'bg-green-500/10 text-green-400' :
                    item.status === 'processing' ? 'bg-blue-500/10 text-blue-400' :
                    item.status === 'error' ? 'bg-red-500/10 text-red-400' :
                    'bg-yellow-500/10 text-yellow-400'
                  }`}>
                    {item.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={() => {
                setStep(1)
                setQueueResult(null)
                setUploadedDocs(null)
                setSelectedSections([])
                setProcessingStatus(null)
              }}
              className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              Queue More
            </button>
            <p className="text-sm text-gray-400">
              Results will appear on the Dashboard when processing completes.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
