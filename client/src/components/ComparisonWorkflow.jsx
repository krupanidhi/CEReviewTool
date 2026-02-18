import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowRight, GitCompare, Loader2 } from 'lucide-react'
import EnhancedComparisonUpload from './EnhancedComparisonUpload'
import ChecklistSelector from './ChecklistSelector'
import { compareDocuments, saveProcessedApplication, runStandardComparison, runQAComparison, saveLogsToServer } from '../services/api'

export default function ComparisonWorkflow({ onComparisonComplete, cachedDocs, onDocumentsUploaded, onLog }) {
  const [step, setStep] = useState(cachedDocs ? 2 : 1)
  const [uploadedDocs, setUploadedDocs] = useState(cachedDocs)
  const [selectedSections, setSelectedSections] = useState([])
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState(null)
  const [reviewMode, setReviewMode] = useState('checklist') // 'checklist' | 'compliance' | 'both'

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

  const [progress, setProgress] = useState({ current: 0, total: 0, currentSection: '', indeterminate: false })

  const workflowLogsRef = useRef([])

  const log = useCallback((level, message, data = null) => {
    const entry = { timestamp: new Date().toISOString(), level, message, data }
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${level.toUpperCase()}] ${message}`, data || '')
    workflowLogsRef.current.push(entry)
    if (onLog) onLog(entry)
  }, [onLog])

  const handleCompare = async () => {
    setComparing(true)
    setError(null)
    workflowLogsRef.current = []
    const workflowStart = performance.now()

    try {
      const applications = uploadedDocs.applications
      const checklists = uploadedDocs.checklists

      log('info', '===== COMPLIANCE COMPARISON START =====')
      log('info', `Selected sections: ${selectedSections.length}`, selectedSections.map(s => s.sectionTitle))

      const results = []

      const runCompliance = reviewMode === 'compliance' || reviewMode === 'both'
      const runChecklist = reviewMode === 'checklist' || reviewMode === 'both'
      log('info', `Review mode: ${reviewMode} (compliance: ${runCompliance}, checklist: ${runChecklist})`)

      for (const application of applications) {
        const applicationData = application.analysis?.data || application.data
        log('info', `Application: ${application.originalName || application.name}`)

        for (const checklist of checklists) {
          const checklistData = checklist.analysis?.data || checklist.data
          log('info', `Checklist: ${checklist.name}`)

          // Filter to only selected main sections
          const selectedTitles = selectedSections
            .filter(s => s.checklistId === checklist.id)
            .map(s => s.sectionTitle)

          // Extract section numbers from selected titles (e.g., "3" from "3. Completing..." or "4 Submission")
          const selectedSectionNumbers = selectedTitles.map(title => {
            const match = title.match(/^(\d+)/)
            return match ? match[1] : null
          }).filter(Boolean)

          log('info', `Extracted section numbers: ${selectedSectionNumbers.join(', ')}`)

          // ---- COMPLIANCE REPORT ----
          let allChunkSections = []
          let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
          let dedupedSections = []
          let overallCompliance = 0
          let singleCallSuccess = false

         if (runCompliance) {
          // Step 1: Collect ALL sections under selected main numbers
          const allSelectedSections = checklistData.sections?.filter(section => {
            const sectionTitle = section.title || ''
            return selectedSectionNumbers.some(num => {
              return sectionTitle.startsWith(`${num}.`) || sectionTitle.startsWith(`${num} `) || sectionTitle === `${num}`
            })
          }) || []

          // Step 2: Identify LEAF sections — sections that have no children
          const allTitles = allSelectedSections.map(s => s.title || '')
          const leafSections = allSelectedSections.filter(section => {
            const title = section.title || ''
            const match = title.match(/^(\d+(?:\.\d+)*)/)
            if (!match) return true
            const sectionNum = match[1]
            const hasChildren = allTitles.some(t => {
              if (t === title) return false
              const tMatch = t.match(/^(\d+(?:\.\d+)*)/)
              if (!tMatch) return false
              return tMatch[1].startsWith(sectionNum + '.')
            })
            return !hasChildren
          })

          log('info', `Total sections: ${allSelectedSections.length}, Leaf sections: ${leafSections.length} (skipping ${allSelectedSections.length - leafSections.length} parent/informational)`)

          // Step 3: Try SINGLE API call with ALL leaf sections (fast path)
          const allSectionsChecklistData = {
            ...checklistData,
            sections: leafSections,
            tableOfContents: checklistData.tableOfContents || [],
            content: leafSections
              .map(section => {
                const sectionText = section.content?.map(c => c.text).join('\n') || ''
                return `\n=== ${section.title} ===\n${sectionText}`
              })
              .join('\n\n'),
            selectedSectionNumbers: selectedSectionNumbers
          }

          setProgress({ current: 0, total: 1, currentSection: 'Compliance Analysis — processing all sections...', indeterminate: true })
          log('info', `Sending ALL ${leafSections.length} leaf sections in ONE API call...`)

          singleCallSuccess = false
          const singleCallStart = performance.now()

          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              log('info', `  Single-call attempt ${attempt}/2...`)
              setProgress({ current: 0, total: 1, currentSection: `Compliance Analysis (attempt ${attempt}) — AI is reviewing ${leafSections.length} sections...`, indeterminate: true })
              const singleResult = await compareDocuments(applicationData, allSectionsChecklistData)
              const singleElapsed = ((performance.now() - singleCallStart) / 1000).toFixed(1)

              if (singleResult && singleResult.comparison?.sections?.length > 0) {
                allChunkSections = singleResult.comparison.sections
                if (singleResult.usage) {
                  totalUsage.promptTokens = singleResult.usage.promptTokens || 0
                  totalUsage.completionTokens = singleResult.usage.completionTokens || 0
                  totalUsage.totalTokens = singleResult.usage.totalTokens || 0
                }
                singleCallSuccess = true
                setProgress({ current: 1, total: 1, currentSection: 'Compliance Analysis complete', indeterminate: false })
                log('info', `  ✅ Single-call completed: ${allChunkSections.length} sections in ${singleElapsed}s`)
                break
              } else {
                log('warn', `  ⚠️ Single-call returned empty results, attempt ${attempt}`)
              }
            } catch (err) {
              log('warn', `  ⚠️ Single-call attempt ${attempt} failed: ${err.message}`)
              if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 3000))
              }
            }
          }

          // Fallback: chunked sequential processing if single call failed
          if (!singleCallSuccess) {
            log('info', 'Falling back to chunked sequential processing...')

            const chunkGroups = {}
            leafSections.forEach(section => {
              const title = section.title || ''
              const match = title.match(/^(\d+)\.(\d+)/)
              const groupKey = match ? `${match[1]}.${match[2]}` : title.match(/^(\d+)/) ? title.match(/^(\d+)/)[1] : 'other'
              if (!chunkGroups[groupKey]) chunkGroups[groupKey] = []
              chunkGroups[groupKey].push(section)
            })

            const sortedKeys = Object.keys(chunkGroups).sort((a, b) => {
              const aParts = a.split('.').map(Number)
              const bParts = b.split('.').map(Number)
              for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const aVal = aParts[i] || 0
                const bVal = bParts[i] || 0
                if (aVal !== bVal) return aVal - bVal
              }
              return 0
            })

            const chunks = sortedKeys.map(groupKey => ({
              label: `Section ${groupKey}`,
              specificSections: chunkGroups[groupKey],
              subKey: groupKey
            }))

            setProgress({ current: 0, total: chunks.length, currentSection: '', indeterminate: false })
            log('info', `Processing ${chunks.length} section chunks sequentially (fallback)`)

            for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
              const chunk = chunks[chunkIdx]
              const chunkStart = performance.now()
              setProgress({ current: chunkIdx + 1, total: chunks.length, currentSection: chunk.label, indeterminate: false })
              log('info', `Chunk ${chunkIdx + 1}/${chunks.length}: ${chunk.label} (${chunk.specificSections.length} subsections)`)

              const chunkChecklistData = {
                ...checklistData,
                sections: chunk.specificSections,
                tableOfContents: checklistData.tableOfContents?.filter(toc => {
                  const tocTitle = toc.title || ''
                  return tocTitle.startsWith(chunk.subKey)
                }) || [],
                content: chunk.specificSections
                  .map(section => {
                    const sectionText = section.content?.map(c => c.text).join('\n') || ''
                    return `\n=== ${section.title} ===\n${sectionText}`
                  })
                  .join('\n\n'),
                selectedSectionNumbers: [chunk.subKey]
              }

              const MAX_RETRIES = 3
              let lastError = null
              let chunkResult = null

              for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                  log('info', `  Attempt ${attempt}/${MAX_RETRIES} for ${chunk.label}`)
                  chunkResult = await compareDocuments(applicationData, chunkChecklistData)
                  const chunkElapsed = ((performance.now() - chunkStart) / 1000).toFixed(1)
                  log('info', `  ✅ ${chunk.label} completed: ${chunkResult.comparison?.sections?.length || 0} sections in ${chunkElapsed}s`)
                  break
                } catch (err) {
                  lastError = err
                  log('warn', `  ⚠️ Attempt ${attempt} failed for ${chunk.label}: ${err.message}`)
                  if (attempt < MAX_RETRIES) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
                    log('info', `  Retrying in ${delay / 1000}s...`)
                    await new Promise(resolve => setTimeout(resolve, delay))
                  }
                }
              }

              if (chunkResult && chunkResult.comparison?.sections) {
                allChunkSections.push(...chunkResult.comparison.sections)
                if (chunkResult.usage) {
                  totalUsage.promptTokens += chunkResult.usage.promptTokens || 0
                  totalUsage.completionTokens += chunkResult.usage.completionTokens || 0
                  totalUsage.totalTokens += chunkResult.usage.totalTokens || 0
                }
              } else {
                log('error', `  ❌ All ${MAX_RETRIES} attempts failed for ${chunk.label}: ${lastError?.message}`)
                allChunkSections.push({
                  checklistSection: chunk.label,
                  requirement: 'Processing failed for this section group',
                  status: 'not_met',
                  applicationSection: '',
                  pageReferences: [],
                  evidence: '',
                  explanation: `Failed after ${MAX_RETRIES} attempts: ${lastError?.message || 'Unknown error'}. You can re-run this section individually.`,
                  recommendation: 'Re-run comparison for this section group individually.',
                  missingFields: []
                })
              }
            }
          }

          // Filter AI response sections: keep only sections that match leaf titles we sent.
          // AI may return extra items (numbered instructions, merged sections, etc.)
          const leafTitleSet = new Set(leafSections.map(s => (s.title || '').trim().toLowerCase()))
          const leafNumberSet = new Set(leafSections.map(s => {
            const m = (s.title || '').match(/^(\d+(?:\.\d+)*)/)
            return m ? m[1] : null
          }).filter(Boolean))

          const filteredSections = allChunkSections.filter(section => {
            const title = (section.checklistSection || '').trim()
            if (!title) return false
            // Direct title match
            if (leafTitleSet.has(title.toLowerCase())) return true
            // Match by section number (e.g., AI returns "3.1.1.1" and we have "3.1.1.1 Completing...")
            const numMatch = title.match(/^(\d+(?:\.\d+)*)/)
            if (numMatch && leafNumberSet.has(numMatch[1])) return true
            // Check if any leaf title starts with this section's number
            if (numMatch) {
              for (const leafNum of leafNumberSet) {
                if (leafNum.startsWith(numMatch[1] + '.') || leafNum === numMatch[1]) return true
              }
            }
            return false
          })
          if (filteredSections.length < allChunkSections.length) {
            log('warn', `Filtered junk sections: ${allChunkSections.length} → ${filteredSections.length} (removed ${allChunkSections.length - filteredSections.length} non-section items)`)
          }

          // Deduplicate sections by checklistSection title — AI sometimes returns duplicates
          const seenSections = new Map()
          filteredSections.forEach(section => {
            const key = (section.checklistSection || '').trim().toLowerCase()
            if (!key) return
            const existing = seenSections.get(key)
            if (!existing || (section.evidence || '').length > (existing.evidence || '').length) {
              seenSections.set(key, section)
            }
          })
          dedupedSections = [...seenSections.values()]
          if (dedupedSections.length < filteredSections.length) {
            log('warn', `Deduplicated: ${filteredSections.length} → ${dedupedSections.length} sections (removed ${filteredSections.length - dedupedSections.length} duplicates)`)
          }

          // Merge all chunk results
          const complianceElapsed = ((performance.now() - workflowStart) / 1000).toFixed(1)
          const applicableSections = dedupedSections.filter(s => s.status !== 'not_applicable')
          const metSections = applicableSections.filter(s => s.status === 'met')
          overallCompliance = applicableSections.length > 0
            ? Math.round((metSections.length / applicableSections.length) * 100)
            : 0

          log('info', `✅ Compliance complete: ${allChunkSections.length} sections, ${overallCompliance}% compliance in ${complianceElapsed}s`)
          log('info', `Token usage — prompt: ${totalUsage.promptTokens}, completion: ${totalUsage.completionTokens}, total: ${totalUsage.totalTokens}`)
         } else {
          log('info', 'Skipping Compliance Report (reviewMode: ' + reviewMode + ')')
         }

          // ---- CHECKLIST COMPARISON ----
          let checklistComparisonResults = null
         if (runChecklist) {
          try {
            setProgress({ current: 0, total: 2, currentSection: 'Checklist Comparison — AI is analyzing both sections in parallel...', indeterminate: true })
            log('info', '===== CHECKLIST COMPARISON =====')
            const qaStart = performance.now()

            // Run in parallel for speed, track completion with counter
            let qaCompleted = 0
            const [stdResult, psqResult] = await Promise.all([
              runStandardComparison(applicationData).then(r => {
                qaCompleted++
                setProgress({ current: qaCompleted, total: 2, currentSection: qaCompleted < 2 ? 'Checklist Comparison — waiting for remaining...' : 'Checklist Comparison Complete', indeterminate: qaCompleted < 2 })
                return r
              }).catch(err => {
                log('warn', `Standard comparison failed: ${err.message}`)
                qaCompleted++
                setProgress({ current: qaCompleted, total: 2, currentSection: qaCompleted < 2 ? 'Checklist Comparison — waiting for remaining...' : 'Checklist Comparison Complete', indeterminate: qaCompleted < 2 })
                return null
              }),
              runQAComparison(applicationData).then(r => {
                qaCompleted++
                setProgress({ current: qaCompleted, total: 2, currentSection: qaCompleted < 2 ? 'Checklist Comparison — waiting for remaining...' : 'Checklist Comparison Complete', indeterminate: qaCompleted < 2 })
                return r
              }).catch(err => {
                log('warn', `Program-specific comparison failed: ${err.message}`)
                qaCompleted++
                setProgress({ current: qaCompleted, total: 2, currentSection: qaCompleted < 2 ? 'Checklist Comparison — waiting for remaining...' : 'Checklist Comparison Complete', indeterminate: qaCompleted < 2 })
                return null
              })
            ])

            const qaElapsed = ((performance.now() - qaStart) / 1000).toFixed(1)
            log('info', `✅ Checklist comparison complete in ${qaElapsed}s`)
            if (stdResult) log('info', `  Standard: ${stdResult.summary?.agreementRate || 0}% agreement`)
            if (psqResult) log('info', `  Program-specific: ${psqResult.summary?.agreementRate || 0}% agreement`)

            checklistComparisonResults = { standard: stdResult, programSpecific: psqResult }
          } catch (qaErr) {
            log('error', `Checklist comparison error: ${qaErr.message}`)
          }
         } else {
          log('info', 'Skipping Checklist Comparison (reviewMode: ' + reviewMode + ')')
         }

          const processingMode = !runCompliance ? 'checklist-only' : singleCallSuccess ? 'single-call' : 'chunked-fallback'
          const mergedResult = {
            success: true,
            comparison: {
              overallCompliance,
              applicationInfo: dedupedSections[0]?.applicationInfo || {},
              summary: `Compliance analysis completed (${processingMode}) with ${dedupedSections.length} total validation entries.`,
              sections: dedupedSections,
              criticalIssues: dedupedSections
                .filter(s => s.status === 'not_met')
                .map(s => `${s.checklistSection}: ${s.requirement}`),
              recommendations: dedupedSections
                .filter(s => s.recommendation && s.status !== 'met')
                .map(s => s.recommendation)
            },
            checklistComparison: checklistComparisonResults,
            usage: totalUsage,
            metadata: {
              model: processingMode,
              comparedAt: new Date().toISOString(),
              leafSections: runCompliance ? leafSections.length : 0,
              totalSections: dedupedSections.length,
              rawSections: allChunkSections.length,
              duplicatesRemoved: allChunkSections.length - dedupedSections.length
            }
          }

          results.push({
            ...mergedResult,
            applicationDoc: application,
            checklistDoc: checklist,
            selectedSections: selectedSections.filter(s => s.checklistId === checklist.id)
          })
        }
      }

      const totalElapsed = ((performance.now() - workflowStart) / 1000).toFixed(1)
      log('info', `===== WORKFLOW COMPLETE in ${totalElapsed}s =====`)

      if (onComparisonComplete) {
        onComparisonComplete({
          results,
          applications: uploadedDocs.applications,
          checklists: uploadedDocs.checklists,
          selectedSections
        })
      }

      // Save completed results to processed-applications for dashboard caching
      try {
        const checklist = uploadedDocs.checklists[0]
        const checklistName = checklist.originalName || checklist.name
        for (let i = 0; i < results.length; i++) {
          const appObj = uploadedDocs.applications[i]
          const appName = appObj?.originalName || appObj?.name || `Application ${i + 1}`
          const applicationId = appObj?.id || null
          const { applicationDoc, checklistDoc, selectedSections: selSections, ...cleanResult } = results[i]
          await saveProcessedApplication(appName, checklistName, cleanResult, selectedSections, applicationId)
        }
        log('info', 'Results cached to dashboard')
      } catch (saveErr) {
        log('warn', `Could not save to dashboard cache: ${saveErr.message}`)
      }

      setStep(3)
    } catch (err) {
      log('error', `Comparison failed: ${err.message}`)
      setError(`Comparison failed: ${err.message}`)
    } finally {
      setComparing(false)
      setProgress({ current: 0, total: 0, currentSection: '', indeterminate: false })
      // Save logs to server as text file
      if (workflowLogsRef.current.length > 0) {
        saveLogsToServer(workflowLogsRef.current, new Date().toISOString().replace(/[:.]/g, '-')).catch(() => {})
      }
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
          {/* Review Mode Selection */}
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <label className="block text-sm font-medium text-gray-300 mb-3">Review Type</label>
            <div className="flex space-x-3">
              {[
                { value: 'checklist', label: 'Checklist Comparison', desc: 'Fast — Q&A analysis only' },
                { value: 'compliance', label: 'Compliance Report', desc: 'Detailed section-by-section review' },
                { value: 'both', label: 'Both', desc: 'Full analysis (takes longer)' }
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setReviewMode(opt.value)}
                  className={`flex-1 p-3 rounded-lg border text-left transition-colors ${
                    reviewMode === opt.value
                      ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                      : 'border-slate-600 bg-slate-700/50 text-gray-400 hover:border-slate-500'
                  }`}
                >
                  <div className="font-medium text-sm">{opt.label}</div>
                  <div className="text-xs mt-1 opacity-70">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <ChecklistSelector 
            checklists={uploadedDocs.checklists}
            onSelectionChange={handleSelectionChange}
          />

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400">
              {error}
            </div>
          )}

          {comparing && progress.total > 0 && (
            <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-300">
                  {progress.currentSection}
                </span>
                <span className="text-sm text-gray-400">
                  {progress.indeterminate
                    ? `${progress.current} / ${progress.total} section groups`
                    : `${progress.current} / ${progress.total} section groups — ${Math.round((progress.current / progress.total) * 100)}%`}
                </span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-2.5 overflow-hidden">
                {progress.indeterminate ? (
                  <div className="bg-purple-600 h-2.5 rounded-full animate-pulse" style={{ width: '100%', opacity: 0.6 }} />
                ) : (
                  <div
                    className="bg-purple-600 h-2.5 rounded-full transition-all duration-500"
                    style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                  />
                )}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {progress.indeterminate
                  ? 'AI is processing — this may take 1-3 minutes depending on application size.'
                  : 'Each section group is processed separately with automatic retry to ensure 100% completion.'}
              </p>
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
                  <span>
                    {progress.total > 0
                      ? progress.indeterminate
                        ? `Processing (${progress.current}/${progress.total})...`
                        : `Processing (${progress.current}/${progress.total}) ${Math.round((progress.current / progress.total) * 100)}%`
                      : 'Preparing...'}
                  </span>
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
