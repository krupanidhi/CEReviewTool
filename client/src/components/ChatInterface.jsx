import { useState, useRef, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { chatWithModel } from '../services/api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function ChatInterface({ document, applicationDoc, checklistDoc, comparisonResult, activeTab, reviewMode, pfData, messages, setMessages }) {
  const isPfMode = reviewMode === 'pf' && !!pfData
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || loading) return

    const userMessage = {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString()
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      // Build comprehensive context with both application and checklist
      // Extract completed analysis results from comparisonResult if available
      let analysisResults = null
      if (comparisonResult?.results?.[0]) {
        const r = comparisonResult.results[0]
        const stdResults = r.checklistComparison?.standard?.results || []
        const psResults = r.checklistComparison?.programSpecific?.results || []
        const compSections = r.comparison?.sections || []
        analysisResults = {
          standardQuestions: stdResults.map(q => ({
            questionNumber: q.questionNumber,
            question: q.question,
            aiAnswer: q.aiAnswer,
            confidence: q.confidence,
            evidence: q.evidence,
            reasoning: q.reasoning,
            pageReferences: q.pageReferences,
            suggestedResources: q.suggestedResources
          })),
          programSpecificQuestions: psResults.map(q => ({
            questionNumber: q.questionNumber,
            question: q.question,
            aiAnswer: q.aiAnswer,
            confidence: q.confidence,
            evidence: q.evidence,
            reasoning: q.reasoning,
            pageReferences: q.pageReferences,
            suggestedResources: q.suggestedResources
          })),
          complianceSections: compSections.map(s => ({
            checklistSection: s.checklistSection,
            complianceStatus: s.complianceStatus,
            findings: s.findings,
            evidence: s.evidence
          })),
          applicantProfile: r.checklistComparison?.programSpecific?.applicantProfile || null,
          saatInfo: r.checklistComparison?.programSpecific?.saatInfo || null,
          overallCompliance: r.comparison?.overallCompliance || null,
          summary: r.comparison?.summary || r.checklistComparison?.programSpecific?.summary || null
        }
      }

      const context = {
        application: applicationDoc ? {
          name: applicationDoc.originalName || applicationDoc.name,
          data: applicationDoc.analysis?.data || applicationDoc.data
        } : null,
        checklist: checklistDoc ? {
          name: checklistDoc.originalName || checklistDoc.name,
          data: checklistDoc.analysis?.data || checklistDoc.data
        } : null,
        // Legacy single document support
        singleDocument: document ? {
          name: document.originalName,
          data: document.analysis?.data || document.data
        } : null,
        // Completed analysis results (Q&A answers, evidence, reasoning, compliance)
        analysisResults,
        // Pre-funding review context — sent when user is on PF tab
        pfContext: isPfMode ? {
          applicationNumber: pfData.applicationNumber,
          filename: pfData.filename,
          results: pfData.results
        } : null
      }

      const response = await chatWithModel(input, messages, context)

      const assistantMessage = {
        role: 'assistant',
        content: response.message,
        timestamp: new Date().toISOString(),
        usage: response.usage
      }

      setMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      const errorMessage = {
        role: 'error',
        content: `Error: ${error.message}`,
        timestamp: new Date().toISOString()
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const clearChat = () => {
    if (confirm('Clear all chat messages?')) {
      setMessages([])
    }
  }

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div style={{ background: '#FFFFFF', display: 'flex', flexDirection: 'column', height: '100%', borderRadius: '0 0 12px 12px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #D9E8F6' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '1.3rem' }}>{isPfMode ? '📋' : '🤖'}</span>
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: '600', color: '#0B4778', margin: 0 }}>
              {isPfMode ? 'Pre-Funding Review Q&A' : 'Intelligent Document Q&A'}
            </h3>
            {isPfMode && (
              <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '10px', background: '#dbeafe', color: '#2563eb', fontSize: '0.65rem', fontWeight: '700', marginTop: '3px' }}>
                PF CONTEXT
              </span>
            )}
            <p style={{ fontSize: '0.75rem', color: '#94a3b8', margin: 0, maxWidth: '280px', lineHeight: '1.4' }}>
              {isPfMode ? (
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pfData.filename}>
                  📋 {pfData.filename || `Application-${pfData.applicationNumber}`}
                </span>
              ) : applicationDoc && checklistDoc ? (
                <span>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={applicationDoc.originalName || applicationDoc.name}>
                    ✅ {applicationDoc.originalName || applicationDoc.name || 'Application'}
                  </span>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={checklistDoc.originalName || checklistDoc.name}>
                    ✅ {checklistDoc.originalName || checklistDoc.name || 'Checklist'}
                  </span>
                </span>
              ) : applicationDoc ? (
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={applicationDoc.originalName || applicationDoc.name}>
                  ✅ {applicationDoc.originalName || applicationDoc.name || 'Application'} • ⚠️ No checklist
                </span>
              ) : document ? (
                `Context: ${document.originalName}`
              ) : (
                'No documents loaded - upload documents first'
              )}
            </p>
          </div>
        </div>
        <button onClick={clearChat} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: '6px', fontSize: '0.9rem', color: '#94a3b8' }} title="Clear chat">🗑️</button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {messages.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: '16px' }}>🤖</div>
            <h4 style={{ fontSize: '1.1rem', fontWeight: '600', color: '#0B4778', marginBottom: '8px' }}>Start a conversation</h4>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', maxWidth: '320px' }}>
              {isPfMode
                ? "Ask questions about the pre-funding review. I'll reference compliance findings, evidence, and reasoning from the PF analysis."
                : applicationDoc && checklistDoc
                  ? "Ask questions about the application. I'll reference the checklist requirements and provide evidence-based answers."
                  : 'Upload application and checklist documents to enable intelligent Q&A.'}
            </p>
          </div>
        ) : (
          <>
            {messages.map((message, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
                {message.role === 'assistant' && (
                  <span style={{ fontSize: '1.2rem', flexShrink: 0, marginTop: '4px' }}>🤖</span>
                )}
                <div style={{
                  maxWidth: '80%', borderRadius: '12px', padding: '12px 16px',
                  background: message.role === 'user' ? '#3b82f6' : message.role === 'error' ? '#FEF2F2' : '#EFF6FB',
                  color: message.role === 'user' ? '#FFFFFF' : message.role === 'error' ? '#dc2626' : '#0B4778',
                  border: message.role === 'error' ? '1px solid #FECACA' : 'none'
                }}>
                  {message.role === 'assistant' ? (
                    <div className="prose prose-sm max-w-none" style={{ color: '#0B4778' }}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h1: ({node, ...props}) => <h1 style={{ fontSize: '1.2rem', fontWeight: '700', color: '#0B4778', marginBottom: '8px', marginTop: '12px' }} {...props} />,
                          h2: ({node, ...props}) => <h2 style={{ fontSize: '1.05rem', fontWeight: '700', color: '#0B4778', marginBottom: '6px', marginTop: '10px' }} {...props} />,
                          h3: ({node, ...props}) => <h3 style={{ fontSize: '0.95rem', fontWeight: '600', color: '#0B4778', marginBottom: '6px', marginTop: '8px' }} {...props} />,
                          p: ({node, ...props}) => <p style={{ fontSize: '0.85rem', color: '#0B4778', marginBottom: '8px', lineHeight: '1.6' }} {...props} />,
                          ul: ({node, ...props}) => <ul style={{ listStyleType: 'disc', paddingLeft: '20px', marginBottom: '8px' }} {...props} />,
                          ol: ({node, ...props}) => <ol style={{ listStyleType: 'decimal', paddingLeft: '20px', marginBottom: '8px' }} {...props} />,
                          li: ({node, ...props}) => <li style={{ fontSize: '0.85rem', color: '#0B4778', marginBottom: '4px' }} {...props} />,
                          table: ({node, ...props}) => <div style={{ overflowX: 'auto', margin: '12px 0' }}><table style={{ minWidth: '100%', border: '1px solid #D9E8F6', borderRadius: '8px', borderCollapse: 'collapse' }} {...props} /></div>,
                          thead: ({node, ...props}) => <thead style={{ background: '#EFF6FB' }} {...props} />,
                          th: ({node, ...props}) => <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: '0.75rem', fontWeight: '600', color: '#0B4778', borderBottom: '1px solid #D9E8F6', borderRight: '1px solid #D9E8F6' }} {...props} />,
                          td: ({node, ...props}) => <td style={{ padding: '8px 12px', fontSize: '0.85rem', color: '#0B4778', borderBottom: '1px solid #D9E8F6', borderRight: '1px solid #D9E8F6' }} {...props} />,
                          code: ({node, inline, ...props}) => inline
                            ? <code style={{ background: '#EFF6FB', color: '#7c3aed', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontFamily: 'monospace' }} {...props} />
                            : <code style={{ display: 'block', background: '#EFF6FB', color: '#0B4778', padding: '12px', borderRadius: '8px', fontSize: '0.75rem', fontFamily: 'monospace', overflowX: 'auto', margin: '8px 0' }} {...props} />,
                          pre: ({node, ...props}) => <pre style={{ background: '#EFF6FB', borderRadius: '8px', overflow: 'hidden', margin: '8px 0' }} {...props} />,
                          blockquote: ({node, ...props}) => <blockquote style={{ borderLeft: '4px solid #3b82f6', paddingLeft: '12px', margin: '8px 0', fontStyle: 'italic', color: '#64748b' }} {...props} />,
                          a: ({node, ...props}) => <a style={{ color: '#3b82f6', textDecoration: 'underline' }} target="_blank" rel="noopener noreferrer" {...props} />,
                          strong: ({node, ...props}) => <strong style={{ fontWeight: '700', color: '#0B4778' }} {...props} />,
                          hr: ({node, ...props}) => <hr style={{ border: 'none', borderTop: '1px solid #D9E8F6', margin: '12px 0' }} {...props} />,
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap', margin: 0 }}>{message.content}</p>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px', paddingTop: '6px', borderTop: message.role === 'user' ? '1px solid rgba(255,255,255,0.15)' : '1px solid #D9E8F6' }}>
                    <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>{formatTime(message.timestamp)}</span>
                    {message.usage && <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>{message.usage.totalTokens} tokens</span>}
                  </div>
                </div>
                {message.role === 'user' && (
                  <span style={{ fontSize: '1.2rem', flexShrink: 0, marginTop: '4px' }}>👤</span>
                )}
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <span style={{ fontSize: '1.2rem' }}>🤖</span>
                <div style={{ background: '#EFF6FB', borderRadius: '12px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Loader2 style={{ width: 16, height: 16, color: '#7c3aed' }} className="animate-spin" />
                  <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #D9E8F6' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={isPfMode ? "Ask about pre-funding compliance, sections, evidence..." : applicationDoc && checklistDoc ? "Ask about compliance, requirements, evidence..." : "Upload documents first to enable chat..."}
            style={{ flex: 1, background: '#EFF6FB', color: '#0B4778', borderRadius: '8px', padding: '10px 14px', border: '2px solid #D9E8F6', outline: 'none', resize: 'vertical', minHeight: '50px', maxHeight: '200px', fontSize: '0.9rem', fontFamily: 'inherit' }}
            onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
            onBlur={(e) => e.target.style.borderColor = '#D9E8F6'}
            rows="2"
            disabled={loading || (!isPfMode && !applicationDoc && !checklistDoc && !document)}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            style={{ background: !input.trim() || loading ? '#D9E8F6' : '#3b82f6', color: !input.trim() || loading ? '#94a3b8' : '#FFFFFF', border: 'none', padding: '10px 14px', borderRadius: '8px', cursor: !input.trim() || loading ? 'not-allowed' : 'pointer', flexShrink: 0, fontSize: '1.1rem', transition: 'all 0.2s' }}
          >
            {loading ? '⏳' : '➤'}
          </button>
        </div>
        <p style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '6px' }}>
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
