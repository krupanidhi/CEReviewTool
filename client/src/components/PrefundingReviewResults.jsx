import { useState, useEffect, useRef, useCallback } from 'react'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'
import { saveAs } from 'file-saver'

const PF_SECTIONS = [
  'Sliding Fee Discount Program',
  'Key Management Staff',
  'Contracts and Subawards',
  'Collaborative Relationships',
  'Billing and Collections',
  'Budget',
  'Board Authority',
  'Board Composition'
]

function PrefundingReviewResults({ pfData }) {
  const [expandedChapters, setExpandedChapters] = useState({})
  const [expandedDetails, setExpandedDetails] = useState({})
  const [filterStatus, setFilterStatus] = useState(null)
  const [navigationMode, setNavigationMode] = useState(null)
  const [currentItemIndex, setCurrentItemIndex] = useState(0)
  const [highlightedItemId, setHighlightedItemId] = useState(null)
  const [speechStatus, setSpeechStatus] = useState({})

  if (!pfData || !pfData.results) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
        <p style={{ fontSize: '1.1rem' }}>No pre-funding review results available for this application.</p>
      </div>
    )
  }

  const { results } = pfData

  // Compute summary statistics
  let totalCompliant = 0
  let totalNonCompliant = 0
  let totalNotApplicable = 0

  PF_SECTIONS.forEach(section => {
    const r = results[section]
    if (r) {
      totalCompliant += r.compliantItems?.length || 0
      totalNonCompliant += r.nonCompliantItems?.length || 0
      totalNotApplicable += r.notApplicableItems?.length || 0
    }
  })

  const totalItems = totalCompliant + totalNonCompliant + totalNotApplicable
  const complianceRate = totalItems > 0 ? ((totalCompliant / totalItems) * 100).toFixed(1) : 0

  const toggleChapter = (section) => {
    setExpandedChapters(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const toggleDetail = (key) => {
    setExpandedDetails(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Navigation Mode: get all items of a given type across all sections
  const getAllItemsOfType = (type) => {
    const items = []
    if (!results) return items
    PF_SECTIONS.forEach(section => {
      const r = results[section]
      if (!r) return
      let itemList
      if (type === 'compliance') itemList = r.compliantItems
      else if (type === 'non-compliance') itemList = r.nonCompliantItems
      else if (type === 'not-applicable') itemList = r.notApplicableItems
      if (itemList) {
        itemList.forEach((item, idx) => {
          items.push({ section, item, index: idx, id: `${section}-${type}-${idx}` })
        })
      }
    })
    return items
  }

  const scrollToItem = (itemData) => {
    if (!itemData) return
    setHighlightedItemId(itemData.id)
    setExpandedChapters(prev => ({ ...prev, [itemData.section]: true }))
    setTimeout(() => {
      const el = document.getElementById(itemData.id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
    setTimeout(() => setHighlightedItemId(null), 3000)
  }

  const handleSummaryCardNavigation = (type) => {
    setNavigationMode(type)
    setCurrentItemIndex(0)
    // Expand all chapters
    const allChapters = {}
    PF_SECTIONS.forEach(s => { allChapters[s] = true })
    setExpandedChapters(allChapters)
    const items = getAllItemsOfType(type)
    if (items.length > 0) {
      setTimeout(() => scrollToItem(items[0]), 200)
    }
  }

  const navigateToNextItem = () => {
    if (!navigationMode) return
    const items = getAllItemsOfType(navigationMode)
    if (items.length === 0) return
    const nextIndex = (currentItemIndex + 1) % items.length
    setCurrentItemIndex(nextIndex)
    scrollToItem(items[nextIndex])
  }

  // Keyboard handler for Enter key navigation
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === 'Enter' && navigationMode) {
        navigateToNextItem()
      }
    }
    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [navigationMode, currentItemIndex, results])

  // Export to Word
  const exportResultsToWord = async () => {
    if (!results) { alert('No results available to export'); return }
    try {
      const sections = []
      sections.push(new Paragraph({ text: 'HRSA Pre-Funding Review Report', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 200 } }))
      sections.push(new Paragraph({ text: `Application: ${pfData.filename || 'Unknown'}`, heading: HeadingLevel.HEADING_2, alignment: AlignmentType.CENTER, spacing: { after: 400 } }))
      sections.push(new Paragraph({ text: 'Summary Statistics', heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 200 } }))
      sections.push(new Paragraph({ children: [new TextRun({ text: 'Total Requirements: ', bold: true }), new TextRun({ text: `${totalItems}` })], spacing: { after: 100 } }))
      sections.push(new Paragraph({ children: [new TextRun({ text: '✅ Compliant: ', bold: true }), new TextRun({ text: `${totalCompliant}` })], spacing: { after: 100 } }))
      sections.push(new Paragraph({ children: [new TextRun({ text: '❌ Non-Compliant: ', bold: true }), new TextRun({ text: `${totalNonCompliant}` })], spacing: { after: 100 } }))
      sections.push(new Paragraph({ children: [new TextRun({ text: '⊘ Not Applicable: ', bold: true }), new TextRun({ text: `${totalNotApplicable}` })], spacing: { after: 400 } }))

      PF_SECTIONS.forEach(section => {
        const r = results[section]
        if (!r) return
        const allItems = [
          ...(r.compliantItems || []).map(item => ({ ...item, type: 'COMPLIANT' })),
          ...(r.nonCompliantItems || []).map(item => ({ ...item, type: 'NON_COMPLIANT' })),
          ...(r.notApplicableItems || []).map(item => ({ ...item, type: 'NOT_APPLICABLE' }))
        ]
        if (allItems.length === 0) return
        sections.push(new Paragraph({ text: section, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }))
        allItems.forEach(item => {
          const statusText = item.type === 'COMPLIANT' ? '✅ COMPLIANT' : item.type === 'NOT_APPLICABLE' ? '⊘ NOT APPLICABLE' : '❌ NON-COMPLIANT'
          sections.push(new Paragraph({ text: item.element, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 100 } }))
          sections.push(new Paragraph({ children: [new TextRun({ text: 'Status: ', bold: true }), new TextRun({ text: statusText })], spacing: { after: 100 } }))
          sections.push(new Paragraph({ children: [new TextRun({ text: 'Requirement: ', bold: true }), new TextRun({ text: item.requirement || 'Not specified' })], spacing: { after: 100 } }))
          if (item.evidenceSection && item.evidenceSection !== 'Not found') {
            sections.push(new Paragraph({ children: [new TextRun({ text: 'Found in: ', bold: true }), new TextRun({ text: item.evidenceSection })], spacing: { after: 50 } }))
          }
          if (item.evidenceLocation && item.evidenceLocation !== 'Not found') {
            sections.push(new Paragraph({ children: [new TextRun({ text: 'Page(s): ', bold: true }), new TextRun({ text: item.evidenceLocation })], spacing: { after: 100 } }))
          }
          sections.push(new Paragraph({ children: [new TextRun({ text: 'Evidence: ', bold: true }), new TextRun({ text: item.evidence || 'No evidence found' })], spacing: { after: 100 } }))
          sections.push(new Paragraph({ children: [new TextRun({ text: 'Reasoning: ', bold: true }), new TextRun({ text: item.reasoning || 'Not specified' })], spacing: { after: 200 } }))
          if (item.mustAddressValidation && item.mustAddressValidation.length > 0) {
            sections.push(new Paragraph({ children: [new TextRun({ text: 'Must Address Items:', bold: true })], spacing: { before: 50, after: 50 } }))
            item.mustAddressValidation.forEach(ma => {
              sections.push(new Paragraph({ children: [new TextRun({ text: `${ma.status === 'found' ? '✅' : '❌'} ${ma.item}: `, bold: true }), new TextRun({ text: ma.evidence || 'No evidence' })], spacing: { after: 50 } }))
            })
          }
        })
      })

      const doc = new Document({ sections: [{ properties: {}, children: sections }] })
      const blob = await Packer.toBlob(doc)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      const filename = `PF_Review_Report_${pfData.filename || 'Report'}_${timestamp}.docx`
      saveAs(blob, filename)
      alert('✅ Word document exported successfully!')
    } catch (error) {
      console.error('Error exporting to Word:', error)
      alert('❌ Failed to export to Word: ' + error.message)
    }
  }

  // Highlight quoted text in evidence
  const highlightQuotes = (text) => {
    if (!text) return text
    const parts = text.split(/("[^"]*"|'[^']*')/)
    return parts.map((part, i) => {
      if (part.match(/^["'].*["']$/)) {
        return (
          <span key={i} style={{
            background: 'linear-gradient(120deg, #fef08a 0%, #fde047 100%)',
            padding: '2px 6px',
            borderRadius: '3px',
            fontWeight: '600',
            color: '#333',
            border: '1px solid #facc15'
          }}>
            {part}
          </span>
        )
      }
      return part
    })
  }

  // Parse page numbers from evidence location
  const parsePageNumbers = (evidenceLocation) => {
    if (!evidenceLocation) return []
    const pages = []
    const cleaned = evidenceLocation.replace(/pages?\s*/gi, '').replace(/p\.?\s*/gi, '').replace(/pg\.?\s*/gi, '').trim()
    const parts = cleaned.split(/[,&]|\band\b/).map(p => p.trim()).filter(p => p.length > 0)
    for (const part of parts) {
      const rangeMatch = part.match(/(\d+)\s*[-–—]\s*(\d+)/)
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10)
        const end = parseInt(rangeMatch[2], 10)
        if (start <= end && end - start < 50) {
          for (let i = start; i <= end; i++) pages.push(i)
        }
        continue
      }
      const numMatch = part.match(/(\d+)/)
      if (numMatch) pages.push(parseInt(numMatch[1], 10))
    }
    return [...new Set(pages)].sort((a, b) => a - b)
  }

  // Render evidence text — split long evidence into bullet points
  const renderEvidence = (evidence) => {
    if (!evidence) return <span style={{ fontStyle: 'italic', color: '#94a3b8' }}>No evidence found</span>

    if (evidence.toLowerCase().includes('not found') ||
        evidence.toLowerCase().includes('no evidence') ||
        evidence.toLowerCase().includes('no explicit') ||
        evidence.length < 100) {
      return <p style={{ margin: 0, fontSize: '0.9rem', color: '#555', fontStyle: 'italic' }}>{evidence}</p>
    }

    const sentences = evidence.split(/\.\s+/).filter(s => s.trim().length > 20)
    if (sentences.length > 2) {
      return (
        <ul style={{ margin: 0, paddingLeft: '20px', lineHeight: '1.7' }}>
          {sentences.map((sentence, i) => {
            const full = sentence.trim() + (sentence.trim().endsWith('.') ? '' : '.')
            return <li key={i} style={{ fontSize: '0.9rem', color: '#1e3a5f', marginBottom: '8px' }}>{highlightQuotes(full)}</li>
          })}
        </ul>
      )
    }
    return <p style={{ margin: 0, fontSize: '0.9rem', color: '#1e3a5f', lineHeight: '1.6' }}>{highlightQuotes(evidence)}</p>
  }

  // Get all items for a section, optionally filtered
  const getFilteredItems = (sectionResult) => {
    if (!sectionResult) return []
    const all = [
      ...(sectionResult.compliantItems || []).map(item => ({ ...item, _type: 'COMPLIANT' })),
      ...(sectionResult.nonCompliantItems || []).map(item => ({ ...item, _type: 'NON_COMPLIANT' })),
      ...(sectionResult.notApplicableItems || []).map(item => ({ ...item, _type: 'NOT_APPLICABLE' }))
    ]
    if (!filterStatus) return all
    return all.filter(item => item._type === filterStatus)
  }

  return (
    <div style={{ padding: '20px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <h2 style={{ margin: 0, color: '#0B4778', fontSize: '1.4rem', fontWeight: '700' }}>
          📊 Pre-Funding Review Results{pfData.filename ? `: ${pfData.filename}` : ''}
        </h2>
        <button
          onClick={exportResultsToWord}
          style={{
            padding: '10px 20px',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '0.95rem',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            transition: 'all 0.3s',
            flexShrink: 0
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#1d4ed8'}
          onMouseLeave={(e) => e.currentTarget.style.background = '#2563eb'}
        >
          📄 Export to Word
        </button>
      </div>

      {/* Summary Statistics */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '16px',
        marginBottom: '30px'
      }}>
        {/* Total */}
        <div
          onClick={() => setFilterStatus(null)}
          style={{
            background: filterStatus === null ? '#dbeafe' : '#f0f9ff',
            border: `2px solid ${filterStatus === null ? '#2563eb' : '#3b82f6'}`,
            borderRadius: '12px',
            padding: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#3b82f6' }}>{totalItems}</div>
          <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Total Requirements</div>
        </div>

        {/* Non-Compliant */}
        <div
          onClick={() => handleSummaryCardNavigation('non-compliance')}
          style={{
            background: navigationMode === 'non-compliance' ? '#fee2e2' : '#fef2f2',
            border: `2px solid ${navigationMode === 'non-compliance' ? '#dc2626' : '#ef4444'}`,
            borderRadius: '12px',
            padding: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'transform 0.2s, box-shadow 0.2s'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(239, 68, 68, 0.3)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#ef4444' }}>{totalNonCompliant}</div>
          <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Non-Compliant</div>
        </div>

        {/* Not Applicable */}
        <div
          onClick={() => handleSummaryCardNavigation('not-applicable')}
          style={{
            background: navigationMode === 'not-applicable' ? '#e2e8f0' : '#f8fafc',
            border: `2px solid ${navigationMode === 'not-applicable' ? '#64748b' : '#94a3b8'}`,
            borderRadius: '12px',
            padding: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'transform 0.2s, box-shadow 0.2s'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(100, 116, 139, 0.3)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#94a3b8' }}>{totalNotApplicable}</div>
          <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Not Applicable</div>
        </div>

        {/* Compliant */}
        <div
          onClick={() => handleSummaryCardNavigation('compliance')}
          style={{
            background: navigationMode === 'compliance' ? '#dcfce7' : '#f0fdf4',
            border: `2px solid ${navigationMode === 'compliance' ? '#16a34a' : '#10b981'}`,
            borderRadius: '12px',
            padding: '16px',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'transform 0.2s, box-shadow 0.2s'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(16, 185, 129, 0.3)' }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#10b981' }}>{totalCompliant}</div>
          <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Compliant</div>
        </div>

        {/* Compliance Rate */}
        <div style={{
          background: '#fefce8',
          border: `2px solid ${complianceRate >= 80 ? '#10b981' : complianceRate >= 50 ? '#f59e0b' : '#ef4444'}`,
          borderRadius: '12px',
          padding: '16px',
          textAlign: 'center'
        }}>
          <div style={{
            fontSize: '2rem',
            fontWeight: 'bold',
            color: complianceRate >= 80 ? '#10b981' : complianceRate >= 50 ? '#f59e0b' : '#ef4444'
          }}>
            {complianceRate}%
          </div>
          <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Compliance Rate</div>
        </div>
      </div>

      {/* Navigation Mode Indicator */}
      {navigationMode && (
        <div style={{
          marginBottom: '20px',
          padding: '15px 20px',
          background: '#EFF6FB',
          border: '1px solid #D9E8F6',
          borderRadius: '10px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ color: '#0B4778', fontSize: '1rem', fontWeight: '600' }}>
            🎯 Navigation Mode: {navigationMode === 'compliance' ? '✅ Compliant Items' : navigationMode === 'non-compliance' ? '❌ Non-Compliant Items' : '⊘ Not Applicable Items'} - Press Enter for next item
          </span>
          <button
            onClick={() => { setNavigationMode(null); setHighlightedItemId(null); setCurrentItemIndex(0) }}
            style={{
              padding: '8px 16px',
              background: '#3b82f6',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              cursor: 'pointer',
              fontWeight: '500',
              fontSize: '0.9rem'
            }}
          >
            Exit Navigation
          </button>
        </div>
      )}

      {/* Filter indicator */}
      {filterStatus && (
        <div style={{
          marginBottom: '20px',
          padding: '10px 16px',
          background: '#EFF6FB',
          border: '1px solid #D9E8F6',
          borderRadius: '8px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ color: '#0B4778', fontSize: '0.9rem', fontWeight: '600' }}>
            Showing: {filterStatus === 'COMPLIANT' ? '✅ Compliant' : filterStatus === 'NON_COMPLIANT' ? '❌ Non-Compliant' : '⊘ Not Applicable'} items only
          </span>
          <button
            onClick={() => setFilterStatus(null)}
            style={{
              padding: '4px 12px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontWeight: '600'
            }}
          >
            Show All
          </button>
        </div>
      )}

      {/* Sections */}
      {PF_SECTIONS.map(section => {
        const sectionResult = results[section]
        if (!sectionResult) return null

        const items = getFilteredItems(sectionResult)
        if (items.length === 0 && filterStatus) return null

        const sectionCompliant = sectionResult.compliantItems?.length || 0
        const sectionNonCompliant = sectionResult.nonCompliantItems?.length || 0
        const sectionNA = sectionResult.notApplicableItems?.length || 0
        const sectionTotal = sectionCompliant + sectionNonCompliant + sectionNA
        const isExpanded = expandedChapters[section] || false

        return (
          <div key={section} style={{
            marginBottom: '20px',
            border: '1px solid #D9E8F6',
            borderRadius: '12px',
            background: '#FFFFFF',
            overflow: 'hidden'
          }}>
            {/* Chapter Header */}
            <button
              onClick={() => toggleChapter(section)}
              style={{
                width: '100%',
                padding: '16px 20px',
                background: '#EFF6FB',
                border: 'none',
                borderBottom: isExpanded ? '1px solid #D9E8F6' : 'none',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                transition: 'all 0.3s'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <h3 style={{ color: '#0B4778', margin: 0, fontSize: '1.15rem', fontWeight: '700', textAlign: 'left' }}>
                  📋 {section}
                </h3>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {sectionCompliant > 0 && (
                    <span style={{ padding: '2px 8px', borderRadius: '10px', background: '#dcfce7', color: '#16a34a', fontSize: '0.75rem', fontWeight: '600' }}>
                      ✅ {sectionCompliant}
                    </span>
                  )}
                  {sectionNonCompliant > 0 && (
                    <span style={{ padding: '2px 8px', borderRadius: '10px', background: '#fee2e2', color: '#dc2626', fontSize: '0.75rem', fontWeight: '600' }}>
                      ❌ {sectionNonCompliant}
                    </span>
                  )}
                  {sectionNA > 0 && (
                    <span style={{ padding: '2px 8px', borderRadius: '10px', background: '#f1f5f9', color: '#64748b', fontSize: '0.75rem', fontWeight: '600' }}>
                      ⊘ {sectionNA}
                    </span>
                  )}
                </div>
              </div>
              <span style={{
                fontSize: '1.3rem',
                transition: 'transform 0.3s',
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                color: '#93c5fd'
              }}>
                ▼
              </span>
            </button>

            {/* Chapter Items */}
            {isExpanded && (
              <div style={{ padding: '16px 20px' }}>
                {items.map((item, idx) => {
                  const isCompliant = item._type === 'COMPLIANT'
                  const isNA = item._type === 'NOT_APPLICABLE'
                  const borderColor = isNA ? '#64748b' : (isCompliant ? '#10b981' : '#ef4444')
                  const badgeColor = isNA ? '#64748b' : (isCompliant ? '#10b981' : '#ef4444')
                  const badgeText = isNA ? '⊘ NOT APPLICABLE' : (isCompliant ? '✅ COMPLIANT' : '❌ NON-COMPLIANT')

                  const evidenceKey = `evidence-${section}-${idx}`
                  const requirementKey = `requirement-${section}-${idx}`
                  const mustAddressKey = `mustaddress-${section}-${idx}`
                  const showEvidence = expandedDetails[evidenceKey] || false
                  const showRequirement = expandedDetails[requirementKey] || false
                  const showMustAddress = expandedDetails[mustAddressKey] || false

                  // Generate navigation ID
                  const itemType = isNA ? 'not-applicable' : (isCompliant ? 'compliance' : 'non-compliance')
                  const sourceList = isNA ? sectionResult.notApplicableItems : (isCompliant ? sectionResult.compliantItems : sectionResult.nonCompliantItems)
                  const itemIndex = sourceList ? sourceList.indexOf(item) : idx
                  const itemId = `${section}-${itemType}-${itemIndex >= 0 ? itemIndex : idx}`
                  const isHighlighted = highlightedItemId === itemId

                  const speechKey = `speech-${section}-${idx}`
                  const isPlaying = speechStatus[speechKey] || false

                  return (
                    <div
                      key={idx}
                      id={itemId}
                      style={{
                        marginBottom: '16px',
                        border: `2px solid ${borderColor}`,
                        borderRadius: '10px',
                        padding: '16px',
                        background: isHighlighted ? '#FFFFFF' : '#EFF6FB',
                        boxShadow: isHighlighted ? '0 0 20px rgba(59, 130, 246, 0.5)' : 'none',
                        transition: 'all 0.3s ease'
                      }}
                    >
                      {/* Element Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                        <div style={{ flex: 1 }}>
                          <strong style={{ color: '#0B4778', fontSize: '1.05rem', display: 'block', marginBottom: '6px' }}>
                            {item.element || 'Unknown Element'}
                          </strong>
                          {item.requirement && item.requirement !== 'Unknown' && item.requirement !== 'Not specified' && (
                            <p style={{ margin: 0, color: '#64748b', lineHeight: '1.5', fontSize: '0.9rem' }}>
                              {item.requirement}
                            </p>
                          )}
                        </div>
                        <span style={{
                          padding: '6px 14px',
                          borderRadius: '20px',
                          background: badgeColor,
                          color: 'white',
                          fontWeight: 'bold',
                          fontSize: '0.8rem',
                          whiteSpace: 'nowrap',
                          marginLeft: '16px',
                          flexShrink: 0
                        }}>
                          {badgeText}
                        </span>
                      </div>

                      {/* Must Address Items (collapsible) */}
                      {item.mustAddressValidation && item.mustAddressValidation.length > 0 && (
                        <div style={{ marginBottom: '10px' }}>
                          <button
                            onClick={() => toggleDetail(mustAddressKey)}
                            style={{
                              width: '100%',
                              padding: '10px 14px',
                              background: '#FFFFFF',
                              border: '1px solid #D9E8F6',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: '0.9rem',
                              fontWeight: '600',
                              color: '#0B4778',
                              transition: 'all 0.3s'
                            }}
                          >
                            <span>📋 Must Address ({item.mustAddressValidation.length} items)</span>
                            <span style={{ fontSize: '1.1rem', transition: 'transform 0.3s', transform: showMustAddress ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                          </button>
                          {showMustAddress && (
                            <div style={{ marginTop: '8px', padding: '15px', background: '#FFFFFF', borderRadius: '8px', border: '1px solid #D9E8F6' }}>
                              {item.mustAddressValidation.map((ma, maIdx) => (
                                <div key={maIdx} style={{
                                  marginBottom: maIdx < item.mustAddressValidation.length - 1 ? '15px' : '0',
                                  paddingBottom: maIdx < item.mustAddressValidation.length - 1 ? '15px' : '0',
                                  borderBottom: maIdx < item.mustAddressValidation.length - 1 ? '1px solid #D9E8F6' : 'none'
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
                                    <span style={{ fontSize: '1.2rem', flexShrink: 0 }}>{ma.status === 'found' ? '✅' : '❌'}</span>
                                    <div style={{ flex: 1 }}>
                                      <p style={{ margin: '0 0 8px 0', fontSize: '0.9rem', color: '#0B4778', fontWeight: '600' }}>{ma.item}</p>
                                      {ma.status === 'found' ? (
                                        <>
                                          <p style={{ margin: 0, fontSize: '0.85rem', color: '#1e3a5f', fontStyle: 'italic' }}>
                                            Evidence: <span style={{
                                              background: 'linear-gradient(120deg, #fef08a 0%, #fde047 100%)',
                                              padding: '2px 6px', borderRadius: '3px', fontWeight: '600', color: '#333',
                                              border: '1px solid #facc15', fontStyle: 'normal'
                                            }}>{ma.evidence}</span>
                                          </p>
                                          {ma.page && ma.page !== 'Not found' && (
                                            <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#64748b' }}>📄 {ma.page}</p>
                                          )}
                                        </>
                                      ) : (
                                        <p style={{ margin: 0, fontSize: '0.85rem', color: '#ef4444', fontStyle: 'italic' }}>No evidence found in application</p>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Show Requirement Details (collapsible) */}
                      {item.requirementDetails && item.requirementDetails.length > 0 && (
                        <div style={{ marginBottom: '10px' }}>
                          <button
                            onClick={() => toggleDetail(requirementKey)}
                            style={{
                              width: '100%',
                              padding: '10px 14px',
                              background: '#FFFFFF',
                              border: '1px solid #D9E8F6',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: '0.9rem',
                              fontWeight: '600',
                              color: '#0B4778',
                              transition: 'all 0.3s'
                            }}
                          >
                            <span>📋 Show Requirement Details</span>
                            <span style={{ fontSize: '1.1rem', transition: 'transform 0.3s', transform: showRequirement ? 'rotate(180deg)' : 'rotate(0deg)' }}>▼</span>
                          </button>
                          {showRequirement && (
                            <div style={{ marginTop: '8px', padding: '15px', background: '#FFFFFF', borderRadius: '8px', border: '1px solid #D9E8F6' }}>
                              <ul style={{ margin: 0, paddingLeft: '20px', lineHeight: '1.8' }}>
                                {item.requirementDetails.map((detail, i) => (
                                  <li key={i} style={{ fontSize: '0.9rem', color: '#1e3a5f', marginBottom: '6px' }}>{detail}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Evidence Toggle */}
                      <button
                        onClick={() => toggleDetail(evidenceKey)}
                        style={{
                          width: '100%',
                          padding: '10px 14px',
                          background: '#FFFFFF',
                          border: '1px solid #D9E8F6',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: '0.9rem',
                          fontWeight: '600',
                          color: '#0B4778',
                          transition: 'all 0.3s'
                        }}
                      >
                        <span>🔍 Show Evidence and Reasoning</span>
                        <span style={{
                          fontSize: '1.1rem',
                          transition: 'transform 0.3s',
                          transform: showEvidence ? 'rotate(180deg)' : 'rotate(0deg)'
                        }}>
                          ▼
                        </span>
                      </button>

                      {/* Evidence Details */}
                      {showEvidence && (
                        <div style={{
                          marginTop: '12px',
                          padding: '16px',
                          background: '#FFFFFF',
                          borderRadius: '8px',
                          border: '1px solid #D9E8F6'
                        }}>
                          {/* Evidence Source & Location */}
                          {(item.evidenceSection || item.evidenceLocation) && (
                            <div style={{
                              marginBottom: '12px',
                              padding: '12px',
                              background: '#FFFFFF',
                              borderRadius: '6px',
                              border: '2px solid #3b82f6'
                            }}>
                              <div style={{
                                fontSize: '0.8rem',
                                color: '#3b82f6',
                                marginBottom: '8px',
                                fontWeight: '700',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px'
                              }}>
                                📍 Evidence Source & Location
                              </div>

                              {item.evidenceSection && item.evidenceSection !== 'Not found' && (
                                <div style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  marginBottom: '8px',
                                  padding: '8px 10px',
                                  background: '#EFF6FB',
                                  borderRadius: '4px',
                                  border: '1px solid #D9E8F6'
                                }}>
                                  <span style={{ fontSize: '1rem', flexShrink: 0 }}>📂</span>
                                  <div>
                                    <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '2px', fontWeight: '600' }}>
                                      Found in Document/Section:
                                    </div>
                                    <div style={{ fontSize: '0.9rem', color: '#0B4778', fontWeight: '600' }}>
                                      {item.evidenceSection}
                                    </div>
                                  </div>
                                </div>
                              )}

                              {item.evidenceLocation && item.evidenceLocation !== 'Not found' && (
                                <div style={{
                                  padding: '8px 10px',
                                  background: '#EFF6FB',
                                  borderRadius: '4px',
                                  border: '1px solid #D9E8F6'
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                    <span style={{ fontSize: '0.9rem' }}>📄</span>
                                    <span style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: '600' }}>
                                      Page Number(s) - Click to view:
                                    </span>
                                  </div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                    {parsePageNumbers(item.evidenceLocation).map(pageNum => (
                                      <span
                                        key={pageNum}
                                        onClick={() => {
                                          window.dispatchEvent(new CustomEvent('navigate-to-page', {
                                            detail: { page: pageNum, pageOffset: 0 }
                                          }))
                                        }}
                                        style={{
                                          fontSize: '0.8rem',
                                          color: '#FFFFFF',
                                          background: '#3b82f6',
                                          padding: '3px 10px',
                                          borderRadius: '4px',
                                          fontWeight: '600',
                                          cursor: 'pointer',
                                          transition: 'all 0.2s ease'
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = '#2563eb'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(59, 130, 246, 0.5)' }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = '#3b82f6'; e.currentTarget.style.boxShadow = 'none' }}
                                        title={`View Page ${pageNum}`}
                                      >
                                        🔍 Page {pageNum}
                                      </span>
                                    ))}
                                    {parsePageNumbers(item.evidenceLocation).length === 0 && (
                                      <span style={{ fontSize: '0.85rem', color: '#64748b' }}>{item.evidenceLocation}</span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Evidence Text */}
                          <div style={{ marginBottom: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                              <strong style={{
                                color: isCompliant ? '#10b981' : '#ef4444',
                                fontSize: '0.9rem'
                              }}>
                                {isCompliant ? '✅ Evidence Found:' : isNA ? '⊘ Evidence:' : '❌ Evidence:'}
                              </strong>
                              <button
                                onClick={() => {
                                  let copyText = `Evidence:\n${item.evidence || 'Not found'}\n\n`
                                  if (item.evidenceSection && item.evidenceSection !== 'Not found') {
                                    copyText += `Found in: ${item.evidenceSection}\n`
                                  }
                                  if (item.evidenceLocation && item.evidenceLocation !== 'Not found') {
                                    copyText += `Page(s): ${item.evidenceLocation}\n`
                                  }
                                  navigator.clipboard.writeText(copyText.trim()).then(() => {
                                    alert('✅ Evidence with source & location copied to clipboard!')
                                  }).catch(() => {
                                    alert('❌ Failed to copy')
                                  })
                                }}
                                style={{
                                  padding: '4px 10px',
                                  background: '#3b82f6',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontSize: '0.75rem',
                                  fontWeight: '600'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = '#2563eb'}
                                onMouseLeave={(e) => e.currentTarget.style.background = '#3b82f6'}
                              >
                                📋 Copy
                              </button>
                            </div>
                            {renderEvidence(item.evidence)}
                          </div>

                          {/* Reasoning with Read + Copy buttons */}
                          {item.reasoning && item.reasoning !== 'No reasoning provided' && (
                            <div style={{
                              padding: '18px',
                              background: '#EFF6FB',
                              borderRadius: '8px',
                              borderLeft: `4px solid ${isCompliant ? '#10b981' : '#f59e0b'}`
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                <strong style={{ color: '#0B4778', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1rem' }}>
                                  <span style={{ fontSize: '1.2rem' }}>💡</span>
                                  <span>Reasoning:</span>
                                </strong>
                                <div style={{ display: 'flex', gap: '8px' }}>
                                  <button
                                    onClick={() => {
                                      if (isPlaying) {
                                        window.speechSynthesis.pause()
                                        setSpeechStatus(prev => ({ ...prev, [speechKey]: false }))
                                      } else {
                                        window.speechSynthesis.cancel()
                                        setSpeechStatus({})
                                        setTimeout(() => {
                                          const utterance = new SpeechSynthesisUtterance(item.reasoning)
                                          utterance.rate = 0.9
                                          utterance.pitch = 1
                                          utterance.volume = 1
                                          utterance.onend = () => setSpeechStatus(prev => ({ ...prev, [speechKey]: false }))
                                          window.speechSynthesis.speak(utterance)
                                          setSpeechStatus({ [speechKey]: true })
                                        }, 100)
                                      }
                                    }}
                                    style={{
                                      padding: '6px 12px',
                                      background: isPlaying ? '#f59e0b' : '#10b981',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      fontSize: '0.8rem',
                                      fontWeight: '600',
                                      transition: 'all 0.3s'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = isPlaying ? '#d97706' : '#059669'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = isPlaying ? '#f59e0b' : '#10b981'}
                                  >
                                    {isPlaying ? '⏸️ Pause' : '▶️ Read'}
                                  </button>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(item.reasoning).then(() => {
                                        alert('✅ Reasoning copied to clipboard!')
                                      }).catch(() => {
                                        alert('❌ Failed to copy')
                                      })
                                    }}
                                    style={{
                                      padding: '6px 12px',
                                      background: '#3b82f6',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      fontSize: '0.8rem',
                                      fontWeight: '600',
                                      transition: 'all 0.3s'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = '#2563eb'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = '#3b82f6'}
                                  >
                                    📋 Copy
                                  </button>
                                </div>
                              </div>
                              <p style={{
                                margin: 0,
                                fontSize: '0.95rem',
                                color: '#1e3a5f',
                                lineHeight: '1.8',
                                textAlign: 'justify'
                              }}>
                                {item.reasoning}
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {items.length === 0 && (
                  <p style={{ color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', padding: '20px' }}>
                    No items match the current filter in this section.
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default PrefundingReviewResults
