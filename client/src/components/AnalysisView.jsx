import { useState } from 'react'
import { FileText, Brain, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import { analyzeDocument } from '../services/api'

export default function AnalysisView({ document }) {
  const [analyzing, setAnalyzing] = useState(false)
  const [aiAnalysis, setAiAnalysis] = useState(null)
  const [error, setError] = useState(null)

  if (!document) {
    return (
      <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700">
        <FileText className="w-16 h-16 text-gray-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-300 mb-2">No document selected</h3>
        <p className="text-gray-500">Select a document from the library to view analysis</p>
      </div>
    )
  }

  const handleAIAnalysis = async () => {
    setAnalyzing(true)
    setError(null)
    try {
      const analysisData = document.analysis?.data || document.data
      const result = await analyzeDocument(analysisData)
      setAiAnalysis(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setAnalyzing(false)
    }
  }

  const downloadJSON = () => {
    // Handle both upload response format and document retrieval format
    const analysisData = document.analysis?.data || document.data
    const dataStr = JSON.stringify(analysisData, null, 2)
    const dataBlob = new Blob([dataStr], { type: 'application/json' })
    const url = URL.createObjectURL(dataBlob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = `${document.originalName || 'document'}_analysis.json`
    window.document.body.appendChild(link)
    link.click()
    window.document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const extractedData = document.analysis?.data || document.data

  return (
    <div className="space-y-6">
      {/* Document Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-start justify-between">
          <div className="flex items-start space-x-4">
            <div className="bg-blue-500/10 p-3 rounded-lg">
              <FileText className="w-8 h-8 text-blue-500" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white">{document.originalName}</h2>
              <div className="flex items-center space-x-4 mt-2 text-sm text-gray-400">
                <span>Uploaded: {new Date(document.uploadedAt).toLocaleString()}</span>
                <span>•</span>
                <span>Size: {(document.size / 1024).toFixed(2)} KB</span>
              </div>
            </div>
          </div>
          <button
            onClick={downloadJSON}
            className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>Download JSON</span>
          </button>
        </div>
      </div>

      {/* AI Analysis Section */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="bg-purple-500/10 p-2 rounded-lg">
              <Brain className="w-6 h-6 text-purple-500" />
            </div>
            <h3 className="text-xl font-semibold text-white">AI-Powered Analysis</h3>
          </div>
          <button
            onClick={handleAIAnalysis}
            disabled={analyzing}
            className="flex items-center space-x-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            {analyzing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Analyzing...</span>
              </>
            ) : (
              <>
                <Brain className="w-4 h-4" />
                <span>Run AI Analysis</span>
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start space-x-3 mb-4">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {aiAnalysis && (
          <div className="bg-slate-900 rounded-lg p-6 border border-slate-600">
            <div className="flex items-center space-x-2 mb-4">
              <CheckCircle className="w-5 h-5 text-green-500" />
              <span className="text-sm text-green-400 font-medium">Analysis Complete</span>
            </div>
            <div className="prose prose-invert max-w-none">
              <pre className="bg-slate-800 p-4 rounded-lg overflow-x-auto text-sm text-gray-300 whitespace-pre-wrap">
                {aiAnalysis.analysis}
              </pre>
            </div>
            {aiAnalysis.usage && (
              <div className="mt-4 pt-4 border-t border-slate-700 text-xs text-gray-500">
                Tokens used: {aiAnalysis.usage.totalTokens} (Prompt: {aiAnalysis.usage.promptTokens}, Completion: {aiAnalysis.usage.completionTokens})
              </div>
            )}
          </div>
        )}
      </div>

      {/* Extracted Content */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h3 className="text-xl font-semibold text-white mb-4">Extracted Content</h3>
        
        {extractedData?.content && (
          <div className="mb-6">
            <h4 className="text-sm font-medium text-gray-400 mb-2">Full Text Content</h4>
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-600 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{extractedData.content}</p>
            </div>
          </div>
        )}

        {extractedData?.tableOfContents && extractedData.tableOfContents.length > 0 && (
          <div className="mb-6">
            <h4 className="text-sm font-medium text-gray-400 mb-2">Table of Contents</h4>
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-600 max-h-96 overflow-y-auto">
              <div className="space-y-2">
                {extractedData.tableOfContents.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between text-sm">
                    <span className="text-gray-300">{item.title}</span>
                    <span className="text-blue-400">Page {item.pageNumber}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {extractedData?.sections && extractedData.sections.length > 0 && (
          <div className="mb-6">
            <h4 className="text-sm font-medium text-gray-400 mb-2">Document Sections ({extractedData.sections.length})</h4>
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
              <div className="text-sm text-gray-400">
                Document organized into {extractedData.sections.length} sections with accurate page references
              </div>
            </div>
          </div>
        )}

        {extractedData?.keyValuePairs && extractedData.keyValuePairs.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-400 mb-2">Metadata ({extractedData.keyValuePairs.length} key-value pairs cached)</h4>
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
              <div className="text-sm text-gray-400">
                {extractedData.keyValuePairs.length} key-value pairs extracted and cached for internal reference
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Raw JSON Data */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h3 className="text-xl font-semibold text-white mb-4">Raw JSON Data</h3>
        <div className="bg-slate-900 rounded-lg p-4 border border-slate-600 max-h-96 overflow-y-auto">
          <pre className="text-xs text-gray-400 whitespace-pre-wrap">
            {JSON.stringify(extractedData, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  )
}
