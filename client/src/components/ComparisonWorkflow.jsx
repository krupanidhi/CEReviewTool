import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, GitCompare, Loader2 } from 'lucide-react'
import EnhancedComparisonUpload from './EnhancedComparisonUpload'
import ChecklistSelector from './ChecklistSelector'
import { compareDocuments } from '../services/api'

export default function ComparisonWorkflow({ onComparisonComplete, cachedDocs, onDocumentsUploaded }) {
  const [step, setStep] = useState(cachedDocs ? 2 : 1)
  const [uploadedDocs, setUploadedDocs] = useState(cachedDocs)
  const [selectedSections, setSelectedSections] = useState([])
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (cachedDocs) {
      setUploadedDocs(cachedDocs)
      setStep(2)
    }
  }, [cachedDocs])

  const handleDocumentsUploaded = (docs) => {
    setUploadedDocs(docs)
    setStep(2)
    if (onDocumentsUploaded) {
      onDocumentsUploaded(docs)
    }
  }

  const handleSelectionChange = useCallback((sections) => {
    setSelectedSections(sections)
  }, [])

  const handleCompare = async () => {
    setComparing(true)
    setError(null)

    try {
      const applications = uploadedDocs.applications
      const checklists = uploadedDocs.checklists

      console.log('🔍 ===== COMPARISON DEBUG START =====')
      console.log('📋 Selected sections:', selectedSections)

      const results = []

      for (const application of applications) {
        const applicationData = application.analysis?.data || application.data
        console.log(`📄 Application: ${application.name}`)

        for (const checklist of checklists) {
          const checklistData = checklist.analysis?.data || checklist.data
          console.log(`📗 Checklist: ${checklist.name}`)

          // Filter to only selected main sections
          const selectedTitles = selectedSections
            .filter(s => s.checklistId === checklist.id)
            .map(s => s.sectionTitle)
          
          console.log('✅ Selected section titles:', selectedTitles)

          // Extract section numbers from selected titles (e.g., "3" from "3. Completing...")
          const selectedSectionNumbers = selectedTitles.map(title => {
            const match = title.match(/^(\d+)\./);
            return match ? match[1] : null
          }).filter(Boolean)
          
          console.log('🔢 Extracted section numbers:', selectedSectionNumbers)

          // Filter sections to include main sections AND all subsections at any nesting level
          const filteredSections = checklistData.sections?.filter(section => {
            const sectionTitle = section.title || ''
            
            // Check if this section matches any selected main section
            const isMainSection = selectedTitles.some(title => 
              sectionTitle === title || sectionTitle.startsWith(title.substring(0, 10))
            )
            
            // Check if this is a subsection of a selected main section at ANY nesting level
            // Matches: 3.1, 3.1.1, 3.1.1.1, 3.2.2.1, etc.
            const isSubsection = selectedSectionNumbers.some(num => {
              // Pattern matches section number followed by dot and at least one digit
              // e.g., for num=3: matches 3.1, 3.2, 3.3, 3.1.1, 3.1.1.1, 3.2.1, 3.3.1, etc.
              const subsectionPattern = new RegExp(`^${num}\\.(\\d+)`)
              return subsectionPattern.test(sectionTitle)
            })
            
            return isMainSection || isSubsection
          }) || []
          
          console.log(`📑 Filtered sections count: ${filteredSections.length}`)
          console.log('📑 Filtered section titles (first 10):', filteredSections.map(s => s.title).slice(0, 10))
          console.log('📑 ALL filtered section titles:', filteredSections.map(s => s.title))

          // Filter TOC to only selected main sections
          const filteredTOC = checklistData.tableOfContents?.filter(toc => 
            selectedTitles.some(title => toc.title === title)
          ) || []

          // Get page ranges for selected sections to extract full content
          const pageRanges = filteredTOC.map(toc => toc.pageNumber).filter(p => p && p > 0)
          const minPage = pageRanges.length > 0 ? Math.min(...pageRanges) : 1
          const maxPage = pageRanges.length > 0 ? Math.max(...pageRanges) : 1
          
          console.log(`📄 Page range for selected sections: ${minPage} to ${maxPage + 30}`)
          
          // Extract full content from sections (not pages, as page.content doesn't exist)
          const sectionsContent = filteredSections
            .map(section => {
              const sectionText = section.content?.map(c => c.text).join('\n') || ''
              return `\n=== ${section.title} ===\n${sectionText}`
            })
            .join('\n\n')
          
          console.log(`📄 Extracted sections content length: ${sectionsContent.length} chars`)
          console.log(`📄 Number of sections included: ${filteredSections.length}`)

          // Create filtered checklist data with only selected sections
          const filteredChecklistData = {
            ...checklistData,
            sections: filteredSections,
            tableOfContents: filteredTOC,
            content: sectionsContent,
            selectedSectionNumbers: selectedSectionNumbers // Add this for AI to validate
          }
          
          console.log('📦 Filtered checklist data summary:')
          console.log('  - Sections:', filteredChecklistData.sections?.length || 0)
          console.log('  - TOC entries:', filteredChecklistData.tableOfContents?.length || 0)
          console.log('  - Content length:', filteredChecklistData.content?.length || 0)
          console.log('🔍 ===== COMPARISON DEBUG END =====')

          const result = await compareDocuments(applicationData, filteredChecklistData)

          results.push({
            ...result,
            applicationDoc: application,
            checklistDoc: checklist,
            selectedSections: selectedSections.filter(s => s.checklistId === checklist.id)
          })
        }
      }

      if (onComparisonComplete) {
        onComparisonComplete({
          results,
          applications: uploadedDocs.applications,
          checklists: uploadedDocs.checklists,
          selectedSections
        })
      }

      setStep(3)
    } catch (err) {
      setError(`Comparison failed: ${err.message}`)
    } finally {
      setComparing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Progress Steps */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center justify-between">
          <div className={`flex items-center space-x-3 ${step >= 1 ? 'text-blue-400' : 'text-gray-500'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
              step >= 1 ? 'bg-blue-500 text-white' : 'bg-slate-700 text-gray-400'
            }`}>
              1
            </div>
            <span className="font-medium">Upload Documents</span>
          </div>
          <ArrowRight className="w-5 h-5 text-gray-600" />
          <div className={`flex items-center space-x-3 ${step >= 2 ? 'text-blue-400' : 'text-gray-500'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
              step >= 2 ? 'bg-blue-500 text-white' : 'bg-slate-700 text-gray-400'
            }`}>
              2
            </div>
            <span className="font-medium">Select Sections</span>
          </div>
          <ArrowRight className="w-5 h-5 text-gray-600" />
          <div className={`flex items-center space-x-3 ${step >= 3 ? 'text-blue-400' : 'text-gray-500'}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
              step >= 3 ? 'bg-blue-500 text-white' : 'bg-slate-700 text-gray-400'
            }`}>
              3
            </div>
            <span className="font-medium">View Report</span>
          </div>
        </div>
      </div>

      {/* Step 1: Upload */}
      {step === 1 && (
        <EnhancedComparisonUpload onDocumentsUploaded={handleDocumentsUploaded} />
      )}

      {/* Step 2: Select Sections */}
      {step === 2 && uploadedDocs && (
        <div className="space-y-6">
          <ChecklistSelector 
            checklists={uploadedDocs.checklists}
            onSelectionChange={handleSelectionChange}
          />

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              onClick={() => setStep(1)}
              className="bg-slate-700 hover:bg-slate-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
            >
              Back to Upload
            </button>
            <button
              onClick={handleCompare}
              disabled={selectedSections.length === 0 || comparing}
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
          </div>
        </div>
      )}

      {/* Step 3: Results handled by parent component */}
    </div>
  )
}
