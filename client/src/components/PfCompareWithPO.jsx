import { useState } from 'react'
import * as XLSX from 'xlsx'
import { parsePfManualReview } from '../services/api'

export default function PfCompareWithPO({ pfResults }) {
  const [manualReviewFile, setManualReviewFile] = useState(null)
  const [manualReviewElements, setManualReviewElements] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [status, setStatus] = useState('')
  const [comparisonData, setComparisonData] = useState(null)

  const PF_SECTIONS = [
    'Sliding Fee Discount Program', 'Key Management Staff',
    'Contracts and Subawards', 'Collaborative Relationships',
    'Billing and Collections', 'Budget',
    'Board Authority', 'Board Composition'
  ]

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    setManualReviewFile(file)
    setProcessing(true)
    setStatus('📄 Reading manual review file...')

    try {
      let content = ''

      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        // Parse Excel
        const data = await file.arrayBuffer()
        const workbook = XLSX.read(data)
        workbook.SheetNames.forEach(name => {
          const sheet = workbook.Sheets[name]
          content += `\n=== Sheet: ${name} ===\n`
          content += XLSX.utils.sheet_to_csv(sheet)
        })
      } else if (file.name.endsWith('.csv')) {
        content = await file.text()
      } else if (file.name.endsWith('.txt')) {
        content = await file.text()
      } else {
        throw new Error('Unsupported file format. Please upload .xlsx, .xls, .csv, or .txt')
      }

      if (!content || content.length < 50) {
        throw new Error('File appears to be empty or too short')
      }

      setStatus('🤖 Parsing manual review with AI...')
      const result = await parsePfManualReview(content)

      if (result.success && result.elements?.length > 0) {
        setManualReviewElements(result.elements)
        setStatus(`✅ Parsed ${result.elements.length} elements from manual review`)

        // Auto-compare if PF results are available
        if (pfResults?.results) {
          runComparison(result.elements, pfResults.results)
        }
      } else {
        setStatus('⚠️ Could not parse any elements from the file')
      }
    } catch (err) {
      setStatus(`❌ Error: ${err.message}`)
    } finally {
      setProcessing(false)
    }
  }

  const runComparison = (manualElements, aiResults) => {
    const comparison = []

    PF_SECTIONS.forEach(section => {
      const sectionResult = aiResults[section]
      if (!sectionResult) return

      const allAiItems = [
        ...(sectionResult.compliantItems || []).map(i => ({ ...i, aiStatus: 'COMPLIANT' })),
        ...(sectionResult.nonCompliantItems || []).map(i => ({ ...i, aiStatus: 'NON_COMPLIANT' })),
        ...(sectionResult.notApplicableItems || []).map(i => ({ ...i, aiStatus: 'NOT_APPLICABLE' }))
      ]

      // Find matching manual review elements for this section
      const sectionManual = manualElements.filter(m =>
        m.section?.toLowerCase().includes(section.toLowerCase()) ||
        section.toLowerCase().includes(m.section?.toLowerCase() || '')
      )

      allAiItems.forEach(aiItem => {
        // Try to find matching manual review element
        const elementLetter = aiItem.element?.match(/Element\s+([a-z])/i)?.[1]?.toLowerCase()
        const manualMatch = sectionManual.find(m =>
          m.letter?.toLowerCase() === elementLetter ||
          m.name?.toLowerCase().includes(aiItem.element?.toLowerCase().split(' - ')[1]?.trim() || '') ||
          aiItem.element?.toLowerCase().includes(m.name?.toLowerCase() || '')
        )

        // Normalize statuses for comparison
        const normalizeStatus = (s) => {
          if (!s) return 'UNKNOWN'
          const lower = s.toLowerCase()
          if (lower === 'yes' || lower === 'compliant') return 'COMPLIANT'
          if (lower === 'no' || lower === 'non_compliant' || lower === 'non-compliant') return 'NON_COMPLIANT'
          if (lower === 'not applicable' || lower === 'not_applicable' || lower === 'n/a') return 'NOT_APPLICABLE'
          return s.toUpperCase()
        }

        const aiNorm = normalizeStatus(aiItem.aiStatus)
        const poNorm = manualMatch ? normalizeStatus(manualMatch.status) : 'NOT_REVIEWED'
        const match = aiNorm === poNorm

        comparison.push({
          section,
          element: aiItem.element,
          aiStatus: aiNorm,
          poStatus: poNorm,
          match,
          aiEvidence: aiItem.evidence,
          aiReasoning: aiItem.reasoning,
          poComments: manualMatch?.comments || 'No PO review found for this element'
        })
      })
    })

    setComparisonData(comparison)
  }

  const hasResults = pfResults?.results
  const totalItems = comparisonData?.length || 0
  const matchCount = comparisonData?.filter(c => c.match).length || 0
  const mismatchCount = totalItems - matchCount
  const agreementRate = totalItems > 0 ? ((matchCount / totalItems) * 100).toFixed(1) : 0

  return (
    <div style={{ padding: '20px 0' }}>
      <h2 style={{ color: '#0B4778', marginBottom: '20px' }}>Compare with Project Officer Review</h2>

      {!hasResults && (
        <div style={{
          padding: '20px', background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: '10px', marginBottom: '20px', textAlign: 'center'
        }}>
          <p style={{ color: '#dc2626', fontWeight: '600', fontSize: '1rem', margin: 0 }}>
            ⚠️ Please run an application analysis first (Step 2) to generate AI results before comparing
          </p>
        </div>
      )}

      {/* Upload Manual Review */}
      <div style={{ marginBottom: '30px' }}>
        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', color: '#0B4778', fontSize: '1rem' }}>
          Upload Project Officer's Manual Review
        </label>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '12px' }}>
          Supported formats: Excel (.xlsx, .xls), CSV (.csv), or Text (.txt)
        </p>
        <div
          onClick={() => document.getElementById('pf-po-review-input').click()}
          style={{
            padding: '30px 20px', textAlign: 'center',
            cursor: hasResults ? 'pointer' : 'not-allowed',
            border: '2px dashed #D9E8F6', borderRadius: '12px',
            background: hasResults ? '#f8fafc' : '#f1f5f9',
            opacity: hasResults ? 1 : 0.6, transition: 'all 0.3s'
          }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '8px' }}>📊</div>
          <h3 style={{ color: '#0B4778', fontWeight: '600', marginBottom: '6px', fontSize: '1rem' }}>
            {manualReviewFile ? manualReviewFile.name : 'Click to upload PO review file'}
          </h3>
          <input
            id="pf-po-review-input"
            type="file"
            accept=".xlsx,.xls,.csv,.txt"
            style={{ display: 'none' }}
            disabled={!hasResults}
            onChange={handleFileUpload}
          />
        </div>
      </div>

      {/* Status */}
      {status && (
        <div style={{
          marginBottom: '20px', padding: '12px 16px',
          background: status.startsWith('❌') ? '#fef2f2' : '#EFF6FB',
          border: `1px solid ${status.startsWith('❌') ? '#fecaca' : '#D9E8F6'}`,
          borderRadius: '8px', color: status.startsWith('❌') ? '#dc2626' : '#0B4778'
        }}>
          {processing && '⏳ '}{status}
        </div>
      )}

      {/* Comparison Results */}
      {comparisonData && (
        <>
          {/* Summary Stats */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '16px', marginBottom: '30px'
          }}>
            <div style={{ background: '#EFF6FB', border: '2px solid #3b82f6', borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#3b82f6' }}>{totalItems}</div>
              <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Total Compared</div>
            </div>
            <div style={{ background: '#f0fdf4', border: '2px solid #10b981', borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#10b981' }}>{matchCount}</div>
              <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Agreement</div>
            </div>
            <div style={{ background: '#fef2f2', border: '2px solid #ef4444', borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#ef4444' }}>{mismatchCount}</div>
              <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Disagreement</div>
            </div>
            <div style={{
              background: '#fefce8',
              border: `2px solid ${agreementRate >= 80 ? '#10b981' : agreementRate >= 50 ? '#f59e0b' : '#ef4444'}`,
              borderRadius: '12px', padding: '16px', textAlign: 'center'
            }}>
              <div style={{
                fontSize: '2rem', fontWeight: 'bold',
                color: agreementRate >= 80 ? '#10b981' : agreementRate >= 50 ? '#f59e0b' : '#ef4444'
              }}>
                {agreementRate}%
              </div>
              <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: '500' }}>Agreement Rate</div>
            </div>
          </div>

          {/* Comparison Table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ background: '#0B4778', color: 'white' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', borderRadius: '8px 0 0 0' }}>Section</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left' }}>Element</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center' }}>AI Result</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center' }}>PO Result</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', borderRadius: '0 8px 0 0' }}>Match</th>
                </tr>
              </thead>
              <tbody>
                {comparisonData.map((row, idx) => {
                  const statusBadge = (status) => {
                    const colors = {
                      'COMPLIANT': { bg: '#dcfce7', color: '#16a34a', text: '✅ Compliant' },
                      'NON_COMPLIANT': { bg: '#fef2f2', color: '#dc2626', text: '❌ Non-Compliant' },
                      'NOT_APPLICABLE': { bg: '#f1f5f9', color: '#64748b', text: '⊘ N/A' },
                      'NOT_REVIEWED': { bg: '#fefce8', color: '#d97706', text: '⚠️ Not Found' }
                    }
                    const c = colors[status] || { bg: '#f1f5f9', color: '#64748b', text: status }
                    return (
                      <span style={{
                        padding: '4px 10px', borderRadius: '20px', fontSize: '0.75rem',
                        fontWeight: '600', background: c.bg, color: c.color, whiteSpace: 'nowrap'
                      }}>
                        {c.text}
                      </span>
                    )
                  }

                  return (
                    <tr key={idx} style={{
                      background: idx % 2 === 0 ? '#FFFFFF' : '#f8fafc',
                      borderBottom: '1px solid #e2e8f0'
                    }}>
                      <td style={{ padding: '10px 16px', color: '#0B4778', fontWeight: '500', fontSize: '0.85rem' }}>
                        {row.section}
                      </td>
                      <td style={{ padding: '10px 16px', color: '#1e3a5f', maxWidth: '250px' }}>
                        {row.element}
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        {statusBadge(row.aiStatus)}
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        {statusBadge(row.poStatus)}
                      </td>
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        <span style={{
                          fontSize: '1.2rem',
                          color: row.match ? '#10b981' : row.poStatus === 'NOT_REVIEWED' ? '#d97706' : '#ef4444'
                        }}>
                          {row.match ? '✅' : row.poStatus === 'NOT_REVIEWED' ? '⚠️' : '❌'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Disagreement Details */}
          {mismatchCount > 0 && (
            <div style={{ marginTop: '30px' }}>
              <h3 style={{ color: '#dc2626', marginBottom: '16px' }}>
                ❌ Disagreements ({mismatchCount})
              </h3>
              {comparisonData.filter(c => !c.match && c.poStatus !== 'NOT_REVIEWED').map((row, idx) => (
                <div key={idx} style={{
                  marginBottom: '16px', padding: '16px', background: '#fef2f2',
                  border: '1px solid #fecaca', borderRadius: '10px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <strong style={{ color: '#0B4778', fontSize: '1rem' }}>{row.element}</strong>
                    <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{row.section}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ padding: '10px', background: '#FFFFFF', borderRadius: '6px', border: '1px solid #D9E8F6' }}>
                      <div style={{ fontSize: '0.8rem', color: '#3b82f6', fontWeight: '600', marginBottom: '6px' }}>🤖 AI Result: {row.aiStatus}</div>
                      <p style={{ margin: 0, fontSize: '0.85rem', color: '#1e3a5f', lineHeight: '1.5' }}>
                        {row.aiReasoning || 'No reasoning provided'}
                      </p>
                    </div>
                    <div style={{ padding: '10px', background: '#FFFFFF', borderRadius: '6px', border: '1px solid #D9E8F6' }}>
                      <div style={{ fontSize: '0.8rem', color: '#f59e0b', fontWeight: '600', marginBottom: '6px' }}>👤 PO Result: {row.poStatus}</div>
                      <p style={{ margin: 0, fontSize: '0.85rem', color: '#1e3a5f', lineHeight: '1.5' }}>
                        {row.poComments || 'No comments'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
