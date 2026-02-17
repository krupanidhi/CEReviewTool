import { useState, useEffect } from 'react'
import { CheckSquare, Square, ChevronDown, ChevronRight, FileText } from 'lucide-react'

export default function ChecklistSelector({ checklists, onSelectionChange }) {
  const [expandedChecklists, setExpandedChecklists] = useState({})
  const [selectedSections, setSelectedSections] = useState({})
  const [checklistSections, setChecklistSections] = useState({})

  useEffect(() => {
    if (checklists && checklists.length > 0) {
      const sections = {}
      checklists.forEach(checklist => {
        const checklistId = checklist.id
        const toc = checklist.data?.tableOfContents || []
        const extractedSections = checklist.data?.sections || []
        
        // ─── Use DI-extracted TOC directly (clean, deterministic) ─────────────
        // The TOC is built from DI paragraph roles (sectionHeading/title) in
        // enhancedDocumentIntelligence.js — already filtered for top-level
        // sections, action verbs, and sequential numbering. No regex needed here.
        let mainSections = toc.length > 0 
          ? toc.filter(item => item.level === 1 || item.level === undefined)
          : extractedSections
              .filter(s => s.sectionType === 'organizational_header')
              .map((s, idx) => ({
                id: `section_${idx + 1}`,
                title: s.title,
                pageNumber: s.pageNumber,
                level: 1
              }))
        
        sections[checklistId] = {
          name: checklist.originalName,
          sections: mainSections
        }
      })
      setChecklistSections(sections)
      
      const initialExpanded = {}
      const initialSelected = {}
      Object.entries(sections).forEach(([checklistId, data]) => {
        initialExpanded[checklistId] = true
        // Default: select ALL sections
        data.sections.forEach(section => {
          initialSelected[`${checklistId}_${section.id}`] = true
        })
      })
      setExpandedChecklists(initialExpanded)
      setSelectedSections(initialSelected)

      // Notify parent of default selection
      const selected = Object.entries(initialSelected)
        .filter(([_, isSelected]) => isSelected)
        .map(([k, _]) => {
          const [cId, sId] = k.split('_section_')
          const section = sections[cId]?.sections.find(s => s.id === `section_${sId}`)
          return {
            checklistId: cId,
            checklistName: sections[cId]?.name,
            sectionId: `section_${sId}`,
            sectionTitle: section?.title,
            pageNumber: section?.pageNumber
          }
        })
      if (onSelectionChange) {
        onSelectionChange(selected)
      }
    }
  }, [checklists])

  const toggleChecklist = (checklistId) => {
    setExpandedChecklists(prev => ({
      ...prev,
      [checklistId]: !prev[checklistId]
    }))
  }

  const toggleSection = (checklistId, sectionId) => {
    const key = `${checklistId}_${sectionId}`
    setSelectedSections(prev => {
      const newSelected = { ...prev, [key]: !prev[key] }
      return newSelected
    })
  }
  
  // Notify parent of selection changes
  useEffect(() => {
    const selected = Object.entries(selectedSections)
      .filter(([_, isSelected]) => isSelected)
      .map(([k, _]) => {
        const [cId, sId] = k.split('_section_')
        const section = checklistSections[cId]?.sections.find(s => s.id === `section_${sId}`)
        return {
          checklistId: cId,
          checklistName: checklistSections[cId]?.name,
          sectionId: `section_${sId}`,
          sectionTitle: section?.title,
          pageNumber: section?.pageNumber
        }
      })
    
    if (onSelectionChange) {
      onSelectionChange(selected)
    }
  }, [selectedSections, checklistSections, onSelectionChange])

  const toggleAll = (checklistId, select) => {
    const sections = checklistSections[checklistId]?.sections || []
    const newSelected = { ...selectedSections }
    
    sections.forEach(section => {
      const key = `${checklistId}_${section.id}`
      newSelected[key] = select
    })
    
    setSelectedSections(newSelected)
    
    const selected = Object.entries(newSelected)
      .filter(([_, isSelected]) => isSelected)
      .map(([k, _]) => {
        const [cId, sId] = k.split('_section_')
        const section = checklistSections[cId]?.sections.find(s => s.id === `section_${sId}`)
        return {
          checklistId: cId,
          checklistName: checklistSections[cId]?.name,
          sectionId: `section_${sId}`,
          sectionTitle: section?.title,
          pageNumber: section?.pageNumber
        }
      })
    
    if (onSelectionChange) {
      onSelectionChange(selected)
    }
  }

  const getSelectedCount = (checklistId) => {
    const sections = checklistSections[checklistId]?.sections || []
    return sections.filter(section => 
      selectedSections[`${checklistId}_${section.id}`]
    ).length
  }

  if (!checklists || checklists.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg p-8 text-center border border-slate-700">
        <FileText className="w-12 h-12 text-gray-600 mx-auto mb-3" />
        <p className="text-gray-400">No checklists uploaded yet</p>
      </div>
    )
  }

  return (
    <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-white mb-2">Select Sections to Validate</h3>
        <p className="text-sm text-gray-400">
          Choose which checklist sections to validate against the application
        </p>
      </div>

      <div className="space-y-3">
        {Object.entries(checklistSections).map(([checklistId, data]) => {
          const isExpanded = expandedChecklists[checklistId]
          const selectedCount = getSelectedCount(checklistId)
          const totalCount = data.sections.length

          return (
            <div key={checklistId} className="border border-slate-600 rounded-lg overflow-hidden">
              {/* Checklist Header */}
              <div className="bg-slate-900 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3 flex-1">
                    <button
                      onClick={() => toggleChecklist(checklistId)}
                      className="text-gray-400 hover:text-white"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-5 h-5" />
                      ) : (
                        <ChevronRight className="w-5 h-5" />
                      )}
                    </button>
                    <FileText className="w-5 h-5 text-green-500" />
                    <div className="flex-1">
                      <h4 className="font-medium text-white">{data.name}</h4>
                      <p className="text-xs text-gray-400">
                        {selectedCount} of {totalCount} sections selected
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => toggleAll(checklistId, true)}
                      className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => toggleAll(checklistId, false)}
                      className="text-xs text-gray-400 hover:text-gray-300 px-2 py-1"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>

              {/* Sections List */}
              {isExpanded && (
                <div className="p-2 space-y-1 max-h-96 overflow-y-auto">
                  {data.sections.map((section) => {
                    const key = `${checklistId}_${section.id}`
                    const isSelected = selectedSections[key]

                    return (
                      <button
                        key={section.id}
                        onClick={() => toggleSection(checklistId, section.id)}
                        className={`w-full flex items-start space-x-3 p-3 rounded-lg transition-colors ${
                          isSelected
                            ? 'bg-blue-500/20 border border-blue-500/30'
                            : 'bg-slate-800 border border-slate-600 hover:bg-slate-700'
                        }`}
                      >
                        <div className="flex-shrink-0 mt-0.5">
                          {isSelected ? (
                            <CheckSquare className="w-5 h-5 text-blue-400" />
                          ) : (
                            <Square className="w-5 h-5 text-gray-500" />
                          )}
                        </div>
                        <div className="flex-1 text-left">
                          <div className="font-medium text-white text-sm">
                            {section.title}
                          </div>
                          {section.pageNumber && (
                            <div className="text-xs text-gray-400 mt-1">
                              Page {section.pageNumber}
                            </div>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Selection Summary */}
      <div className="mt-4 p-4 bg-slate-900 rounded-lg border border-slate-600">
        <div className="text-sm text-gray-300">
          <span className="font-medium text-white">
            {Object.values(selectedSections).filter(Boolean).length}
          </span>{' '}
          section(s) selected for validation
        </div>
      </div>
    </div>
  )
}
