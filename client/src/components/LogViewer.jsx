import { useState, useEffect, useRef } from 'react'

const levelColors = { info: '#3b82f6', warn: '#ca8a04', error: '#dc2626' }
const levelEmoji = { info: 'ℹ️', warn: '⚠️', error: '❌' }
const levelBg = { info: '', warn: '#FFFBEB', error: '#FEF2F2' }

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

  const filterBtnStyle = (f, active) => ({
    padding: '4px 12px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: '600',
    border: active ? '2px solid' : '1px solid #D9E8F6', cursor: 'pointer', transition: 'all 0.2s',
    background: !active ? '#EFF6FB' : f === 'error' ? '#FEF2F2' : f === 'warn' ? '#FFFBEB' : f === 'info' ? '#EFF6FF' : '#EFF6FB',
    color: !active ? '#94a3b8' : f === 'error' ? '#dc2626' : f === 'warn' ? '#ca8a04' : f === 'info' ? '#3b82f6' : '#0B4778',
    borderColor: !active ? '#D9E8F6' : f === 'error' ? '#dc2626' : f === 'warn' ? '#ca8a04' : f === 'info' ? '#3b82f6' : '#0B4778',
  })

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: '480px', background: '#FFFFFF', borderLeft: '2px solid #D9E8F6', boxShadow: '-4px 0 20px rgba(0,0,0,0.15)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderBottom: '2px solid #D9E8F6', background: '#0B4778' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '1.2rem' }}>📋</span>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', color: '#FFFFFF', margin: 0 }}>Processing Logs</h3>
          <span style={{ fontSize: '0.7rem', background: 'rgba(255,255,255,0.2)', color: '#FFFFFF', padding: '2px 8px', borderRadius: '10px' }}>{logs.length}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={downloadLogs} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', color: '#FFFFFF', fontSize: '0.85rem' }} title="Download logs">⬇️</button>
          {onClear && <button onClick={onClear} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', color: '#FFFFFF', fontSize: '0.85rem' }} title="Clear logs">🗑️</button>}
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', padding: '6px 10px', borderRadius: '6px', color: '#FFFFFF', fontSize: '1rem' }} title="Close">✕</button>
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderBottom: '1px solid #D9E8F6', background: '#EFF6FB' }}>
        {['all', 'info', 'warn', 'error'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={filterBtnStyle(f, filter === f)}>
            {f === 'all' ? `All (${logs.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${counts[f]})`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: '#0B4778', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          <span>Auto-scroll</span>
        </label>
      </div>

      {/* Log Entries */}
      <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.75rem' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ fontSize: '2rem', marginBottom: '8px' }}>📋</div>
            <p>No logs yet. Start a comparison to see processing logs.</p>
          </div>
        ) : (
          filtered.map((entry, idx) => {
            const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', padding: '4px 12px', borderBottom: '1px solid #EFF6FB', background: levelBg[entry.level] || '' }}>
                <span style={{ color: '#94a3b8', width: '52px', flexShrink: 0, userSelect: 'none' }}>{time}</span>
                <span style={{ marginRight: '6px', flexShrink: 0, fontSize: '0.7rem' }}>{levelEmoji[entry.level] || 'ℹ️'}</span>
                <span style={{ flex: 1, wordBreak: 'break-word', color: levelColors[entry.level] || '#0B4778' }}>
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
