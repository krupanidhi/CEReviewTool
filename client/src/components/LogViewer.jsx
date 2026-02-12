import { useState, useEffect, useRef } from 'react'
import { X, Trash2, Download, ChevronDown, AlertTriangle, Info, AlertCircle } from 'lucide-react'

const levelColors = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
}

const levelIcons = {
  info: Info,
  warn: AlertTriangle,
  error: AlertCircle,
}

const levelBg = {
  info: '',
  warn: 'bg-yellow-500/5',
  error: 'bg-red-500/5',
}

export default function LogViewer({ logs = [], isOpen, onClose, onClear }) {
  const [filter, setFilter] = useState('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  const counts = {
    info: logs.filter(l => l.level === 'info').length,
    warn: logs.filter(l => l.level === 'warn').length,
    error: logs.filter(l => l.level === 'error').length,
  }

  const downloadLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}${l.data ? ' | ' + JSON.stringify(l.data) : ''}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ce-review-logs_${new Date().toISOString().split('T')[0]}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-slate-900 border-l border-slate-700 shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-700 bg-slate-800">
        <div className="flex items-center space-x-2">
          <ChevronDown className="w-5 h-5 text-green-500" />
          <h3 className="text-lg font-semibold text-white">Processing Logs</h3>
          <span className="text-xs text-gray-500 bg-slate-700 px-2 py-0.5 rounded">{logs.length}</span>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={downloadLogs} className="p-1.5 hover:bg-slate-700 rounded transition-colors" title="Download logs">
            <Download className="w-4 h-4 text-gray-400" />
          </button>
          {onClear && (
            <button onClick={onClear} className="p-1.5 hover:bg-slate-700 rounded transition-colors" title="Clear logs">
              <Trash2 className="w-4 h-4 text-gray-400" />
            </button>
          )}
          <button onClick={onClose} className="p-1.5 hover:bg-slate-700 rounded transition-colors" title="Close">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center space-x-1.5 px-4 py-2 border-b border-slate-700 bg-slate-800/50">
        {['all', 'info', 'warn', 'error'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              filter !== f
                ? 'bg-slate-700 text-gray-400 hover:bg-slate-600'
                : f === 'error' ? 'bg-red-500/30 text-red-400 ring-1 ring-red-500/50'
                : f === 'warn' ? 'bg-yellow-500/30 text-yellow-400 ring-1 ring-yellow-500/50'
                : f === 'info' ? 'bg-blue-500/30 text-blue-400 ring-1 ring-blue-500/50'
                : 'bg-slate-600 text-white ring-1 ring-slate-500'
            }`}
          >
            {f === 'all' ? `All (${logs.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${counts[f]})`}
          </button>
        ))}
        <div className="flex-1" />
        <label className="flex items-center space-x-1.5 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            className="rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
          />
          <span>Auto-scroll</span>
        </label>
      </div>

      {/* Log Entries */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No logs yet. Start a comparison to see processing logs.</p>
          </div>
        ) : (
          filtered.map((entry, idx) => {
            const Icon = levelIcons[entry.level] || Info
            const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
            return (
              <div key={idx} className={`flex items-start px-3 py-1.5 border-b border-slate-800/50 hover:bg-slate-800/30 ${levelBg[entry.level] || ''}`}>
                <span className="text-gray-600 w-16 flex-shrink-0 select-none">{time}</span>
                <Icon className={`w-3.5 h-3.5 mt-0.5 mr-2 flex-shrink-0 ${levelColors[entry.level] || 'text-gray-400'}`} />
                <span className={`flex-1 break-words ${levelColors[entry.level] || 'text-gray-300'}`}>
                  {entry.message}
                </span>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
