import { useState, useRef, useEffect } from 'react'
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, GitCompare, X, Plus } from 'lucide-react'
import { uploadDocument, getSettings } from '../services/api'

export default function EnhancedComparisonUpload({ onDocumentsUploaded }) {
  const [applicationFiles, setApplicationFiles] = useState([])
  const [checklistFiles, setChecklistFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState(null)
  const [uploadedDocs, setUploadedDocs] = useState({ applications: [], checklists: [] })
  const [settings, setSettings] = useState({ multipleApplications: false, multipleChecklists: true })
  
  const applicationInputRef = useRef(null)
  const checklistInputRef = useRef(null)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const result = await getSettings()
      setSettings(result.settings)
    } catch (error) {
      console.error('Failed to load settings:', error)
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

  const handleUploadAll = async () => {
    if (applicationFiles.length === 0 || checklistFiles.length === 0) {
      setStatus({ type: 'error', message: 'Please select at least one application and one checklist file' })
      return
    }

    setUploading(true)
    setStatus(null)

    try {
      const applications = []
      const checklists = []

      setStatus({ type: 'info', message: `Uploading ${applicationFiles.length} application(s)...` })
      for (const file of applicationFiles) {
        const result = await uploadDocument(file)
        applications.push(result)
      }

      setStatus({ type: 'info', message: `Uploading ${checklistFiles.length} checklist(s)...` })
      for (const file of checklistFiles) {
        const result = await uploadDocument(file)
        checklists.push(result)
      }

      setUploadedDocs({ applications, checklists })
      setStatus({ type: 'success', message: 'All documents uploaded successfully! Ready to proceed.' })
      
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
          {/* Application Upload */}
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

            {applicationFiles.length > 0 && (
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

          {/* Checklist Upload */}
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
              </div>
              <button
                onClick={() => checklistInputRef.current?.click()}
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2 mx-auto"
              >
                <Plus className="w-4 h-4" />
                <span>Add Checklist{settings.multipleChecklists ? 's' : ''}</span>
              </button>
            </div>

            {checklistFiles.length > 0 && (
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
            disabled={applicationFiles.length === 0 || checklistFiles.length === 0 || uploading}
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
        {(applicationFiles.length > 0 || checklistFiles.length > 0) && (
          <div className="mt-4 p-4 bg-slate-900 rounded-lg border border-slate-600">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">
                {applicationFiles.length} application(s) • {checklistFiles.length} checklist(s) selected
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
