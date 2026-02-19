import { useState, useRef, useEffect } from 'react'
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, GitCompare, X, Plus, Database, Trash2, RefreshCw, FolderOpen } from 'lucide-react'
import { uploadDocument, getSettings, getStoredChecklists, loadStoredChecklist, saveStoredChecklist, deleteStoredChecklist } from '../services/api'
import ApplicationBrowser from './ApplicationBrowser'

export default function EnhancedComparisonUpload({ onDocumentsUploaded }) {
  const [applicationFiles, setApplicationFiles] = useState([])
  const [checklistFiles, setChecklistFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState(null)
  const [uploadedDocs, setUploadedDocs] = useState({ applications: [], checklists: [] })
  const [settings, setSettings] = useState({ multipleApplications: false, multipleChecklists: true })
  const [appMode, setAppMode] = useState('upload') // 'upload' or 'browse'
  const [folderApps, setFolderApps] = useState([]) // apps selected from ApplicationBrowser
  const [checklistMode, setChecklistMode] = useState('upload') // 'upload' or 'stored'
  const [storedChecklists, setStoredChecklists] = useState([])
  const [selectedStoredChecklist, setSelectedStoredChecklist] = useState(null)
  const [loadingStored, setLoadingStored] = useState(false)
  
  const applicationInputRef = useRef(null)
  const checklistInputRef = useRef(null)

  useEffect(() => {
    loadSettings()
    loadStoredChecklistsList()
  }, [])

  const loadSettings = async () => {
    try {
      const result = await getSettings()
      setSettings(result.settings)
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }

  const loadStoredChecklistsList = async () => {
    try {
      const result = await getStoredChecklists()
      setStoredChecklists(result.checklists || [])
      // Auto-switch to stored mode if checklists exist and auto-select first
      if (result.checklists && result.checklists.length > 0) {
        setChecklistMode('stored')
        // Auto-select the first stored checklist so Upload button is enabled
        if (!selectedStoredChecklist) {
          handleSelectStoredChecklist(result.checklists[0].id)
        }
      }
    } catch (error) {
      console.error('Failed to load stored checklists:', error)
    }
  }

  const handleSelectStoredChecklist = async (id) => {
    setLoadingStored(true)
    try {
      const result = await loadStoredChecklist(id)
      setSelectedStoredChecklist(result)
      setChecklistFiles([]) // Clear any file uploads
      setStatus({ type: 'success', message: `Loaded stored checklist: ${result.displayName}` })
    } catch (error) {
      setStatus({ type: 'error', message: `Failed to load checklist: ${error.message}` })
    } finally {
      setLoadingStored(false)
    }
  }

  const handleDeleteStoredChecklist = async (id, e) => {
    e.stopPropagation()
    try {
      await deleteStoredChecklist(id)
      setStoredChecklists(prev => prev.filter(c => c.id !== id))
      if (selectedStoredChecklist?.id === id) {
        setSelectedStoredChecklist(null)
      }
    } catch (error) {
      setStatus({ type: 'error', message: `Failed to delete: ${error.message}` })
    }
  }

  const handleFileSelect = (type, files) => {
    const fileArray = Array.from(files)
    
    if (type === 'application') {
      if (settings.multipleApplications) {
        setApplicationFiles(prev => [...prev, ...fileArray])
      } else {
        setApplicationFiles([fileArray[0]])
      }
    } else {
      if (settings.multipleChecklists) {
        setChecklistFiles(prev => [...prev, ...fileArray])
      } else {
        setChecklistFiles([fileArray[0]])
      }
    }
    setStatus(null)
  }

  const removeFile = (type, index) => {
    if (type === 'application') {
      setApplicationFiles(prev => prev.filter((_, i) => i !== index))
    } else {
      setChecklistFiles(prev => prev.filter((_, i) => i !== index))
    }
  }

  const handleFolderAppSelect = (appResult) => {
    setFolderApps(prev => {
      // Avoid duplicates by path
      if (prev.some(a => a.folderPath === appResult.folderPath)) return prev
      return [...prev, appResult]
    })
    setStatus({ type: 'success', message: `Selected: ${appResult.originalName} (${appResult.source === 'cache' ? 'cached' : 'extracted'})` })
  }

  const removeFolderApp = (index) => {
    setFolderApps(prev => prev.filter((_, i) => i !== index))
  }

  const handleUploadAll = async () => {
    const hasChecklist = checklistMode === 'stored' ? !!selectedStoredChecklist : checklistFiles.length > 0
    const hasApps = appMode === 'browse' ? folderApps.length > 0 : applicationFiles.length > 0
    
    if (!hasApps || !hasChecklist) {
      setStatus({ type: 'error', message: 'Please select at least one application and one checklist' })
      return
    }

    setUploading(true)
    setStatus(null)

    try {
      const applications = []
      const checklists = []

      if (appMode === 'browse') {
        // Folder-selected apps are already extracted — use directly
        setStatus({ type: 'info', message: `Using ${folderApps.length} application(s) from server...` })
        for (const app of folderApps) {
          applications.push(app)
        }
      } else {
        setStatus({ type: 'info', message: `Uploading ${applicationFiles.length} application(s)...` })
        for (const file of applicationFiles) {
          const result = await uploadDocument(file)
          applications.push(result)
        }
      }

      if (checklistMode === 'stored' && selectedStoredChecklist) {
        // Use stored checklist — no re-upload, no re-extraction
        setStatus({ type: 'info', message: `Using stored checklist: ${selectedStoredChecklist.displayName}` })
        checklists.push({
          id: selectedStoredChecklist.id,
          originalName: selectedStoredChecklist.originalName,
          name: selectedStoredChecklist.displayName,
          analysis: selectedStoredChecklist.analysis,
          data: selectedStoredChecklist.data,
          structuredData: selectedStoredChecklist.structuredData,
          fromStore: true
        })
      } else {
        // Upload new checklist(s) via Azure Doc Intelligence
        setStatus({ type: 'info', message: `Uploading ${checklistFiles.length} checklist(s)...` })
        for (const file of checklistFiles) {
          const result = await uploadDocument(file)
          checklists.push(result)

          // Auto-save to store for future reuse
          try {
            const saveResult = await saveStoredChecklist(
              result.originalName,
              result.data,
              result.structuredData
            )
            if (!saveResult.alreadyExists) {
              console.log('📋 Checklist auto-saved for future reuse:', saveResult.checklist?.displayName)
            }
            // Refresh the stored list
            loadStoredChecklistsList()
          } catch (saveError) {
            console.warn('Could not auto-save checklist:', saveError.message)
          }
        }
      }

      setUploadedDocs({ applications, checklists })
      setStatus({ type: 'success', message: 'All documents processed successfully! Ready to proceed.' })
      
      if (onDocumentsUploaded) {
        onDocumentsUploaded({ applications, checklists })
      }
    } catch (error) {
      setStatus({ 
        type: 'error', 
        message: `Upload failed: ${error.message}` 
      })
    } finally {
      setUploading(false)
    }
  }

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center space-x-3 mb-6">
          <div className="bg-blue-500/10 p-2 rounded-lg">
            <GitCompare className="w-6 h-6 text-blue-500" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">Upload Documents for Comparison</h2>
            <p className="text-sm text-gray-400">
              Upload application(s) and checklist/guide document(s) for validation
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Application Upload / Browse */}
          <div className="border-4 border-dashed border-blue-500 rounded-lg p-6 bg-blue-900/10">
            <input
              ref={applicationInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.bmp"
              multiple={settings.multipleApplications}
              onChange={(e) => handleFileSelect('application', e.target.files)}
            />
            
            <div className="text-center mb-4">
              <div className="bg-blue-600 text-white px-4 py-2 rounded-lg mb-4 font-bold text-xl">
                📄 APPLICATION DOCUMENT
              </div>

              {/* Mode Toggle: Upload vs Browse Server */}
              <div className="flex items-center justify-center gap-2 mb-4">
                <button
                  onClick={() => setAppMode('browse')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    appMode === 'browse'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse Server
                </button>
                <button
                  onClick={() => setAppMode('upload')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    appMode === 'upload'
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload New
                </button>
              </div>

              {/* BROWSE MODE */}
              {appMode === 'browse' && (
                <div className="text-left">
                  <ApplicationBrowser
                    onSelect={handleFolderAppSelect}
                    multiSelect={settings.multipleApplications}
                  />
                  {folderApps.length > 0 && (
                    <div className="mt-3 space-y-1">
                      <p className="text-xs text-gray-400 font-medium">Selected ({folderApps.length}):</p>
                      {folderApps.map((app, idx) => (
                        <div key={idx} className="bg-slate-900 rounded p-2 flex items-center justify-between border border-green-700/50">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-green-300 truncate">{app.originalName}</p>
                            <p className="text-xs text-gray-500">{app.source === 'cache' ? '📦 Cached' : '✨ Extracted'}</p>
                          </div>
                          <button onClick={() => removeFolderApp(idx)} className="ml-2 text-red-400 hover:text-red-300">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* UPLOAD MODE */}
              {appMode === 'upload' && (
                <div>
                  <FileText className="w-16 h-16 mx-auto mb-3 text-blue-400" />
                  <h3 className="text-2xl font-bold text-blue-300 mb-3">
                    Application Document{settings.multipleApplications ? 's' : ''}
                  </h3>
                  <div className="bg-blue-800/50 border-2 border-blue-500 rounded-lg p-3 mb-4">
                    <p className="text-sm text-blue-200 font-semibold mb-2">
                      ⚠️ UPLOAD YOUR GRANT APPLICATION HERE
                    </p>
                    <p className="text-xs text-gray-300">
                      Example: Application-242645.pdf<br/>
                      This is the document you are SUBMITTING for review
                    </p>
                  </div>
                  <button
                    onClick={() => applicationInputRef.current?.click()}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 mx-auto"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Application{settings.multipleApplications ? 's' : ''}</span>
                  </button>
                </div>
              )}
            </div>

            {applicationFiles.length > 0 && appMode === 'upload' && (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {applicationFiles.map((file, idx) => (
                  <div key={idx} className="bg-slate-900 rounded p-3 flex items-center justify-between border border-slate-600">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-300 truncate">{file.name}</p>
                      <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                    </div>
                    <button
                      onClick={() => removeFile('application', idx)}
                      className="ml-2 text-red-400 hover:text-red-300"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Checklist Upload / Stored Selection */}
          <div className="border-4 border-dashed border-green-500 rounded-lg p-6 bg-green-900/10">
            <input
              ref={checklistInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.bmp"
              multiple={settings.multipleChecklists}
              onChange={(e) => handleFileSelect('checklist', e.target.files)}
            />
            
            <div className="text-center mb-4">
              <div className="bg-green-600 text-white px-4 py-2 rounded-lg mb-4 font-bold text-xl">
                ✅ CHECKLIST/REQUIREMENTS GUIDE
              </div>

              {/* Mode Toggle */}
              <div className="flex items-center justify-center gap-2 mb-4">
                <button
                  onClick={() => { setChecklistMode('stored'); setSelectedStoredChecklist(null) }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    checklistMode === 'stored'
                      ? 'bg-green-600 text-white'
                      : 'bg-slate-700 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Database className="w-3.5 h-3.5" />
                  Use Stored ({storedChecklists.length})
                </button>
                <button
                  onClick={() => { setChecklistMode('upload'); setSelectedStoredChecklist(null) }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    checklistMode === 'upload'
                      ? 'bg-green-600 text-white'
                      : 'bg-slate-700 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload New
                </button>
              </div>

              {/* STORED MODE */}
              {checklistMode === 'stored' && (
                <div>
                  {storedChecklists.length === 0 ? (
                    <div className="bg-slate-900/50 border border-slate-600 rounded-lg p-4 mb-4">
                      <p className="text-sm text-gray-400 mb-2">No stored checklists yet.</p>
                      <p className="text-xs text-gray-500">Upload a checklist once and it will be saved automatically for future use.</p>
                      <button
                        onClick={() => setChecklistMode('upload')}
                        className="mt-3 bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                      >
                        Upload First Checklist
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-56 overflow-y-auto mb-4">
                      {storedChecklists.map((cl) => (
                        <div
                          key={cl.id}
                          onClick={() => handleSelectStoredChecklist(cl.id)}
                          className={`bg-slate-900 rounded-lg p-3 flex items-center justify-between border cursor-pointer transition-all ${
                            selectedStoredChecklist?.id === cl.id
                              ? 'border-green-500 bg-green-900/20 ring-1 ring-green-500/50'
                              : 'border-slate-600 hover:border-green-400/50'
                          }`}
                        >
                          <div className="flex-1 min-w-0 text-left">
                            <p className="text-sm text-gray-200 font-medium truncate">{cl.displayName}</p>
                            <p className="text-xs text-gray-500">
                              {cl.metadata.sectionCount} sections • {cl.metadata.pageCount} pages • {new Date(cl.savedAt).toLocaleDateString()}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 ml-2">
                            {selectedStoredChecklist?.id === cl.id && (
                              <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                            )}
                            <button
                              onClick={(e) => handleDeleteStoredChecklist(cl.id, e)}
                              className="text-gray-500 hover:text-red-400 transition-colors p-1"
                              title="Delete stored checklist"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {loadingStored && (
                    <div className="flex items-center justify-center gap-2 text-green-400 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Loading checklist data...</span>
                    </div>
                  )}
                </div>
              )}

              {/* UPLOAD MODE */}
              {checklistMode === 'upload' && (
                <div>
                  <FileText className="w-16 h-16 mx-auto mb-3 text-green-400" />
                  <h3 className="text-2xl font-bold text-green-300 mb-3">
                    Checklist/Guide{settings.multipleChecklists ? 's' : ''}
                  </h3>
                  <div className="bg-green-800/50 border-2 border-green-500 rounded-lg p-3 mb-4">
                    <p className="text-sm text-green-200 font-semibold mb-2">
                      ⚠️ UPLOAD REQUIREMENTS CHECKLIST HERE
                    </p>
                    <p className="text-xs text-gray-300">
                      Example: FY26 SAC Application User Guide.pdf<br/>
                      This is the document with VALIDATION REQUIREMENTS
                    </p>
                    <p className="text-xs text-green-300 mt-2 font-medium">
                      ✨ Uploaded checklists are auto-saved for future reuse
                    </p>
                  </div>
                  <button
                    onClick={() => checklistInputRef.current?.click()}
                    className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 mx-auto"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Checklist{settings.multipleChecklists ? 's' : ''}</span>
                  </button>
                </div>
              )}
            </div>

            {checklistFiles.length > 0 && checklistMode === 'upload' && (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {checklistFiles.map((file, idx) => (
                  <div key={idx} className="bg-slate-900 rounded p-3 flex items-center justify-between border border-slate-600">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-300 truncate">{file.name}</p>
                      <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                    </div>
                    <button
                      onClick={() => removeFile('checklist', idx)}
                      className="ml-2 text-red-400 hover:text-red-300"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Upload Button */}
        <div className="flex items-center justify-center">
          <button
            onClick={handleUploadAll}
            disabled={((appMode === 'upload' ? applicationFiles.length === 0 : folderApps.length === 0)) || (checklistMode === 'upload' ? checklistFiles.length === 0 : !selectedStoredChecklist) || uploading}
            className="bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 text-white px-8 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2"
          >
            {uploading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Uploading...</span>
              </>
            ) : (
              <>
                <Upload className="w-5 h-5" />
                <span>Upload All Documents</span>
              </>
            )}
          </button>
        </div>

        {/* Status Messages */}
        {status && (
          <div
            className={`mt-4 p-4 rounded-lg flex items-start space-x-3 ${
              status.type === 'success'
                ? 'bg-green-500/10 border border-green-500/20'
                : status.type === 'error'
                ? 'bg-red-500/10 border border-red-500/20'
                : 'bg-blue-500/10 border border-blue-500/20'
            }`}
          >
            {status.type === 'success' ? (
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
            ) : status.type === 'error' ? (
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            ) : (
              <Loader2 className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5 animate-spin" />
            )}
            <p
              className={`text-sm font-medium ${
                status.type === 'success'
                  ? 'text-green-400'
                  : status.type === 'error'
                  ? 'text-red-400'
                  : 'text-blue-400'
              }`}
            >
              {status.message}
            </p>
          </div>
        )}

        {/* Summary */}
        {(applicationFiles.length > 0 || folderApps.length > 0 || checklistFiles.length > 0 || selectedStoredChecklist) && (
          <div className="mt-4 p-4 bg-slate-900 rounded-lg border border-slate-600">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">
                {appMode === 'browse' ? folderApps.length : applicationFiles.length} application(s) • {checklistMode === 'stored' && selectedStoredChecklist ? `1 stored checklist (${selectedStoredChecklist.displayName})` : `${checklistFiles.length} checklist(s)`} selected
              </span>
              {uploadedDocs.applications.length > 0 && (
                <span className="text-green-400">
                  ✓ {uploadedDocs.applications.length + uploadedDocs.checklists.length} uploaded
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
