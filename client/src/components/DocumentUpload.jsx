import { useState, useRef } from 'react'
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, Download } from 'lucide-react'
import { uploadDocument, downloadStructuredJSON } from '../services/api'

export default function DocumentUpload({ onUploadSuccess }) {
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [lastUploadResult, setLastUploadResult] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const fileInputRef = useRef(null)

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0])
      setUploadStatus(null)
    }
  }

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0])
      setUploadStatus(null)
    }
  }

  const handleUpload = async () => {
    if (!file) return

    setUploading(true)
    setUploadStatus(null)
    setLastUploadResult(null)

    try {
      const result = await uploadDocument(file)
      setUploadStatus({ type: 'success', message: 'Document uploaded and analyzed successfully!' })
      setLastUploadResult(result)
      setFile(null)
      
      if (onUploadSuccess) {
        onUploadSuccess(result)
      }
    } catch (error) {
      setUploadStatus({ 
        type: 'error', 
        message: error.message || 'Failed to upload document. Please try again.' 
      })
    } finally {
      setUploading(false)
    }
  }

  const handleDownloadJSON = async () => {
    if (!lastUploadResult?.id) return
    
    setDownloading(true)
    try {
      // Try to use the structuredData already in the upload result
      let jsonData = lastUploadResult.structuredData
      
      // If not available, fetch from the server
      if (!jsonData) {
        jsonData = await downloadStructuredJSON(lastUploadResult.id)
      }
      
      // Create and trigger download
      const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${lastUploadResult.originalName?.replace(/\.[^.]+$/, '') || 'document'}_structured.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      setUploadStatus({ 
        type: 'error', 
        message: error.message || 'Failed to download structured JSON.' 
      })
    } finally {
      setDownloading(false)
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
        <h2 className="text-xl font-semibold text-white mb-4">Upload Document for Analysis</h2>
        <p className="text-gray-400 mb-6">
          Upload a CE review document (PDF, Word, or image) for automatic extraction and validation.
        </p>

        {/* Drag and Drop Area */}
        <div
          className={`relative border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
            dragActive
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-slate-600 hover:border-slate-500'
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.tiff,.bmp"
            onChange={handleFileChange}
          />

          {!file ? (
            <div className="space-y-4">
              <div className="flex justify-center">
                <Upload className="w-16 h-16 text-gray-500" />
              </div>
              <div>
                <p className="text-lg text-gray-300 mb-2">
                  Drag and drop your document here
                </p>
                <p className="text-sm text-gray-500 mb-4">or</p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Browse Files
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Supported formats: PDF, Word, JPEG, PNG, TIFF, BMP (Max 50MB)
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center">
                <FileText className="w-16 h-16 text-blue-500" />
              </div>
              <div>
                <p className="text-lg text-white font-medium">{file.name}</p>
                <p className="text-sm text-gray-400">{formatFileSize(file.size)}</p>
              </div>
              <div className="flex justify-center space-x-3">
                <button
                  onClick={handleUpload}
                  disabled={uploading}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white px-6 py-2 rounded-lg font-medium transition-colors flex items-center space-x-2"
                >
                  {uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Processing...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      <span>Upload & Analyze</span>
                    </>
                  )}
                </button>
                <button
                  onClick={() => {
                    setFile(null)
                    setUploadStatus(null)
                  }}
                  disabled={uploading}
                  className="bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 text-white px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Upload Status */}
        {uploadStatus && (
          <div
            className={`mt-4 p-4 rounded-lg flex items-start space-x-3 ${
              uploadStatus.type === 'success'
                ? 'bg-green-500/10 border border-green-500/20'
                : 'bg-red-500/10 border border-red-500/20'
            }`}
          >
            {uploadStatus.type === 'success' ? (
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              <p
                className={`text-sm font-medium ${
                  uploadStatus.type === 'success' ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {uploadStatus.message}
              </p>
              {uploadStatus.type === 'success' && lastUploadResult?.id && (
                <button
                  onClick={handleDownloadJSON}
                  disabled={downloading}
                  className="mt-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center space-x-2"
                >
                  {downloading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Generating...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      <span>Download Structured JSON</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Information Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center space-x-3 mb-2">
            <div className="bg-blue-500/10 p-2 rounded-lg">
              <FileText className="w-5 h-5 text-blue-500" />
            </div>
            <h3 className="font-medium text-white">Document Intelligence</h3>
          </div>
          <p className="text-sm text-gray-400">
            Automatic text extraction and structure recognition using Azure AI
          </p>
        </div>

        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center space-x-3 mb-2">
            <div className="bg-green-500/10 p-2 rounded-lg">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <h3 className="font-medium text-white">AI Validation</h3>
          </div>
          <p className="text-sm text-gray-400">
            Intelligent validation against CE review standards with Azure OpenAI
          </p>
        </div>

        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <div className="flex items-center space-x-3 mb-2">
            <div className="bg-purple-500/10 p-2 rounded-lg">
              <Upload className="w-5 h-5 text-purple-500" />
            </div>
            <h3 className="font-medium text-white">JSON Output</h3>
          </div>
          <p className="text-sm text-gray-400">
            Structured JSON extraction for integration with other systems
          </p>
        </div>
      </div>
    </div>
  )
}
