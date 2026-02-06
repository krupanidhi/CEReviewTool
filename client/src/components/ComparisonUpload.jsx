import { useState, useRef } from 'react'
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, GitCompare } from 'lucide-react'
import { uploadDocument, compareDocuments } from '../services/api'

export default function ComparisonUpload({ onComparisonComplete }) {
  const [applicationFile, setApplicationFile] = useState(null)
  const [checklistFile, setChecklistFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [status, setStatus] = useState(null)
  const [uploadedDocs, setUploadedDocs] = useState({ application: null, checklist: null })
  
  const applicationInputRef = useRef(null)
  const checklistInputRef = useRef(null)

  const handleFileSelect = (type, file) => {
    if (type === 'application') {
      setApplicationFile(file)
    } else {
      setChecklistFile(file)
    }
    setStatus(null)
  }

  const handleUploadBoth = async () => {
    if (!applicationFile || !checklistFile) {
      setStatus({ type: 'error', message: 'Please select both application and checklist files' })
      return
    }

    setUploading(true)
    setStatus(null)

    try {
      // Upload application
      setStatus({ type: 'info', message: 'Uploading application document...' })
      const appResult = await uploadDocument(applicationFile)
      
      // Upload checklist
      setStatus({ type: 'info', message: 'Uploading checklist document...' })
      const checklistResult = await uploadDocument(checklistFile)

      setUploadedDocs({
        application: appResult,
        checklist: checklistResult
      })

      setStatus({ type: 'success', message: 'Both documents uploaded successfully! Ready to compare.' })
    } catch (error) {
      setStatus({ 
        type: 'error', 
        message: `Upload failed: ${error.message}` 
      })
    } finally {
      setUploading(false)
    }
  }

  const handleCompare = async () => {
    if (!uploadedDocs.application || !uploadedDocs.checklist) {
      setStatus({ type: 'error', message: 'Please upload both documents first' })
      return
    }

    setComparing(true)
    setStatus({ type: 'info', message: 'Comparing documents... This may take a minute.' })

    try {
      const applicationData = uploadedDocs.application.analysis?.data || uploadedDocs.application.data
      const checklistData = uploadedDocs.checklist.analysis?.data || uploadedDocs.checklist.data

      const result = await compareDocuments(applicationData, checklistData)
      
      setStatus({ type: 'success', message: 'Comparison complete!' })
      
      if (onComparisonComplete) {
        onComparisonComplete({
          ...result,
          applicationDoc: uploadedDocs.application,
          checklistDoc: uploadedDocs.checklist
        })
      }
    } catch (error) {
      setStatus({ 
        type: 'error', 
        message: `Comparison failed: ${error.message}` 
      })
    } finally {
      setComparing(false)
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
        <div className="flex items-center space-x-3 mb-4">
          <div className="bg-blue-500/10 p-2 rounded-lg">
            <GitCompare className="w-6 h-6 text-blue-500" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">Compare Application vs Checklist</h2>
            <p className="text-sm text-gray-400">
              Upload both documents to validate compliance and generate a detailed report
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* Application Upload */}
          <div className="border-2 border-dashed border-slate-600 rounded-lg p-6">
            <input
              ref={applicationInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.bmp"
              onChange={(e) => handleFileSelect('application', e.target.files[0])}
            />
            
            <div className="text-center">
              <FileText className={`w-12 h-12 mx-auto mb-3 ${applicationFile ? 'text-blue-500' : 'text-gray-500'}`} />
              <h3 className="text-lg font-medium text-white mb-2">Application Document</h3>
              
              {applicationFile ? (
                <div className="space-y-2">
                  <p className="text-sm text-gray-300 truncate">{applicationFile.name}</p>
                  <p className="text-xs text-gray-500">{formatFileSize(applicationFile.size)}</p>
                  <button
                    onClick={() => applicationInputRef.current?.click()}
                    className="text-sm text-blue-400 hover:text-blue-300"
                  >
                    Change file
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => applicationInputRef.current?.click()}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  Select Application
                </button>
              )}
            </div>
          </div>

          {/* Checklist Upload */}
          <div className="border-2 border-dashed border-slate-600 rounded-lg p-6">
            <input
              ref={checklistInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.bmp"
              onChange={(e) => handleFileSelect('checklist', e.target.files[0])}
            />
            
            <div className="text-center">
              <FileText className={`w-12 h-12 mx-auto mb-3 ${checklistFile ? 'text-green-500' : 'text-gray-500'}`} />
              <h3 className="text-lg font-medium text-white mb-2">Checklist/Guide</h3>
              
              {checklistFile ? (
                <div className="space-y-2">
                  <p className="text-sm text-gray-300 truncate">{checklistFile.name}</p>
                  <p className="text-xs text-gray-500">{formatFileSize(checklistFile.size)}</p>
                  <button
                    onClick={() => checklistInputRef.current?.click()}
                    className="text-sm text-green-400 hover:text-green-300"
                  >
                    Change file
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => checklistInputRef.current?.click()}
                  className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  Select Checklist
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-center space-x-4">
          {!uploadedDocs.application || !uploadedDocs.checklist ? (
            <button
              onClick={handleUploadBoth}
              disabled={!applicationFile || !checklistFile || uploading}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white px-8 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Uploading...</span>
                </>
              ) : (
                <>
                  <Upload className="w-5 h-5" />
                  <span>Upload Both Documents</span>
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleCompare}
              disabled={comparing}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 text-white px-8 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2"
            >
              {comparing ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Comparing...</span>
                </>
              ) : (
                <>
                  <GitCompare className="w-5 h-5" />
                  <span>Compare & Validate</span>
                </>
              )}
            </button>
          )}
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
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center space-x-3 mb-2">
            <div className="bg-blue-500/10 p-2 rounded-lg">
              <Upload className="w-5 h-5 text-blue-500" />
            </div>
            <h3 className="font-medium text-white">Step 1: Upload</h3>
          </div>
          <p className="text-sm text-gray-400">
            Upload both the application and checklist/guide documents
          </p>
        </div>

        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center space-x-3 mb-2">
            <div className="bg-purple-500/10 p-2 rounded-lg">
              <GitCompare className="w-5 h-5 text-purple-500" />
            </div>
            <h3 className="font-medium text-white">Step 2: Compare</h3>
          </div>
          <p className="text-sm text-gray-400">
            AI analyzes both documents and validates compliance
          </p>
        </div>

        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center space-x-3 mb-2">
            <div className="bg-green-500/10 p-2 rounded-lg">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <h3 className="font-medium text-white">Step 3: Report</h3>
          </div>
          <p className="text-sm text-gray-400">
            Get detailed compliance report with page references
          </p>
        </div>
      </div>
    </div>
  )
}
