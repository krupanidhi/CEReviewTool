import { useState, useEffect, useRef } from 'react'
import {
  XCircle, AlertTriangle, Loader2, Download,
  ChevronDown, ChevronUp, Play, FileText, RefreshCw, ClipboardList, ShieldCheck
} from 'lucide-react'
import {
  getQAQuestions, runQAComparison, getStandardQuestions, runStandardComparison
} from '../services/api'
import { downloadExcelReport, downloadWordReport } from '../utils/reportGenerator'

function AnswerBadge({ answer }) {
  const v = (answer || '').toLowerCase()
  const cls = v === 'yes' ? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/40'
    : v === 'no' ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/40'
    : v === 'n/a' ? 'bg-gray-500/20 text-gray-400 ring-1 ring-gray-500/40'
    : 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/40'
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{answer || 'N/A'}</span>
}

function ConfBadge({ c }) {
  const cls = c === 'high' ? 'bg-blue-500/20 text-blue-400' : c === 'medium' ? 'bg-purple-500/20 text-purple-400' : 'bg-gray-500/20 text-gray-400'
  return <span className={`px-2 py-0.5 rounded-full text-xs ${cls}`}>{c || 'low'}</span>
}

function SummaryCards({ summary }) {
  if (!summary) return null
  const yesCount = summary.yesCount || 0
  const noCount = summary.noCount || 0
  const naCount = summary.naCount || 0
  return (
    <div className="grid grid-cols-4 gap-3">
      {[
        { v: summary.totalQuestions, l: 'Questions', c: 'text-blue-400' },
        { v: yesCount, l: 'Yes', c: 'text-green-400' },
        { v: noCount, l: 'No', c: 'text-red-400' },
        { v: naCount, l: 'N/A', c: 'text-gray-400' },
      ].map((d, i) => (
        <div key={i} className="bg-slate-900 rounded-lg p-3 border border-slate-700 text-center">
          <div className={`text-2xl font-bold ${d.c}`}>{d.v}</div>
          <div className="text-xs text-gray-500">{d.l}</div>
        </div>
      ))}
    </div>
  )
}

