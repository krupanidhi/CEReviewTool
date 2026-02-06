import { useState, useEffect } from 'react'
import Dashboard from './components/Dashboard'
import DocumentUpload from './components/DocumentUpload'
import ChatInterface from './components/ChatInterface'
import ComparisonWorkflow from './components/ComparisonWorkflow'
import CategorizedComplianceReport from './components/CategorizedComplianceReport'
import Settings from './components/Settings'
import { FileText, MessageSquare, GitCompare, Settings as SettingsIcon, LayoutDashboard, Upload } from 'lucide-react'

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [comparisonResult, setComparisonResult] = useState(null)
  const [cachedUploadedDocs, setCachedUploadedDocs] = useState(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDocuments, setChatDocuments] = useState({ application: null, checklist: null })
  const [chatWidth, setChatWidth] = useState(384) // 96 * 4 = 384px (w-96)
  const [isResizing, setIsResizing] = useState(false)

  const handleDocumentUpload = (doc) => {
    setSelectedDocument(doc)
  }

  const handleComparisonComplete = (result) => {
    setComparisonResult(result)
    setActiveTab('report')
  }

  const handleViewResultsFromDashboard = (app) => {
    setComparisonResult(app.data)
    setActiveTab('report')
  }

  const handleDocumentsUploaded = (docs) => {
    setCachedUploadedDocs(docs)
    // Set documents for chat context
    if (docs.applications && docs.applications.length > 0) {
      setChatDocuments({
        application: docs.applications[0],
        checklist: docs.checklists && docs.checklists.length > 0 ? docs.checklists[0] : null
      })
    }
  }

  const handleMouseDown = (e) => {
    setIsResizing(true)
    e.preventDefault()
  }

  const handleMouseMove = (e) => {
    if (!isResizing) return
    
    const newWidth = window.innerWidth - e.clientX
    // Min width: 320px, Max width: 80% of screen
    const minWidth = 320
    const maxWidth = window.innerWidth * 0.8
    
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      setChatWidth(newWidth)
    }
  }

  const handleMouseUp = () => {
    setIsResizing(false)
  }

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isResizing])

  return (
    <div className="min-h-screen bg-slate-900 text-gray-100">
      {/* Header */}
      <header className="bg-slate-800 border-b border-slate-700 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="bg-blue-600 p-2 rounded-lg">
                <FileText className="w-8 h-8 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">
                  CE Review Check List Validator
                </h1>
                <p className="text-sm text-gray-400">
                  Azure Document Intelligence & AI-Powered Validation
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <div className="flex items-center space-x-2 bg-slate-700 px-3 py-1.5 rounded-lg">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <span className="text-xs text-gray-300">Connected</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <div className="bg-slate-800 border-b border-slate-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <nav className="flex space-x-8">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex items-center space-x-2 px-4 py-4 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'dashboard'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              <span>Dashboard</span>
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex items-center space-x-2 px-4 py-4 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'upload'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              <Upload className="w-4 h-4" />
              <span>Upload Document</span>
            </button>
            <button
              onClick={() => setActiveTab('compare')}
              className={`flex items-center space-x-2 px-4 py-4 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'compare'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              <GitCompare className="w-4 h-4" />
              <span>Compare & Validate</span>
            </button>
            {comparisonResult && (
              <button
                onClick={() => setActiveTab('report')}
                className={`flex items-center space-x-2 px-4 py-4 border-b-2 font-medium text-sm transition-colors ${
                  activeTab === 'report'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
                }`}
              >
                <FileText className="w-4 h-4" />
                <span>Compliance Report</span>
              </button>
            )}
            <button
              onClick={() => setActiveTab('settings')}
              className={`flex items-center space-x-2 px-4 py-4 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'settings'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              <SettingsIcon className="w-4 h-4" />
              <span>Settings</span>
            </button>
          </nav>
        </div>
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'dashboard' && (
          <Dashboard onViewResults={handleViewResultsFromDashboard} />
        )}
        {activeTab === 'upload' && (
          <DocumentUpload onUploadSuccess={handleDocumentUpload} />
        )}
        {activeTab === 'compare' && (
          <ComparisonWorkflow 
            onComparisonComplete={handleComparisonComplete}
            cachedDocs={cachedUploadedDocs}
            onDocumentsUploaded={handleDocumentsUploaded}
          />
        )}
        {activeTab === 'report' && (
          <CategorizedComplianceReport comparisonData={comparisonResult} />
        )}
        {activeTab === 'settings' && (
          <Settings />
        )}
      </main>

      {/* Floating Chat Icon */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed bottom-6 right-6 bg-purple-600 hover:bg-purple-700 text-white p-4 rounded-full shadow-lg transition-all hover:scale-110 z-50"
          title="Chat with AI"
        >
          <MessageSquare className="w-6 h-6" />
        </button>
      )}

      {/* Slide-out Chat Panel */}
      {chatOpen && (
        <div 
          className="fixed inset-y-0 right-0 bg-slate-900 border-l border-slate-700 shadow-2xl z-50 flex flex-col"
          style={{ width: `${chatWidth}px` }}
        >
          {/* Resize Handle */}
          <div
            className={`absolute left-0 top-0 bottom-0 w-1 hover:w-2 bg-slate-600 hover:bg-purple-500 cursor-col-resize transition-all ${
              isResizing ? 'w-2 bg-purple-500' : ''
            }`}
            onMouseDown={handleMouseDown}
            title="Drag to resize"
          >
            <div className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 w-1 h-12 bg-slate-400 rounded-full opacity-50"></div>
          </div>
          
          <div className="flex items-center justify-between p-4 border-b border-slate-700 bg-slate-800">
            <div className="flex items-center space-x-2">
              <MessageSquare className="w-5 h-5 text-purple-500" />
              <h3 className="text-lg font-semibold text-white">Chat with AI</h3>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
              title="Close chat"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <ChatInterface 
              document={selectedDocument}
              applicationDoc={chatDocuments.application}
              checklistDoc={chatDocuments.checklist}
            />
          </div>
        </div>
      )}

      {/* Overlay when chat is open */}
      {chatOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setChatOpen(false)}
        />
      )}

      {/* Footer */}
      <footer className="bg-slate-800 border-t border-slate-700 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between text-sm text-gray-400">
            <p>© 2026 CE Review Tool. Powered by Azure AI.</p>
            <div className="flex items-center space-x-4">
              <span>Azure Document Intelligence</span>
              <span>•</span>
              <span>Azure OpenAI</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
