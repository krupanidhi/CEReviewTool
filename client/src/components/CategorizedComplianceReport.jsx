import { useState, useMemo } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Download, ChevronDown, ChevronUp, ExternalLink, FileText, MinusCircle } from 'lucide-react'

export default function CategorizedComplianceReport({ comparisonData, onOpenPageViewer }) {
  const [expandedSections, setExpandedSections] = useState({})
  const [activeMainSection, setActiveMainSection] = useState(null)

  if (!comparisonData?.results || comparisonData.results.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700">
        <AlertTriangle className="w-16 h-16 text-gray-600 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-300 mb-2">No comparison results</h3>
        <p className="text-gray-500">Complete the comparison workflow to see validation results</p>
      </div>
    )
  }

  const { results, applications, checklists, selectedSections = [] } = comparisonData
  const primaryResult = results[0]
  const comparison = primaryResult.comparison
  const sections = comparison.sections || []

  // Categorize sections by meaningful subsection (3.1, 3.2, 3.3, etc.)
  // Exclude main section headers (e.g., "3.") which are just organizational
  // Also group critical issues by section
  const categorizedSections = useMemo(() => {
    const categories = {}
    
    sections.forEach((section, idx) => {
      const sectionTitle = section.checklistSection || `Section ${idx + 1}`
      
      // Extract section number pattern — try multiple formats
      const match = sectionTitle.match(/^(\d+(?:\.\d+)*)/)
      
      let mainSection
      if (match) {
        const sectionNumber = match[1]
        const parts = sectionNumber.split('.')
        
        // Group by first two levels (e.g., "3.1", "3.2", "3.3")
        // For single-number sections (e.g., "4 Submission"), group under X.0
        if (parts.length === 1) {
          mainSection = `${parts[0]}.0`
        } else {
          mainSection = `${parts[0]}.${parts[1]}`
        }
      } else {
        // No number prefix — try to extract from section title keywords
        // or group under 'other' so nothing is silently dropped
        const numInTitle = sectionTitle.match(/Section\s+(\d+)/i)
        if (numInTitle) {
          mainSection = `${numInTitle[1]}.0`
        } else {
          mainSection = '0.0'
        }
        console.warn(`⚠️ Section "${sectionTitle}" has no standard number prefix, grouped under ${mainSection}`)
      }
      
      if (!categories[mainSection]) {
        categories[mainSection] = {
          title: mainSection,
          sections: [],
          metCount: 0,
          partialCount: 0,
          notMetCount: 0,
          naCount: 0,
          criticalIssues: [],
          recommendations: []
        }
      }
      
      categories[mainSection].sections.push({ ...section, originalIndex: idx })
      
      // Update counts
      if (section.status === 'met') categories[mainSection].metCount++
      else if (section.status === 'partial') categories[mainSection].partialCount++
      else if (section.status === 'not_met') categories[mainSection].notMetCount++
      else if (section.status === 'not_applicable') categories[mainSection].naCount++
    })
    
    // Group critical issues by section
    if (comparison.criticalIssues && comparison.criticalIssues.length > 0) {
      comparison.criticalIssues.forEach(issue => {
        // Try to extract section number from critical issue text
        const issueMatch = issue.match(/Form\s+(\d+[A-Z]?)|section\s+(\d+\.\d+)/i)
        if (issueMatch) {
          const formNum = issueMatch[1]
          const sectionNum = issueMatch[2]
          
          // Map form numbers to sections (Form 1C -> 3.1, Form 3 -> 3.2, etc.)
          let targetSection = null
          if (formNum) {
            if (formNum.startsWith('1')) targetSection = '3.1'
            else if (formNum.startsWith('2')) targetSection = '3.2'
            else if (formNum.startsWith('3')) targetSection = '3.2'
            else if (formNum.startsWith('5')) targetSection = '3.3'
            else if (formNum.startsWith('6')) targetSection = '3.4'
          } else if (sectionNum) {
            const parts = sectionNum.split('.')
            targetSection = `${parts[0]}.${parts[1]}`
          }
          
          if (targetSection && categories[targetSection]) {
            categories[targetSection].criticalIssues.push(issue)
          }
        }
      })
    }
    
    // Group overall recommendations by section
    if (comparison.recommendations && comparison.recommendations.length > 0) {
      comparison.recommendations.forEach(rec => {
        // Try to extract section number from recommendation text
        const recMatch = rec.match(/Form\s+(\d+[A-Z]?)|section\s+(\d+\.\d+)/i)
        if (recMatch) {
          const formNum = recMatch[1]
          const sectionNum = recMatch[2]
          
          // Map form numbers to sections
          let targetSection = null
          if (formNum) {
            if (formNum.startsWith('1')) targetSection = '3.1'
            else if (formNum.startsWith('2')) targetSection = '3.2'
            else if (formNum.startsWith('3')) targetSection = '3.2'
            else if (formNum.startsWith('5')) targetSection = '3.3'
            else if (formNum.startsWith('6')) targetSection = '3.4'
          } else if (sectionNum) {
            const parts = sectionNum.split('.')
            targetSection = `${parts[0]}.${parts[1]}`
          }
          
          if (targetSection && categories[targetSection]) {
            categories[targetSection].recommendations.push(rec)
          }
        }
      })
    }
    
    // Sort categories by section number
    return Object.entries(categories)
      .sort(([a], [b]) => {
        const aParts = a.split('.').map(Number)
        const bParts = b.split('.').map(Number)
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const aVal = aParts[i] || 0
          const bVal = bParts[i] || 0
          if (aVal !== bVal) return aVal - bVal
        }
        return 0
      })
      .map(([key, value]) => ({ key, ...value }))
  }, [sections, comparison.criticalIssues, comparison.recommendations])

  // Set first category as active by default
  if (activeMainSection === null && categorizedSections.length > 0) {
    setActiveMainSection(categorizedSections[0].key)
  }

  const activeCategory = categorizedSections.find(cat => cat.key === activeMainSection)

  const toggleSection = (index) => {
    setExpandedSections(prev => ({
      ...prev,
      [index]: !prev[index]
    }))
  }

  const downloadReport = () => {
    const reportData = {
      generatedAt: new Date().toISOString(),
      applications: applications.map(a => a.originalName || a.name),
      checklists: checklists.map(c => c.originalName || c.name),
      selectedSections: (selectedSections || []).map(s => s.sectionTitle),
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

  // Section description mapping for quick recognition on tiles
  const sectionDescriptions = {
    '1.0': 'Application Overview',
    '1.1': 'Application Overview',
    '1.2': 'Eligibility Requirements',
    '2.0': 'Narrative & Abstract',
    '2.1': 'Project Abstract',
    '2.2': 'Project Narrative',
    '2.3': 'Budget Narrative',
    '3.0': 'Application Forms',
    '3.1': 'General Information (Form 1A, 1C)',
    '3.2': 'Budget Information (Form 2, 3)',
    '3.3': 'Sites & Services (Form 5A, 5B, 5C)',
    '3.4': 'Other Forms (Form 6A, 6B, 8, 12)',
    '3.5': 'Other Information (Summary Page)',
    '4.0': 'Submission & Review',
    '4.1': 'Submission Requirements',
    '4.2': 'Review Process',
    '4.3': 'Award Information',
    '0.0': 'Other / Uncategorized',
  }

  const getSectionDescription = (sectionKey) => {
    if (sectionDescriptions[sectionKey]) return sectionDescriptions[sectionKey]
    // Try to extract description from the first section's checklistSection title
    const category = categorizedSections.find(c => c.key === sectionKey)
    if (category && category.sections.length > 0) {
      const firstTitle = category.sections[0].checklistSection || ''
      // Extract the descriptive part after the section number
      const descMatch = firstTitle.match(/^\d+(?:\.\d+)*\s+(.+)/)
      if (descMatch) return descMatch[1].substring(0, 50)
    }
    return ''
  }

  // Normalize page references from mixed AI output formats into clean numbers
  const normalizePageRef = (page) => {
    if (typeof page === 'number') return page
    if (typeof page === 'string') {
      const num = parseInt(page.replace(/[^0-9]/g, ''))
      return isNaN(num) ? null : num
    }
    return null
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'met':
        return <CheckCircle className="w-5 h-5 text-green-500" />
      case 'partial':
        return <AlertTriangle className="w-5 h-5 text-yellow-500" />
      case 'not_met':
        return <XCircle className="w-5 h-5 text-red-500" />
      case 'not_applicable':
        return <MinusCircle className="w-5 h-5 text-gray-500" />
      default:
        return <AlertTriangle className="w-5 h-5 text-gray-500" />
    }
  }

  const getStatusBg = (status) => {
    switch (status) {
      case 'met':
        return 'bg-teal-900/30 border-teal-700/50'
      case 'partial':
        return 'bg-yellow-900/30 border-yellow-700/50'
      case 'not_met':
        return 'bg-red-900/30 border-red-700/50'
      case 'not_applicable':
        return 'bg-slate-800/50 border-slate-600/50 opacity-60'
      default:
        return 'bg-slate-800 border-slate-600'
    }
  }

  const getStatusText = (status) => {
    switch (status) {
      case 'met':
        return 'text-green-400'
      case 'partial':
        return 'text-yellow-400'
      case 'not_met':
        return 'text-red-400'
      case 'not_applicable':
        return 'text-gray-500'
      default:
        return 'text-gray-400'
    }
  }

  const metCount = sections.filter(s => s.status === 'met').length
  const partialCount = sections.filter(s => s.status === 'partial').length
  const notMetCount = sections.filter(s => s.status === 'not_met').length
  const naCount = sections.filter(s => s.status === 'not_applicable').length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white mb-3">Compliance Validation Report</h2>
            <div className="space-y-1 text-sm text-gray-400">
              <div>Application(s): {applications.map(a => a.originalName || a.name).join(', ')}</div>
              <div>Checklist(s): {checklists.map(c => c.originalName || c.name).join(', ')}</div>
              <div>Sections Validated: {selectedSections?.length || sections.length}</div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={downloadReport}
              className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              <Download className="w-4 h-4" />
              <span>Download Report</span>
            </button>
          </div>
        </div>

        {/* Application Info */}
        {comparison.applicationInfo && (
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            {comparison.applicationInfo.applicationType && (
              <span className="px-3 py-1 bg-blue-500/10 text-blue-300 text-xs font-medium rounded-full border border-blue-500/20">
                Type: {comparison.applicationInfo.applicationType}
              </span>
            )}
            {comparison.applicationInfo.applicantName && (
              <span className="px-3 py-1 bg-slate-700 text-gray-300 text-xs rounded-full">
                {comparison.applicationInfo.applicantName}
              </span>
            )}
            {comparison.applicationInfo.grantNumber && comparison.applicationInfo.grantNumber !== 'N/A' && (
              <span className="px-3 py-1 bg-slate-700 text-gray-300 text-xs rounded-full">
                Grant: {comparison.applicationInfo.grantNumber}
              </span>
            )}
          </div>
        )}

        {/* Overall Compliance */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-3xl font-bold text-gray-500 mb-1">{naCount}</div>
            <div className="text-sm text-gray-400">Not Applicable</div>
          </div>
        </div>

        {/* Summary */}
        {comparison.summary && (
          <div className="mt-6 p-4 bg-slate-900 rounded-lg border border-slate-600">
            <h3 className="text-sm font-medium text-gray-400 mb-2">Executive Summary</h3>
            <p className="text-gray-300 text-sm leading-relaxed">{comparison.summary}</p>
          </div>
        )}
      </div>

      {/* Critical Issues section removed - now embedded in section tabs */}

      {/* Categorized Section Analysis with Tabs */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <div className="p-6 border-b border-slate-700">
          <h3 className="text-xl font-semibold text-white mb-4">Detailed Section Analysis</h3>
          
          {/* Category Tabs */}
          <div className="flex flex-wrap gap-2">
            {categorizedSections.map((category) => {
              const isActive = activeMainSection === category.key
              const applicableSections = category.sections.length - (category.naCount || 0)
              const compliance = applicableSections > 0
                ? Math.round((category.metCount / applicableSections) * 100)
                : 0
              
              return (
                <button
                  key={category.key}
                  onClick={() => setActiveMainSection(category.key)}
                  className={`px-4 py-3 rounded-lg border transition-all ${
                    isActive
                      ? 'bg-blue-600 border-blue-500 text-white shadow-lg'
                      : 'bg-slate-900 border-slate-600 text-gray-300 hover:bg-slate-700 hover:border-slate-500'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <FileText className="w-4 h-4" />
                    <div className="text-left">
                      <div className="font-semibold text-sm">Section {category.key}</div>
                      {getSectionDescription(category.key) && (
                        <div className="text-xs opacity-70 mb-0.5">{getSectionDescription(category.key)}</div>
                      )}
                      <div className="text-xs opacity-80">
                        {category.sections.length} items • {compliance}% compliant
                      </div>
                    </div>
                    <div className="flex items-center space-x-1 ml-2">
                      {category.metCount > 0 && (
                        <span className="bg-green-500/20 text-green-400 text-xs px-2 py-0.5 rounded">
                          {category.metCount}
                        </span>
                      )}
                      {category.partialCount > 0 && (
                        <span className="bg-yellow-500/20 text-yellow-400 text-xs px-2 py-0.5 rounded">
                          {category.partialCount}
                        </span>
                      )}
                      {category.notMetCount > 0 && (
                        <span className="bg-red-500/20 text-red-400 text-xs px-2 py-0.5 rounded">
                          {category.notMetCount}
                        </span>
                      )}
                      {(category.naCount || 0) > 0 && (
                        <span className="bg-gray-500/20 text-gray-400 text-xs px-2 py-0.5 rounded">
                          {category.naCount} N/A
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Active Category Content */}
        {activeCategory && (
          <div className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h4 className="text-lg font-semibold text-white">Section {activeCategory.key}</h4>
                <p className="text-sm text-gray-400">
                  {activeCategory.sections.length} requirement(s) in this section
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <div className="flex items-center space-x-1 text-sm">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="text-gray-300">{activeCategory.metCount}</span>
                </div>
                <div className="flex items-center space-x-1 text-sm">
                  <AlertTriangle className="w-4 h-4 text-yellow-500" />
                  <span className="text-gray-300">{activeCategory.partialCount}</span>
                </div>
                <div className="flex items-center space-x-1 text-sm">
                  <XCircle className="w-4 h-4 text-red-500" />
                  <span className="text-gray-300">{activeCategory.notMetCount}</span>
                </div>
                {(activeCategory.naCount || 0) > 0 && (
                  <div className="flex items-center space-x-1 text-sm">
                    <MinusCircle className="w-4 h-4 text-gray-500" />
                    <span className="text-gray-400">{activeCategory.naCount}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Critical Issues for this section */}
            {activeCategory.criticalIssues && activeCategory.criticalIssues.length > 0 && (
              <div className="mb-4 bg-red-900/20 border border-red-700/50 rounded-lg p-4">
                <div className="flex items-center space-x-2 mb-3">
                  <XCircle className="w-5 h-5 text-red-500" />
                  <h5 className="text-sm font-semibold text-red-400">Critical Issues in This Section</h5>
                </div>
                <ul className="space-y-2">
                  {activeCategory.criticalIssues.map((issue, idx) => (
                    <li key={idx} className="flex items-start space-x-2 text-sm text-red-300">
                      <span className="text-red-500 mt-1">•</span>
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            
            {/* Recommendations for this section */}
            {activeCategory.recommendations && activeCategory.recommendations.length > 0 && (
              <div className="mb-4 bg-blue-900/20 border border-blue-700/50 rounded-lg p-4">
                <div className="flex items-center space-x-2 mb-3">
                  <CheckCircle className="w-5 h-5 text-blue-500" />
                  <h5 className="text-sm font-semibold text-blue-400">Recommendations for This Section</h5>
                </div>
                <ul className="space-y-2">
                  {activeCategory.recommendations.map((rec, idx) => (
                    <li key={idx} className="flex items-start space-x-2 text-sm text-blue-300">
                      <span className="text-blue-500 mt-1">•</span>
                      <span>{rec}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-3">
              {activeCategory.sections.map((section) => {
                const isExpanded = expandedSections[section.originalIndex]
                
                return (
                  <div
                    key={section.originalIndex}
                    className={`border rounded-lg overflow-hidden ${getStatusBg(section.status)}`}
                  >
                    <button
                      onClick={() => toggleSection(section.originalIndex)}
                      className="w-full p-4 flex items-start justify-between hover:bg-white/5 transition-colors"
                    >
                      <div className="flex items-start space-x-3 flex-1 text-left">
                        {getStatusIcon(section.status)}
                        <div className="flex-1">
                          <div className={`font-semibold text-base mb-1 ${getStatusText(section.status)}`}>
                            {section.checklistSection || `Section ${section.originalIndex + 1}`}
                          </div>
                          <div className="text-sm text-gray-300 leading-relaxed">
                            {section.requirement}
                          </div>
                        </div>
                      </div>
                      {isExpanded ? (
                        <ChevronUp className="w-5 h-5 text-gray-400 flex-shrink-0 ml-3" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-gray-400 flex-shrink-0 ml-3" />
                      )}
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-4 bg-slate-900/50">
                        {/* Application Section */}
                        <div className="pt-4 border-t border-white/10">
                          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                            Application Section
                          </h4>
                          <p className="text-sm text-gray-300">
                            {section.applicationSection || 'Not specified'}
                          </p>
                        </div>

                        {/* Page References */}
                        {section.pageReferences && section.pageReferences.length > 0 && (
                          <div>
                            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                              Page References (PDF Pages)
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {(() => {
                                const sectionPages = section.pageReferences
                                  .map(normalizePageRef)
                                  .filter(p => p !== null)
                                return sectionPages.map((pageNum, pageIdx) => (
                                  <button
                                    key={pageIdx}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      if (onOpenPageViewer) onOpenPageViewer(pageNum, sectionPages, section.checklistSection)
                                    }}
                                    className="px-3 py-1 bg-blue-600/30 text-blue-300 text-sm rounded border border-blue-500/40 flex items-center space-x-1 hover:bg-blue-600/50 hover:border-blue-400 transition-colors cursor-pointer"
                                    title={`View PDF page ${pageNum}`}
                                  >
                                    <FileText className="w-3 h-3" />
                                    <span>Page {pageNum}</span>
                                  </button>
                                ))
                              })()}
                            </div>
                          </div>
                        )}

                        {/* Missing Fields (if any) */}
                        {section.missingFields && section.missingFields.length > 0 && (
                          <div>
                            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                              Missing/Empty Required Fields
                            </h4>
                            <div className="bg-red-900/20 p-4 rounded border border-red-700/40">
                              <ul className="space-y-1">
                                {section.missingFields.map((field, fieldIdx) => (
                                  <li key={fieldIdx} className="flex items-start space-x-2 text-sm text-red-300">
                                    <span className="text-red-500 mt-1">•</span>
                                    <span>{field}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}

                        {/* Evidence from Application */}
                        {section.evidence && (
                          <div>
                            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                              Evidence from Application
                            </h4>
                            <div className="bg-slate-800/70 p-5 rounded border border-slate-600">
                              <div className="space-y-3 font-mono text-sm">
                                {(() => {
                                  const lines = section.evidence.split('\n');
                                  const result = [];
                                  let i = 0;
                                  
                                  // Detect table patterns - GENERIC for ANY pipe-delimited table
                                  const detectTable = (startIdx) => {
                                    const line = lines[startIdx]?.trim();
                                    if (!line || !line.includes('|')) return { isTable: false };
                                    
                                    const parts = line.split('|').map(p => p.trim());
                                    
                                    // Must have at least 2 columns
                                    if (parts.length < 2) return { isTable: false };
                                    
                                    // Check if this looks like table data (contains numbers or is a header row)
                                    const hasNumbers = parts.some(p => /\d/.test(p));
                                    const looksLikeHeader = parts.every(p => p.length > 0 && !/^\d+$/.test(p));
                                    
                                    if (!hasNumbers && !looksLikeHeader) return { isTable: false };
                                    
                                    // Collect all consecutive pipe-delimited rows with same column count
                                    const tableLines = [];
                                    const columnCount = parts.length;
                                    let j = startIdx;
                                    let headers = null;
                                    
                                    // First row might be headers (all text, no pure numbers)
                                    if (looksLikeHeader && !hasNumbers) {
                                      headers = parts;
                                      j++;
                                    }
                                    
                                    // Collect data rows
                                    while (j < lines.length && lines[j]?.trim() && lines[j].includes('|')) {
                                      const rowParts = lines[j].split('|').map(p => p.trim());
                                      if (rowParts.length === columnCount) {
                                        tableLines.push(lines[j]);
                                        j++;
                                      } else {
                                        break;
                                      }
                                    }
                                    
                                    if (tableLines.length > 0) {
                                      return { isTable: true, lines: tableLines, headers, columnCount, endIdx: j };
                                    }
                                    
                                    return { isTable: false };
                                  };
                                  
                                  while (i < lines.length) {
                                    const line = lines[i];
                                    const tableCheck = detectTable(i);
                                    
                                    if (tableCheck.isTable) {
                                      // Render as GENERIC table - works for ANY column count
                                      const { lines: tableLines, headers, columnCount } = tableCheck;
                                      
                                      result.push(
                                        <div key={i} className="overflow-x-auto my-4">
                                          <table className="min-w-full border border-slate-600 text-xs">
                                            {headers && (
                                              <thead className="bg-slate-700">
                                                <tr>
                                                  {headers.map((header, idx) => (
                                                    <th key={idx} className="border border-slate-600 px-3 py-2 text-center text-blue-300">
                                                      {header}
                                                    </th>
                                                  ))}
                                                </tr>
                                              </thead>
                                            )}
                                            <tbody className="bg-slate-800">
                                              {tableLines.map((rowLine, k) => {
                                                const cells = rowLine.split('|').map(c => c.trim());
                                                if (cells.length === columnCount) {
                                                  return (
                                                    <tr key={k} className="hover:bg-slate-700/50">
                                                      {cells.map((cell, cellIdx) => (
                                                        <td 
                                                          key={cellIdx} 
                                                          className={`border border-slate-600 px-3 py-2 ${
                                                            cellIdx === 0 ? 'text-left text-gray-300' : 'text-center text-white'
                                                          }`}
                                                        >
                                                          {cell}
                                                        </td>
                                                      ))}
                                                    </tr>
                                                  );
                                                }
                                                return null;
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      );
                                      i = tableCheck.endIdx;
                                      continue;
                                    }
                                    
                                    // Regular line processing (existing logic)
                                    const idx = i;
                                    const isFormHeader = /^Form\s+\d+[A-Z]?\s*-/.test(line.trim())
                                    const isSectionHeader = /^\d+\.\s+[A-Z]/.test(line.trim())
                                    const isSubsectionHeader = /^\d+[a-z]\.\s+/.test(line.trim())
                                    const fieldMatch = line.match(/^([^:]+):\s*(.*)$/)
                                    const hasCheckbox = /\[\s*[X_]\s*\]/.test(line)
                                    
                                    if (isFormHeader) {
                                      result.push(
                                        <div key={idx} className="text-blue-400 font-bold text-base border-b border-blue-500/30 pb-2 mb-2">
                                          {line.trim()}
                                        </div>
                                      );
                                    } else if (isSectionHeader) {
                                      result.push(
                                        <div key={idx} className="text-green-400 font-semibold mt-3 mb-1">
                                          {line.trim()}
                                        </div>
                                      );
                                    } else if (isSubsectionHeader) {
                                      result.push(
                                        <div key={idx} className="text-yellow-400 font-medium mt-2 mb-1 ml-2">
                                          {line.trim()}
                                        </div>
                                      );
                                    } else if (fieldMatch && !hasCheckbox) {
                                      const [, fieldName, fieldValue] = fieldMatch;
                                      result.push(
                                        <div key={idx} className="flex ml-4">
                                          <span className="text-gray-400 min-w-[200px]">{fieldName.trim()}:</span>
                                          <span className="text-white font-medium">{fieldValue.trim() || '(empty)'}</span>
                                        </div>
                                      );
                                    } else if (hasCheckbox) {
                                      result.push(
                                        <div key={idx} className="text-gray-300 ml-4">
                                          {line.trim().replace(/\[\s*X\s*\]/g, '☑').replace(/\[\s*_\s*\]/g, '☐')}
                                        </div>
                                      );
                                    } else if (line.trim()) {
                                      result.push(
                                        <div key={idx} className="text-gray-300 ml-4">
                                          {line.trim()}
                                        </div>
                                      );
                                    } else {
                                      result.push(<div key={idx} className="h-2"></div>);
                                    }
                                    
                                    i++;
                                  }
                                  
                                  return result;
                                })()}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Analysis */}
                        {section.explanation && (
                          <div>
                            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                              Analysis
                            </h4>
                            <p className="text-sm text-gray-300 leading-relaxed">
                              {section.explanation}
                            </p>
                          </div>
                        )}

                        {/* Recommendation */}
                        {section.recommendation && section.status !== 'met' && (
                          <div>
                            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                              Recommendation
                            </h4>
                            <div className="bg-yellow-900/20 p-4 rounded border border-yellow-700/40">
                              <p className="text-sm text-yellow-300 leading-relaxed">
                                {section.recommendation}
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Overall Recommendations section removed - now embedded in section tabs */}
    </div>
  )
}
