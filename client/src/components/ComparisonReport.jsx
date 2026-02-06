import { useState } from 'react'
import { CheckCircle, XCircle, AlertTriangle, FileText, Download, ChevronDown, ChevronUp } from 'lucide-react'

export default function ComparisonReport({ comparisonData }) {
  const [expandedSections, setExpandedSections] = useState({})

  if (!comparisonData?.comparison) {
    return (
      <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700">
        <FileText className="w-16 h-16 text-gray-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-300 mb-2">No comparison results</h3>
        <p className="text-gray-500">Upload and compare documents to see the compliance report</p>
      </div>
    )
  }

  const { comparison, applicationDoc, checklistDoc } = comparisonData
  const sections = comparison.sections || []

  const toggleSection = (index) => {
    setExpandedSections(prev => ({
      ...prev,
      [index]: !prev[index]
    }))
  }

  const downloadReport = () => {
    const reportData = {
      generatedAt: new Date().toISOString(),
      applicationDocument: applicationDoc?.originalName,
      checklistDocument: checklistDoc?.originalName,
      overallCompliance: comparison.overallCompliance,
      summary: comparison.summary,
      sections: sections,
      criticalIssues: comparison.criticalIssues,
      recommendations: comparison.recommendations
    }

    const dataStr = JSON.stringify(reportData, null, 2)
    const dataBlob = new Blob([dataStr], { type: 'application/json' })
    const url = URL.createObjectURL(dataBlob)
    const link = window.document.createElement('a')
    link.href = url
    link.download = `compliance_report_${new Date().toISOString().split('T')[0]}.json`
    window.document.body.appendChild(link)
    link.click()
    window.document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'met':
        return <CheckCircle className="w-5 h-5 text-green-500" />
      case 'partial':
        return <AlertTriangle className="w-5 h-5 text-yellow-500" />
      case 'not_met':
        return <XCircle className="w-5 h-5 text-red-500" />
      default:
        return <AlertTriangle className="w-5 h-5 text-gray-500" />
    }
  }

  const getStatusColor = (status) => {
    switch (status) {
      case 'met':
        return 'bg-green-500/10 border-green-500/20 text-green-400'
      case 'partial':
        return 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400'
      case 'not_met':
        return 'bg-red-500/10 border-red-500/20 text-red-400'
      default:
        return 'bg-gray-500/10 border-gray-500/20 text-gray-400'
    }
  }

  const metCount = sections.filter(s => s.status === 'met').length
  const partialCount = sections.filter(s => s.status === 'partial').length
  const notMetCount = sections.filter(s => s.status === 'not_met').length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold text-white mb-2">Compliance Report</h2>
            <div className="flex items-center space-x-4 text-sm text-gray-400">
              <span>Application: {applicationDoc?.originalName}</span>
              <span>•</span>
              <span>Checklist: {checklistDoc?.originalName}</span>
            </div>
          </div>
          <button
            onClick={downloadReport}
            className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>Download Report</span>
          </button>
        </div>

        {/* Overall Compliance */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-3xl font-bold text-blue-400 mb-1">
              {comparison.overallCompliance}%
            </div>
            <div className="text-sm text-gray-400">Overall Compliance</div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-3xl font-bold text-green-400 mb-1">{metCount}</div>
            <div className="text-sm text-gray-400">Requirements Met</div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-3xl font-bold text-yellow-400 mb-1">{partialCount}</div>
            <div className="text-sm text-gray-400">Partially Met</div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-3xl font-bold text-red-400 mb-1">{notMetCount}</div>
            <div className="text-sm text-gray-400">Not Met</div>
          </div>
        </div>

        {/* Summary */}
        {comparison.summary && (
          <div className="mt-6 p-4 bg-slate-900 rounded-lg border border-slate-600">
            <h3 className="text-sm font-medium text-gray-400 mb-2">Executive Summary</h3>
            <p className="text-gray-300">{comparison.summary}</p>
          </div>
        )}
      </div>

      {/* Critical Issues */}
      {comparison.criticalIssues && comparison.criticalIssues.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6">
          <div className="flex items-center space-x-3 mb-4">
            <XCircle className="w-6 h-6 text-red-500" />
            <h3 className="text-lg font-semibold text-red-400">Critical Issues</h3>
          </div>
          <ul className="space-y-2">
            {comparison.criticalIssues.map((issue, idx) => (
              <li key={idx} className="flex items-start space-x-2 text-sm text-red-300">
                <span className="text-red-500 mt-1">•</span>
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Section-by-Section Results */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h3 className="text-xl font-semibold text-white mb-4">Detailed Section Analysis</h3>
        <div className="space-y-3">
          {sections.map((section, idx) => (
            <div
              key={idx}
              className={`border rounded-lg overflow-hidden ${getStatusColor(section.status)}`}
            >
              <button
                onClick={() => toggleSection(idx)}
                className="w-full p-4 flex items-center justify-between hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center space-x-3 flex-1 text-left">
                  {getStatusIcon(section.status)}
                  <div className="flex-1">
                    <div className="font-medium">{section.checklistSection || `Section ${idx + 1}`}</div>
                    <div className="text-sm opacity-80 mt-1">{section.requirement}</div>
                  </div>
                </div>
                {expandedSections[idx] ? (
                  <ChevronUp className="w-5 h-5" />
                ) : (
                  <ChevronDown className="w-5 h-5" />
                )}
              </button>

              {expandedSections[idx] && (
                <div className="p-4 border-t border-white/10 bg-slate-900/50 space-y-4">
                  {/* Application Section */}
                  {section.applicationSection && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Application Section</h4>
                      <p className="text-sm text-gray-300">{section.applicationSection}</p>
                    </div>
                  )}

                  {/* Page References */}
                  {section.pageReferences && section.pageReferences.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Page References</h4>
                      <div className="flex flex-wrap gap-2">
                        {section.pageReferences.map((page, pageIdx) => (
                          <span
                            key={pageIdx}
                            className="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded border border-blue-500/30"
                          >
                            {page}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Evidence */}
                  {section.evidence && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Evidence from Application</h4>
                      <div className="bg-slate-800 p-3 rounded border border-slate-600">
                        <p className="text-sm text-gray-300 italic">"{section.evidence}"</p>
                      </div>
                    </div>
                  )}

                  {/* Explanation */}
                  {section.explanation && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Analysis</h4>
                      <p className="text-sm text-gray-300">{section.explanation}</p>
                    </div>
                  )}

                  {/* Recommendation */}
                  {section.recommendation && section.status !== 'met' && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-400 mb-1">Recommendation</h4>
                      <div className="bg-yellow-500/10 p-3 rounded border border-yellow-500/20">
                        <p className="text-sm text-yellow-300">{section.recommendation}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Overall Recommendations */}
      {comparison.recommendations && comparison.recommendations.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
          <h3 className="text-lg font-semibold text-white mb-4">Overall Recommendations</h3>
          <ul className="space-y-3">
            {comparison.recommendations.map((rec, idx) => (
              <li key={idx} className="flex items-start space-x-3">
                <div className="bg-blue-500/10 p-1 rounded mt-0.5">
                  <CheckCircle className="w-4 h-4 text-blue-400" />
                </div>
                <p className="text-sm text-gray-300 flex-1">{rec}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
