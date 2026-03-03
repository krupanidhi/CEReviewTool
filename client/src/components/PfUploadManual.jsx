import { useState, useEffect } from 'react'
import { uploadDocument } from '../services/api'
import { getPfRuleYears, loadPfRules, extractPfRules, savePfRules } from '../services/api'

export default function PfUploadManual({ onRulesLoaded }) {
  const [manualFile, setManualFile] = useState(null)
  const [manualYear, setManualYear] = useState(new Date().getFullYear().toString())
  const [availableYears, setAvailableYears] = useState([])
  const [activeRuleYear, setActiveRuleYear] = useState('')
  const [rules, setRules] = useState(null)
  const [processing, setProcessing] = useState(false)
  const [status, setStatus] = useState('')
  const [expandedChapters, setExpandedChapters] = useState({})
  const [showUploadForm, setShowUploadForm] = useState(false)

  useEffect(() => {
    loadAvailableYears()
  }, [])

  const loadAvailableYears = async () => {
    try {
      const res = await getPfRuleYears()
      if (res.success) {
        setAvailableYears(res.years)
        // Auto-load the latest year's rules
        if (res.years.length > 0) {
          const latest = res.years[res.years.length - 1]
          await handleLoadRules(latest.year)
        }
      }
    } catch (err) {
      console.log('Could not load PF rule years:', err.message)
    }
  }

  const handleLoadRules = async (year) => {
    try {
      const res = await loadPfRules(year)
      if (res.success) {
        setRules(res.rules)
        setActiveRuleYear(year)
        setShowUploadForm(false)
        setStatus('')
        if (onRulesLoaded) onRulesLoaded(res.rules, year)
      }
    } catch (err) {
      console.log('No rules found for year:', year)
    }
  }

  const handleUpload = async () => {
    if (!manualFile) return
    setProcessing(true)
    setStatus('📄 Uploading and extracting text from manual PDF...')

    try {
      const uploadResult = await uploadDocument(manualFile)
      if (!uploadResult.success) throw new Error('Failed to extract text from PDF')

      const extractedText = uploadResult.data?.pages?.map(p => p.text || '').join('\n\n') || ''
      if (!extractedText || extractedText.length < 500) {
        throw new Error('Extracted text is too short. Please ensure the PDF contains readable text.')
      }

      setStatus(`🤖 Extracting compliance rules from ${(extractedText.length / 1024).toFixed(0)}KB of text... (this may take 30-60 seconds)`)

      const shortYear = manualYear.toString().slice(-2)
      const result = await extractPfRules(extractedText, manualYear)

      if (result.success && result.rules?.length > 0) {
        setRules(result.rules)
        setActiveRuleYear(shortYear)
        setShowUploadForm(false)
        setStatus(`✅ Extracted ${result.rules.length} chapters from manual. Rules saved for ${manualYear}.`)
        if (onRulesLoaded) onRulesLoaded(result.rules, shortYear)
        await loadAvailableYears()
      } else {
        setStatus('⚠️ No compliance rules found in the document. Please check the PDF content.')
      }
    } catch (err) {
      setStatus(`❌ Error: ${err.message}`)
    } finally {
      setProcessing(false)
    }
  }

  const handleDragOver = (e) => { e.preventDefault(); e.currentTarget.style.borderColor = '#3b82f6' }
  const handleDragLeave = (e) => { e.currentTarget.style.borderColor = '#D9E8F6' }
  const handleDrop = (e) => {
    e.preventDefault()
    e.currentTarget.style.borderColor = '#D9E8F6'
    const file = e.dataTransfer.files[0]
    if (file && file.type === 'application/pdf') setManualFile(file)
  }

  // ── Year pills (reusable) ──
  const YearPills = ({ label }) => (
    availableYears.length > 0 ? (
      <div style={{ marginBottom: '20px', padding: '15px', background: '#EFF6FB', borderRadius: '8px', border: '1px solid #D9E8F6' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: '600', color: '#0B4778', marginBottom: '10px' }}>
          📂 {label}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {availableYears.map(y => (
            <button
              key={y.year}
              onClick={() => handleLoadRules(y.year)}
              style={{
                padding: '8px 16px',
                background: activeRuleYear === y.year ? '#0B4778' : 'white',
                color: activeRuleYear === y.year ? 'white' : '#0B4778',
                border: '2px solid #0B4778', borderRadius: '6px',
                cursor: 'pointer', fontWeight: '600', fontSize: '0.9rem',
                transition: 'all 0.2s'
              }}
            >
              {y.fullYear} ({y.chaptersCount} chapters)
            </button>
          ))}
        </div>
      </div>
    ) : null
  )

  // ══════════════════════════════════════════════════════════
  // VIEW: Upload Form (shown when no rules OR user clicks "Upload New")
  // ══════════════════════════════════════════════════════════
  if (!rules || showUploadForm) {
    return (
      <div style={{ padding: '20px 0' }}>
        <h2 style={{ color: '#0B4778', marginBottom: '4px' }}>Upload Guiding Principles Document</h2>
        <p style={{ color: '#0B4778', fontWeight: '600', fontSize: '0.95rem', margin: '0 0 16px 0' }}>Select Guidance Year</p>

        {/* Year Selection */}
        <div style={{ marginBottom: '20px' }}>
          <select
            value={manualYear}
            onChange={(e) => setManualYear(e.target.value)}
            style={{
              width: '100%', padding: '12px 16px', fontSize: '1rem',
              border: '2px solid #D9E8F6', borderRadius: '8px',
              background: 'white', color: '#0B4778', fontWeight: '600', cursor: 'pointer'
            }}
          >
            {Array.from({ length: new Date().getFullYear() - 2020 }, (_, i) => 2021 + i).map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
          <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '6px' }}>
            Rules will be saved to folder: <strong>pf-data/rules/{manualYear.toString().slice(-2)}/</strong>
          </p>
        </div>

        {/* Existing Rule Sets */}
        <YearPills label="Existing Rule Sets (click to load):" />

        {/* File Upload Drop Zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => document.getElementById('pf-manual-input').click()}
          style={{
            padding: '50px 20px', textAlign: 'center', cursor: 'pointer',
            border: '2px dashed #D9E8F6', borderRadius: '12px',
            background: '#f8fafc', marginBottom: '20px', transition: 'all 0.3s'
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '10px', opacity: 0.5 }}>📋</div>
          <h3 style={{ color: '#94a3b8', fontWeight: '600', marginBottom: '8px' }}>
            {manualFile ? manualFile.name : 'Drop PDF here or click to upload'}
          </h3>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
            Guiding Principles Document PDF for {manualYear}
          </p>
          <input
            id="pf-manual-input"
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files[0]
              if (file) setManualFile(file)
            }}
          />
        </div>

        {/* Extract Button */}
        <button
          onClick={handleUpload}
          disabled={!manualFile || processing}
          style={{
            width: '100%', padding: '14px', background: processing ? '#94a3b8' : '#3b82f6',
            color: 'white', border: 'none', borderRadius: '8px', fontSize: '1rem',
            fontWeight: '600', cursor: processing ? 'not-allowed' : 'pointer',
            transition: 'all 0.3s', marginBottom: '12px'
          }}
        >
          {processing ? '⏳ Processing...' : `Extract Compliance Rules (${manualYear})`}
        </button>

        {/* Warning / Status */}
        {status ? (
          <div style={{
            padding: '12px 16px',
            background: status.startsWith('❌') ? '#fef2f2' : '#EFF6FB',
            border: `1px solid ${status.startsWith('❌') ? '#fecaca' : '#D9E8F6'}`,
            borderRadius: '8px', color: status.startsWith('❌') ? '#dc2626' : '#0B4778',
            fontSize: '0.95rem'
          }}>
            {status}
          </div>
        ) : (
          <div style={{
            padding: '12px 16px', background: '#fef2f2',
            border: '2px solid #fca5a5', borderRadius: '8px',
            color: '#991b1b', fontSize: '0.9rem'
          }}>
            Upload a new guiding principles document to extract rules (previous rules will be overwritten)
          </div>
        )}

        {/* Back button if rules exist */}
        {rules && (
          <button
            onClick={() => { setShowUploadForm(false); setStatus('') }}
            style={{
              marginTop: '16px', padding: '10px 20px', background: '#0B4778',
              color: 'white', border: 'none', borderRadius: '8px',
              cursor: 'pointer', fontWeight: '600', fontSize: '0.9rem'
            }}
          >
            ← Back to Loaded Rules
          </button>
        )}
      </div>
    )
  }

  // ══════════════════════════════════════════════════════════
  // VIEW: Rules Loaded — show header + year pills + chapters
  // ══════════════════════════════════════════════════════════
  return (
    <div style={{ padding: '20px 0' }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ color: '#0B4778', margin: 0, fontSize: '1.4rem', fontWeight: '700' }}>
          ✅ Compliance Rules Loaded ({rules.length} Chapters)
          {activeRuleYear && (
            <span style={{ fontSize: '0.85rem', color: '#3b82f6', marginLeft: '10px' }}>
              — Year: 20{activeRuleYear}
            </span>
          )}
        </h2>
        <button
          onClick={() => {
            setManualFile(null)
            setShowUploadForm(true)
            setStatus('Upload a new guiding principles document to extract rules (previous rules will be overwritten)')
          }}
          style={{
            background: '#3b82f6', color: 'white', border: 'none',
            borderRadius: '8px', padding: '10px 20px', cursor: 'pointer',
            fontWeight: '600', fontSize: '0.9rem', whiteSpace: 'nowrap',
            transition: 'background 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#2563eb'}
          onMouseLeave={(e) => e.currentTarget.style.background = '#3b82f6'}
        >
          📤 Upload New Guiding Principles Document
        </button>
      </div>

      {/* Year pills */}
      <YearPills label="Available Rule Sets (click to switch):" />

      {/* Extracted chapters heading */}
      <h3 style={{ color: '#0B4778', marginBottom: '8px', fontSize: '1.15rem', fontWeight: '700' }}>
        ✅ Extracted Compliance Requirements ({rules.length} Chapters)
      </h3>
      <p style={{ marginBottom: '20px', color: '#64748b', fontSize: '0.95rem' }}>
        The following compliance chapters were extracted from the HRSA Compliance Manual and will be used to validate applications:
      </p>

      {/* Chapter list */}
      {rules.map((chapter, chapterIdx) => {
        const key = `ch-${chapterIdx}`
        const isExpanded = expandedChapters[key] || false

        return (
          <div key={chapterIdx} style={{ marginBottom: '12px', border: '1px solid #D9E8F6', borderRadius: '10px', background: 'white', overflow: 'hidden' }}>
            <button
              onClick={() => setExpandedChapters(prev => ({ ...prev, [key]: !isExpanded }))}
              style={{
                width: '100%', padding: '16px 20px', background: '#EFF6FB',
                border: 'none', borderBottom: isExpanded ? '1px solid #D9E8F6' : 'none',
                cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', transition: 'all 0.2s'
              }}
            >
              <h3 style={{ color: '#0B4778', margin: 0, fontSize: '1.05rem', fontWeight: '700', textAlign: 'left' }}>
                📋 {chapter.chapter || chapter.section}
              </h3>
              <span style={{ fontSize: '1.2rem', transition: 'transform 0.3s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', color: '#93c5fd' }}>▼</span>
            </button>

            {isExpanded && (
              <div style={{ padding: '16px 20px' }}>
                {chapter.authority && (
                  <div style={{ marginBottom: '16px', padding: '12px', background: '#EFF6FB', borderRadius: '6px', border: '1px solid #D9E8F6' }}>
                    <strong style={{ color: '#0B4778' }}>📜 Authority:</strong>
                    <p style={{ margin: '5px 0 0 0', fontSize: '0.9rem', color: '#1e3a5f' }}>{chapter.authority}</p>
                  </div>
                )}

                {chapter.elements?.map((element, elemIdx) => (
                  <div key={elemIdx} style={{ borderLeft: '4px solid #3b82f6', padding: '15px', marginBottom: '15px', background: 'white', borderRadius: '4px', border: '1px solid #D9E8F6' }}>
                    <strong style={{ color: '#3b82f6', fontSize: '1.05rem', display: 'block', marginBottom: '8px' }}>
                      {element.element || `Element ${elemIdx + 1}`}
                    </strong>
                    <p style={{ margin: '0 0 10px 0', lineHeight: '1.6', color: '#1e3a5f', fontSize: '0.95rem' }}>
                      {element.requirementText}
                    </p>

                    {element.requirementDetails?.length > 0 && (
                      <div style={{ marginBottom: '10px', padding: '10px', background: '#EFF6FB', borderRadius: '6px', border: '1px solid #D9E8F6' }}>
                        <strong style={{ color: '#0B4778', fontSize: '0.9rem' }}>📋 Must Address:</strong>
                        <ul style={{ margin: '8px 0 0 20px', lineHeight: '1.8' }}>
                          {element.requirementDetails.map((d, i) => (
                            <li key={i} style={{ fontSize: '0.9rem', color: '#1e3a5f', marginBottom: '4px' }}>{d}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {element.applicationSection && (
                      <div style={{ marginBottom: '10px', padding: '8px 10px', background: '#fff5c2', borderRadius: '6px', border: '1px solid #fee685' }}>
                        <strong style={{ color: '#565c65', fontSize: '0.85rem' }}>🔍 Application Section to Review:</strong>
                        <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#565c65' }}>{element.applicationSection}</p>
                      </div>
                    )}

                    {element.applicationItems?.length > 0 && (
                      <div style={{ padding: '8px 10px', background: '#e8f5e9', borderRadius: '6px', border: '1px solid #a5d6a7' }}>
                        <strong style={{ color: '#2e7d32', fontSize: '0.85rem' }}>✓ Items to Check:</strong>
                        <ul style={{ margin: '8px 0 0 20px', lineHeight: '1.8' }}>
                          {element.applicationItems.map((item, i) => (
                            <li key={i} style={{ fontSize: '0.85rem', color: '#1b5e20' }}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {element.footnotes && (
                      <div style={{ marginTop: '10px', padding: '8px 10px', background: '#fff5c2', fontSize: '0.85rem', color: '#565c65', border: '1px solid #fee685', borderRadius: '6px' }}>
                        <strong>ℹ️ Note:</strong> {element.footnotes}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
