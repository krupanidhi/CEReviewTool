import { useState, useEffect } from 'react'
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Loader2,
  Download,
  ChevronDown,
  ChevronUp,
  Play,
  FileText,
  BarChart3,
  RefreshCw
} from 'lucide-react'
import { getQAQuestions, runQAComparison } from '../services/api'

export default function QAComparisonReport({ comparisonData }) {
  const [questions, setQuestions] = useState(null)
  const [results, setResults] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingQuestions, setLoadingQuestions] = useState(true)
  const [error, setError] = useState(null)
  const [expandedRows, setExpandedRows] = useState({})
  const [filter, setFilter] = useState('all') // all, agree, disagree, uncertain

  // Get application data from comparisonData
  const applications = comparisonData?.applications || []
  const applicationDoc = applications[0]
  const applicationData = applicationDoc?.analysis?.data || applicationDoc?.data

  // Load questions on mount
  useEffect(() => {
    loadQuestions()
  }, [])

  const loadQuestions = async () => {
    setLoadingQuestions(true)
    try {
      const data = await getQAQuestions()
      setQuestions(data.questions)
    } catch (err) {
      setError('Failed to load program-specific questions: ' + err.message)
    } finally {
      setLoadingQuestions(false)
    }
  }

  const runAnalysis = async () => {
    if (!applicationData) {
      setError('No application data available. Please run a comparison first.')
      return
    }

    setLoading(true)
    setError(null)
    setResults(null)
    setSummary(null)

    try {
      const data = await runQAComparison(applicationData)
      setResults(data.results)
      setSummary(data.summary)
    } catch (err) {
      setError('Analysis failed: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const toggleRow = (idx) => {
    setExpandedRows(prev => ({ ...prev, [idx]: !prev[idx] }))
  }

  const getMatchIcon = (match) => {
    if (match === 'agree') return <CheckCircle className="w-5 h-5 text-green-500" />
    if (match === 'disagree') return <XCircle className="w-5 h-5 text-red-500" />
    return <HelpCircle className="w-5 h-5 text-yellow-500" />
  }

  const getMatchBadge = (match) => {
    if (match === 'agree') return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">Agree</span>
    if (match === 'disagree') return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400">Disagree</span>
    return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-400">Uncertain</span>
  }

  const getConfidenceBadge = (confidence) => {
    if (confidence === 'high') return <span className="px-2 py-0.5 rounded-full text-xs bg-blue-500/20 text-blue-400">High</span>
    if (confidence === 'medium') return <span className="px-2 py-0.5 rounded-full text-xs bg-purple-500/20 text-purple-400">Medium</span>
    return <span className="px-2 py-0.5 rounded-full text-xs bg-gray-500/20 text-gray-400">Low</span>
  }

  const getAnswerColor = (answer) => {
    const a = (answer || '').toLowerCase()
    if (a === 'yes') return 'text-green-400'
    if (a === 'no') return 'text-red-400'
    if (a === 'n/a') return 'text-gray-400'
    return 'text-yellow-400'
  }

  const filteredResults = results
    ? results.filter(r => filter === 'all' || r.match === filter)
    : []

  const downloadReport = () => {
    if (!results || !summary) return
    const report = {
      generatedAt: new Date().toISOString(),
      application: applicationDoc?.originalName || applicationDoc?.name || 'Unknown',
      summary,
      results
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `qa_comparison_report_${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // Loading state
  if (loadingQuestions) {
    return (
      <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-3" />
        <p className="text-gray-400">Loading program-specific questions...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold text-white mb-2">Program-Specific Q&A Comparison</h2>
            <p className="text-sm text-gray-400">
              Compare AI-derived answers from the application against user-provided answers from the Completeness & Eligibility Checklist
            </p>
            {applicationDoc && (
              <div className="flex items-center space-x-2 mt-2 text-sm text-gray-500">
                <FileText className="w-4 h-4" />
                <span>Application: {applicationDoc.originalName || applicationDoc.name}</span>
              </div>
            )}
          </div>
          <div className="flex items-center space-x-3">
            {results && (
              <button
                onClick={downloadReport}
                className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                <Download className="w-4 h-4" />
                <span>Download Report</span>
              </button>
            )}
            <button
              onClick={runAnalysis}
              disabled={loading || !applicationData}
              className="flex items-center space-x-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Analyzing...</span>
                </>
              ) : results ? (
                <>
                  <RefreshCw className="w-4 h-4" />
                  <span>Re-Analyze</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  <span>Run AI Analysis</span>
                </>
              )}
            </button>
          </div>
        </div>

        {!applicationData && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-yellow-400 text-sm">
            <AlertTriangle className="w-4 h-4 inline mr-2" />
            Please run a document comparison first (Compare & Validate tab) to provide application evidence for analysis.
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-red-400 text-sm mt-3">
            <XCircle className="w-4 h-4 inline mr-2" />
            {error}
          </div>
        )}
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="text-3xl font-bold text-blue-400 mb-1">{summary.totalQuestions}</div>
            <div className="text-sm text-gray-400">Total Questions</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="text-3xl font-bold text-green-400 mb-1">{summary.matchCount}</div>
            <div className="text-sm text-gray-400">Agree</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="text-3xl font-bold text-red-400 mb-1">{summary.disagreeCount}</div>
            <div className="text-sm text-gray-400">Disagree</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className="text-3xl font-bold text-yellow-400 mb-1">{summary.uncertainCount}</div>
            <div className="text-sm text-gray-400">Uncertain</div>
          </div>
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <div className={`text-3xl font-bold mb-1 ${
              summary.agreementRate >= 80 ? 'text-green-400' :
              summary.agreementRate >= 50 ? 'text-yellow-400' : 'text-red-400'
            }`}>
              {summary.agreementRate}%
            </div>
            <div className="text-sm text-gray-400">Agreement Rate</div>
          </div>
        </div>
      )}

      {/* Questions Preview (before analysis) */}
      {!results && questions && questions.length > 0 && (
        <div className="bg-slate-800 rounded-lg border border-slate-700">
          <div className="px-6 py-4 border-b border-slate-700">
            <h3 className="text-lg font-semibold text-white">
              Program-Specific Questions ({questions.length})
            </h3>
            <p className="text-sm text-gray-400 mt-1">
              These questions and user-provided answers were extracted from the Completeness & Eligibility Checklist. Click "Run AI Analysis" to compare.
            </p>
          </div>
          <div className="divide-y divide-slate-700/50">
            {questions.map((q, idx) => (
              <div key={idx} className="px-6 py-3 flex items-start space-x-4">
                <span className="text-sm font-bold text-blue-400 w-8 flex-shrink-0">Q{q.number}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300">{q.question}</p>
                </div>
                <span className={`text-sm font-medium flex-shrink-0 ${getAnswerColor(q.userAnswer)}`}>
                  {q.userAnswer}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Loading Animation */}
      {loading && (
        <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700">
          <Loader2 className="w-10 h-10 text-purple-500 animate-spin mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">AI is analyzing the application...</h3>
          <p className="text-sm text-gray-400">
            Deriving answers to {questions?.length || 0} program-specific questions from application evidence
          </p>
        </div>
      )}

      {/* Results Table */}
      {results && results.length > 0 && (
        <div className="bg-slate-800 rounded-lg border border-slate-700">
          {/* Filter Bar */}
          <div className="px-6 py-3 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white flex items-center space-x-2">
              <BarChart3 className="w-5 h-5 text-purple-400" />
              <span>Comparison Results</span>
            </h3>
            <div className="flex items-center space-x-2">
              {['all', 'agree', 'disagree', 'uncertain'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    filter === f
                      ? f === 'agree' ? 'bg-green-500/30 text-green-400 ring-1 ring-green-500/50'
                        : f === 'disagree' ? 'bg-red-500/30 text-red-400 ring-1 ring-red-500/50'
                        : f === 'uncertain' ? 'bg-yellow-500/30 text-yellow-400 ring-1 ring-yellow-500/50'
                        : 'bg-blue-500/30 text-blue-400 ring-1 ring-blue-500/50'
                      : 'bg-slate-700 text-gray-400 hover:bg-slate-600'
                  }`}
                >
                  {f === 'all' ? `All (${results.length})` :
                   f === 'agree' ? `Agree (${results.filter(r => r.match === 'agree').length})` :
                   f === 'disagree' ? `Disagree (${results.filter(r => r.match === 'disagree').length})` :
                   `Uncertain (${results.filter(r => r.match === 'uncertain').length})`}
                </button>
              ))}
            </div>
          </div>

          {/* Table Header */}
          <div className="grid grid-cols-12 gap-2 px-6 py-3 bg-slate-900/50 text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-slate-700">
            <div className="col-span-1">#</div>
            <div className="col-span-4">Question</div>
            <div className="col-span-2 text-center">User Answer</div>
            <div className="col-span-2 text-center">AI Answer</div>
            <div className="col-span-1 text-center">Match</div>
            <div className="col-span-1 text-center">Confidence</div>
            <div className="col-span-1 text-center"></div>
          </div>

          {/* Table Rows */}
          <div className="divide-y divide-slate-700/50">
            {filteredResults.map((result, idx) => (
              <div key={idx}>
                <div
                  className={`grid grid-cols-12 gap-2 px-6 py-3 items-center cursor-pointer hover:bg-slate-700/30 transition-colors ${
                    result.match === 'disagree' ? 'bg-red-500/5' :
                    result.match === 'uncertain' ? 'bg-yellow-500/5' : ''
                  }`}
                  onClick={() => toggleRow(idx)}
                >
                  <div className="col-span-1 text-sm font-bold text-blue-400">Q{result.questionNumber}</div>
                  <div className="col-span-4 text-sm text-gray-300 truncate" title={result.question}>
                    {result.question}
                  </div>
                  <div className={`col-span-2 text-center text-sm font-semibold ${getAnswerColor(result.userAnswer)}`}>
                    {result.userAnswer}
                  </div>
                  <div className={`col-span-2 text-center text-sm font-semibold ${getAnswerColor(result.aiAnswer)}`}>
                    {result.aiAnswer}
                  </div>
                  <div className="col-span-1 flex justify-center">
                    {getMatchIcon(result.match)}
                  </div>
                  <div className="col-span-1 flex justify-center">
                    {getConfidenceBadge(result.confidence)}
                  </div>
                  <div className="col-span-1 flex justify-center">
                    {expandedRows[idx] ? (
                      <ChevronUp className="w-4 h-4 text-gray-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-500" />
                    )}
                  </div>
                </div>

                {/* Expanded Detail */}
                {expandedRows[idx] && (
                  <div className="px-6 pb-4 bg-slate-900/30 space-y-3">
                    <div className="grid grid-cols-2 gap-4 pt-2">
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                        <div className="flex items-center space-x-2 mb-2">
                          <FileText className="w-4 h-4 text-gray-400" />
                          <span className="text-xs font-medium text-gray-400 uppercase">Full Question</span>
                        </div>
                        <p className="text-sm text-gray-300">{result.question}</p>
                      </div>
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                        <div className="flex items-center space-x-2 mb-2">
                          <BarChart3 className="w-4 h-4 text-purple-400" />
                          <span className="text-xs font-medium text-gray-400 uppercase">Comparison</span>
                        </div>
                        <div className="flex items-center space-x-4 text-sm">
                          <div>
                            <span className="text-gray-500">User: </span>
                            <span className={`font-semibold ${getAnswerColor(result.userAnswer)}`}>{result.userAnswer}</span>
                          </div>
                          <span className="text-gray-600">vs</span>
                          <div>
                            <span className="text-gray-500">AI: </span>
                            <span className={`font-semibold ${getAnswerColor(result.aiAnswer)}`}>{result.aiAnswer}</span>
                          </div>
                          <div className="ml-auto">{getMatchBadge(result.match)}</div>
                        </div>
                      </div>
                    </div>

                    {result.evidence && (
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                        <span className="text-xs font-medium text-gray-400 uppercase block mb-2">AI Evidence</span>
                        <p className="text-sm text-gray-300">{result.evidence}</p>
                      </div>
                    )}

                    {result.reasoning && (
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700">
                        <span className="text-xs font-medium text-gray-400 uppercase block mb-2">AI Reasoning</span>
                        <p className="text-sm text-gray-300">{result.reasoning}</p>
                      </div>
                    )}

                    {result.pageReferences && result.pageReferences.length > 0 && (
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-gray-500">Page References:</span>
                        {result.pageReferences.map((p, i) => (
                          <span key={i} className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                            p.{p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