function ResultsTable({ results, filter, setFilter, expanded, toggle, pageOffset = 0 }) {
  const answerCounts = { yes: results.filter(r => (r.aiAnswer || '').toLowerCase() === 'yes').length, no: results.filter(r => (r.aiAnswer || '').toLowerCase() === 'no').length, na: results.filter(r => (r.aiAnswer || '').toLowerCase() === 'n/a').length }
  const filtered = filter === 'all' ? results
    : filter === 'yes' ? results.filter(r => (r.aiAnswer || '').toLowerCase() === 'yes')
    : filter === 'no' ? results.filter(r => (r.aiAnswer || '').toLowerCase() === 'no')
    : results.filter(r => { const v = (r.aiAnswer || '').toLowerCase(); return v !== 'yes' && v !== 'no' })
  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-700 flex items-center justify-between">
        <span className="text-sm text-gray-400">{filtered.length} results</span>
        <div className="flex space-x-1.5">
          {['all', 'yes', 'no', 'other'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${filter === f ? (f === 'yes' ? 'bg-green-500/30 text-green-400 ring-1 ring-green-500/50' : f === 'no' ? 'bg-red-500/30 text-red-400 ring-1 ring-red-500/50' : f === 'other' ? 'bg-yellow-500/30 text-yellow-400 ring-1 ring-yellow-500/50' : 'bg-blue-500/30 text-blue-400 ring-1 ring-blue-500/50') : 'bg-slate-700 text-gray-400 hover:bg-slate-600'}`}>
              {f === 'all' ? `All (${results.length})` : f === 'yes' ? `Yes (${answerCounts.yes})` : f === 'no' ? `No (${answerCounts.no})` : `N/A & Other (${answerCounts.na + (results.length - answerCounts.yes - answerCounts.no - answerCounts.na)})`}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-slate-900/50 text-xs font-medium text-gray-500 uppercase border-b border-slate-700">
        <div className="col-span-1">#</div><div className="col-span-5">Question</div>
        <div className="col-span-2 text-center">AI Answer</div>
        <div className="col-span-3">Evidence</div><div className="col-span-1"></div>
      </div>
      <div className="divide-y divide-slate-700/50">
        {filtered.map((r, idx) => {
          const key = `${r.questionNumber}-${idx}`
          const open = expanded[key]
          return (
            <div key={key}>
              <div className="grid grid-cols-12 gap-2 px-4 py-2.5 items-center cursor-pointer hover:bg-slate-700/30" onClick={() => toggle(key)}>
                <div className="col-span-1 text-sm font-bold text-blue-400">Q{r.questionNumber}</div>
                <div className="col-span-5 text-sm text-gray-300 truncate">{r.question}</div>
                <div className="col-span-2 flex justify-center"><AnswerBadge answer={r.aiAnswer} /></div>
                <div className="col-span-3 text-xs text-gray-500 truncate">{r.evidence || '—'}</div>
                <div className="col-span-1 flex items-center justify-center space-x-1">
                  <ConfBadge c={r.confidence} />
                  {open ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
                </div>
              </div>
              {open && (
                <div className="px-4 pb-3 bg-slate-900/30 space-y-2 pt-2">
                  <div className="bg-slate-800/50 rounded p-2.5 border border-slate-700">
                    <span className="text-xs text-gray-500 uppercase block mb-1">Full Question</span>
                    <p className="text-sm text-gray-300">{r.question}</p>
                    {r.suggestedResources && <p className="text-xs text-blue-400 mt-1">Suggested Resources: {r.suggestedResources}</p>}
                  </div>
                  {r.evidence && <div className="bg-slate-800/50 rounded p-2.5 border border-slate-700"><span className="text-xs text-gray-500 uppercase block mb-1">Evidence</span><p className="text-sm text-gray-300 whitespace-pre-wrap">{r.evidence}</p></div>}
                  {r.reasoning && <div className="bg-slate-800/50 rounded p-2.5 border border-slate-700"><span className="text-xs text-gray-500 uppercase block mb-1">Reasoning</span><p className="text-sm text-gray-300 whitespace-pre-wrap">{r.reasoning}</p></div>}
                  {r.pageReferences?.length > 0 && <div className="flex items-center space-x-2 flex-wrap"><span className="text-xs text-gray-500">Pages:</span>{r.pageReferences.map((p, i) => { const physPage = parseInt(p); const displayPage = pageOffset ? physPage - pageOffset : physPage; return <button key={i} onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('navigate-to-page', { detail: { page: physPage, pageOffset } })) }} className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded cursor-pointer hover:bg-blue-500/40 transition-colors" title={`Go to page ${physPage} (document page ${displayPage})`}>p.{displayPage}</button> })}</div>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function QuestionsPreview({ questions }) {
  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
      <div className="divide-y divide-slate-700/50">
        {questions.map((q, i) => (
          <div key={i} className="px-4 py-2 flex items-start space-x-3">
            <span className="text-xs font-bold text-blue-400 w-7 flex-shrink-0 pt-0.5">Q{q.number}</span>
            <p className="text-sm text-gray-300 flex-1">{q.question}</p>
            {q.suggestedResources && <span className="text-xs text-blue-400 flex-shrink-0">Resources: {q.suggestedResources}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function MetadataCard({ metadata }) {
  if (!metadata || Object.keys(metadata).length === 0) return null
  const items = [
    { l: 'Announcement', v: metadata['Announcement Name'] },
    { l: 'Announcement #', v: metadata['Announcement (#)'] },
    { l: 'Funding Cycle', v: metadata['Funding Cycle Code'] },
    { l: 'Status', v: metadata['Completion Status'] },
    { l: 'Recommendation', v: metadata['Recommendation'] || metadata['Program Specific Recommendation'] },
    { l: 'Reviewer', v: metadata['Name'] },
    { l: 'Date', v: metadata['Date'] },
  ].filter(d => d.v)
  return (
    <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
      <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Checklist Metadata</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {items.map((d, i) => (
          <div key={i}>
            <span className="text-xs text-gray-500 block">{d.l}</span>
            <span className={`text-sm font-medium ${d.v === 'Eligible' ? 'text-green-400' : d.v === 'Complete' ? 'text-blue-400' : 'text-white'}`}>{d.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function ChecklistComparison({ comparisonData }) {
  const [section, setSection] = useState('standard')
  const [stdQ, setStdQ] = useState(null)
  const [stdR, setStdR] = useState(null)
  const [stdS, setStdS] = useState(null)
  const [stdM, setStdM] = useState(null)
  const [stdL, setStdL] = useState(false)
  const [stdF, setStdF] = useState('all')
  const [stdE, setStdE] = useState({})
  const [psqQ, setPsqQ] = useState(null)
  const [psqR, setPsqR] = useState(null)
  const [psqS, setPsqS] = useState(null)
  const [psqL, setPsqL] = useState(false)
  const [psqF, setPsqF] = useState('all')
  const [psqE, setPsqE] = useState({})
  const [stdPO, setStdPO] = useState(0)
  const [psqPO, setPsqPO] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [dlMenuOpen, setDlMenuOpen] = useState(false)
  const dlMenuRef = useRef(null)

  const appDoc = comparisonData?.applications?.[0]
  const appData = appDoc?.analysis?.data || appDoc?.data

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const [s, p] = await Promise.all([
          getStandardQuestions().catch(() => ({ questions: [], metadata: {} })),
          getQAQuestions().catch(() => ({ questions: [] }))
        ])
        setStdQ(s.questions || []); setStdM(s.metadata || {})
        setPsqQ(p.questions || [])

        // Auto-load cached checklist comparison results if available
        const cached = comparisonData?.results?.[0]?.checklistComparison
        if (cached) {
          if (cached.standard) {
            setStdR(cached.standard.results); setStdS(cached.standard.summary)
            if (cached.standard.metadata) setStdM(cached.standard.metadata)
            if (cached.standard.pageOffset != null) setStdPO(cached.standard.pageOffset)
          }
          if (cached.programSpecific) {
            setPsqR(cached.programSpecific.results); setPsqS(cached.programSpecific.summary)
            if (cached.programSpecific.pageOffset != null) setPsqPO(cached.programSpecific.pageOffset)
          }
        }
      } catch (e) { setError(e.message) }
      finally { setLoading(false) }
    })()
  }, [comparisonData])

  const runBoth = async () => {
    if (!appData) { setError('No application data. Run a comparison first.'); return }
    setError(null); setStdL(true); setPsqL(true)
    try {
      const [s, p] = await Promise.all([runStandardComparison(appData), runQAComparison(appData)])
      setStdR(s.results); setStdS(s.summary); if (s.metadata) setStdM(s.metadata); setStdPO(s.pageOffset || 0)
      setPsqR(p.results); setPsqS(p.summary); setPsqPO(p.pageOffset || 0)
    } catch (e) { setError(e.message) }
    finally { setStdL(false); setPsqL(false) }
  }

  const runStd = async () => {
    if (!appData) { setError('No application data.'); return }
    setError(null); setStdL(true)
    try { const d = await runStandardComparison(appData); setStdR(d.results); setStdS(d.summary); if (d.metadata) setStdM(d.metadata); setStdPO(d.pageOffset || 0) }
    catch (e) { setError(e.message) } finally { setStdL(false) }
  }

  const runPsq = async () => {
    if (!appData) { setError('No application data.'); return }
    setError(null); setPsqL(true)
    try { const d = await runQAComparison(appData); setPsqR(d.results); setPsqS(d.summary); setPsqPO(d.pageOffset || 0) }
    catch (e) { setError(e.message) } finally { setPsqL(false) }
  }

  // Close download menu on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dlMenuRef.current && !dlMenuRef.current.contains(e.target)) setDlMenuOpen(false)
    }
    if (dlMenuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dlMenuOpen])

  const dlAppName = appDoc?.originalName || appDoc?.name || 'Application'

  const downloadJSON = () => {
    const r = { generatedAt: new Date().toISOString(), application: dlAppName, standard: { summary: stdS, metadata: stdM, results: stdR }, programSpecific: { summary: psqS, results: psqR } }
    const b = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })
    const u = URL.createObjectURL(b)
    const a = document.createElement('a'); a.href = u; a.download = `checklist_comparison_${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u)
    setDlMenuOpen(false)
  }

  const handleExcelDl = () => { downloadExcelReport(comparisonData, dlAppName); setDlMenuOpen(false) }
  const handleWordDl = async () => { await downloadWordReport(comparisonData, dlAppName); setDlMenuOpen(false) }

  const busy = stdL || psqL
  const hasResults = stdR || psqR

  if (loading) return <div className="bg-slate-800 rounded-lg p-12 text-center border border-slate-700"><Loader2 className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-3" /><p className="text-gray-400">Loading checklist questions...</p></div>

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-5 border border-slate-700">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white mb-1">Checklist Comparison</h2>
            <p className="text-sm text-gray-400">AI analysis of checklist questions against application evidence</p>
            {appDoc && <div className="flex items-center space-x-2 mt-2 text-xs text-gray-500"><FileText className="w-3.5 h-3.5" /><span>{appDoc.originalName || appDoc.name}</span></div>}
          </div>
          <div className="flex items-center space-x-2">
            {hasResults && (
              <div className="relative" ref={dlMenuRef}>
                <button onClick={() => setDlMenuOpen(!dlMenuOpen)} className="flex items-center space-x-1.5 bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg text-sm transition-colors">
                  <Download className="w-4 h-4" /><span>Export</span><ChevronDown className="w-3 h-3" />
                </button>
                {dlMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-20 min-w-[200px]">
                    <button onClick={handleExcelDl} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-200 hover:bg-slate-600 rounded-t-lg transition-colors">
                      <span className="text-green-400">📊</span> Excel Report (.xlsx)
                    </button>
                    <button onClick={handleWordDl} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-200 hover:bg-slate-600 transition-colors">
                      <span className="text-blue-400">📄</span> Word Report (.docx)
                    </button>
                    <button onClick={downloadJSON} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-200 hover:bg-slate-600 rounded-b-lg transition-colors">
                      <span className="text-yellow-400">📋</span> JSON Data (.json)
                    </button>
                  </div>
                )}
              </div>
            )}
            <button onClick={runBoth} disabled={busy || !appData} className="flex items-center space-x-1.5 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Analyzing...</span></> : hasResults ? <><RefreshCw className="w-4 h-4" /><span>Re-Analyze All</span></> : <><Play className="w-4 h-4" /><span>Run AI Analysis</span></>}
            </button>
          </div>
        </div>
        {!appData && !stdR && !psqR && <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2.5 text-yellow-400 text-sm mt-3"><AlertTriangle className="w-4 h-4 inline mr-1.5" />Run a document comparison first (Compare & Validate tab).</div>}
        {error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 text-red-400 text-sm mt-3"><XCircle className="w-4 h-4 inline mr-1.5" />{error}</div>}
      </div>

      {/* Section Tabs */}
      <div className="flex space-x-1 bg-slate-800 rounded-lg p-1 border border-slate-700">
        {[
          { id: 'standard', icon: ShieldCheck, label: 'Standard Q&A Comparison', summary: stdS, count: stdR?.length },
          { id: 'program', icon: ClipboardList, label: 'Program-Specific Q&A Comparison', summary: psqS, count: psqR?.length }
        ].map(t => (
          <button key={t.id} onClick={() => setSection(t.id)}
            className={`flex-1 flex items-center justify-center space-x-2 py-2.5 rounded-md text-sm font-medium transition-colors ${section === t.id ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-white hover:bg-slate-700'}`}>
            <t.icon className="w-4 h-4" /><span>{t.label}</span>
            {t.count > 0 && <span className="ml-1.5 px-1.5 py-0.5 rounded text-xs bg-blue-500/30 text-blue-400">{t.count} Qs</span>}
          </button>
        ))}
      </div>

      {/* Standard Section */}
      {section === 'standard' && (
        <div className="space-y-4">
          {stdM && <MetadataCard metadata={stdM} />}
          {stdL && <div className="bg-slate-800 rounded-lg p-8 text-center border border-slate-700"><Loader2 className="w-8 h-8 text-purple-500 animate-spin mx-auto mb-3" /><p className="text-white">Analyzing standard checklist...</p></div>}
          {stdS && <SummaryCards summary={stdS} />}
          {stdR ? <ResultsTable results={stdR} filter={stdF} setFilter={setStdF} expanded={stdE} toggle={k => setStdE(p => ({ ...p, [k]: !p[k] }))} pageOffset={stdPO} />
            : !stdL && stdQ && stdQ.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-400">Checklist Questions ({stdQ.length} questions)</h3>
                  <button onClick={runStd} disabled={stdL || !appData} className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white px-3 py-1.5 rounded transition-colors">Analyze Standard Only</button>
                </div>
                <QuestionsPreview questions={stdQ} />
              </div>
            )}
        </div>
      )}

      {/* Program-Specific Section */}
      {section === 'program' && (
        <div className="space-y-4">
          {psqL && <div className="bg-slate-800 rounded-lg p-8 text-center border border-slate-700"><Loader2 className="w-8 h-8 text-purple-500 animate-spin mx-auto mb-3" /><p className="text-white">Analyzing program-specific questions...</p></div>}
          {psqS && <SummaryCards summary={psqS} />}
          {psqR ? <ResultsTable results={psqR} filter={psqF} setFilter={setPsqF} expanded={psqE} toggle={k => setPsqE(p => ({ ...p, [k]: !p[k] }))} pageOffset={psqPO} />
            : !psqL && psqQ && psqQ.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-400">Checklist Questions ({psqQ.length} questions)</h3>
                  <button onClick={runPsq} disabled={psqL || !appData} className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white px-3 py-1.5 rounded transition-colors">Analyze Program-Specific Only</button>
                </div>
                <QuestionsPreview questions={psqQ} />
              </div>
            )}
        </div>
      )}
    </div>
  )
}
