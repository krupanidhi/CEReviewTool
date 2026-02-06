import { useState, useRef, useEffect } from 'react'
import { Send, Loader2, MessageSquare, Trash2, Bot, User } from 'lucide-react'
import { chatWithModel } from '../services/api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function ChatInterface({ document, applicationDoc, checklistDoc }) {
  const [messages, setMessages] = useState([])
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
    <div className="bg-slate-800 rounded-lg border border-slate-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-700">
        <div className="flex items-center space-x-3">
          <div className="bg-purple-500/10 p-2 rounded-lg">
            <MessageSquare className="w-5 h-5 text-purple-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Intelligent Document Q&A</h3>
            <p className="text-xs text-gray-400">
              {applicationDoc && checklistDoc ? (
                <span className="flex items-center space-x-2">
                  <span className="text-green-400">✓ Application</span>
                  <span>•</span>
                  <span className="text-green-400">✓ Checklist</span>
                </span>
              ) : document ? (
                `Context: ${document.originalName}`
              ) : (
                'No documents loaded - upload documents first'
              )}
            </p>
          </div>
        </div>
        <button
          onClick={clearChat}
          className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
          title="Clear chat"
        >
          <Trash2 className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Bot className="w-16 h-16 text-gray-600 mb-4" />
            <h4 className="text-lg font-medium text-gray-300 mb-2">Start a conversation</h4>
            <p className="text-sm text-gray-500 max-w-md">
              {applicationDoc && checklistDoc ? (
                'Ask questions about the application. I\'ll reference the checklist requirements and provide evidence-based answers.'
              ) : (
                'Upload application and checklist documents to enable intelligent Q&A.'
              )}
            </p>
          </div>
        ) : (
          <>
            {messages.map((message, idx) => (
              <div
                key={idx}
                className={`flex items-start space-x-3 ${
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                {message.role === 'assistant' && (
                  <div className="bg-purple-500/10 p-2 rounded-lg flex-shrink-0">
                    <Bot className="w-5 h-5 text-purple-500" />
                  </div>
                )}
                
                <div
                  className={`max-w-[80%] rounded-lg p-4 ${
                    message.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : message.role === 'error'
                      ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                      : 'bg-slate-700 text-gray-100'
                  }`}
                >
                  {message.role === 'assistant' ? (
                    <div className="prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          // Headings
                          h1: ({node, ...props}) => <h1 className="text-xl font-bold text-white mb-3 mt-4" {...props} />,
                          h2: ({node, ...props}) => <h2 className="text-lg font-bold text-white mb-2 mt-3" {...props} />,
                          h3: ({node, ...props}) => <h3 className="text-base font-semibold text-white mb-2 mt-2" {...props} />,
                          
                          // Paragraphs
                          p: ({node, ...props}) => <p className="text-sm text-gray-100 mb-2 leading-relaxed" {...props} />,
                          
                          // Lists
                          ul: ({node, ...props}) => <ul className="list-disc list-inside mb-3 space-y-1" {...props} />,
                          ol: ({node, ...props}) => <ol className="list-decimal list-inside mb-3 space-y-1" {...props} />,
                          li: ({node, ...props}) => <li className="text-sm text-gray-100 ml-2" {...props} />,
                          
                          // Tables
                          table: ({node, ...props}) => (
                            <div className="overflow-x-auto my-4">
                              <table className="min-w-full border border-slate-600 rounded-lg" {...props} />
                            </div>
                          ),
                          thead: ({node, ...props}) => <thead className="bg-slate-600" {...props} />,
                          tbody: ({node, ...props}) => <tbody className="divide-y divide-slate-600" {...props} />,
                          tr: ({node, ...props}) => <tr className="hover:bg-slate-600/50" {...props} />,
                          th: ({node, ...props}) => (
                            <th className="px-4 py-2 text-left text-xs font-semibold text-white border-r border-slate-600 last:border-r-0" {...props} />
                          ),
                          td: ({node, ...props}) => (
                            <td className="px-4 py-2 text-sm text-gray-100 border-r border-slate-600 last:border-r-0" {...props} />
                          ),
                          
                          // Code blocks
                          code: ({node, inline, ...props}) => 
                            inline ? (
                              <code className="bg-slate-800 text-purple-400 px-1.5 py-0.5 rounded text-xs font-mono" {...props} />
                            ) : (
                              <code className="block bg-slate-800 text-gray-100 p-3 rounded-lg text-xs font-mono overflow-x-auto my-2" {...props} />
                            ),
                          pre: ({node, ...props}) => <pre className="bg-slate-800 rounded-lg overflow-hidden my-2" {...props} />,
                          
                          // Blockquotes
                          blockquote: ({node, ...props}) => (
                            <blockquote className="border-l-4 border-purple-500 pl-4 py-2 my-3 italic text-gray-300" {...props} />
                          ),
                          
                          // Links
                          a: ({node, ...props}) => (
                            <a className="text-blue-400 hover:text-blue-300 underline" target="_blank" rel="noopener noreferrer" {...props} />
                          ),
                          
                          // Strong/Bold
                          strong: ({node, ...props}) => <strong className="font-bold text-white" {...props} />,
                          
                          // Emphasis/Italic
                          em: ({node, ...props}) => <em className="italic text-gray-200" {...props} />,
                          
                          // Horizontal rule
                          hr: ({node, ...props}) => <hr className="border-slate-600 my-4" {...props} />,
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  )}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/10">
                    <span className="text-xs opacity-70">{formatTime(message.timestamp)}</span>
                    {message.usage && (
                      <span className="text-xs opacity-70">
                        {message.usage.totalTokens} tokens
                      </span>
                    )}
                  </div>
                </div>

                {message.role === 'user' && (
                  <div className="bg-blue-500/10 p-2 rounded-lg flex-shrink-0">
                    <User className="w-5 h-5 text-blue-500" />
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex items-start space-x-3">
                <div className="bg-purple-500/10 p-2 rounded-lg">
                  <Bot className="w-5 h-5 text-purple-500" />
                </div>
                <div className="bg-slate-700 rounded-lg p-4">
                  <div className="flex items-center space-x-2">
                    <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
                    <span className="text-sm text-gray-400">Thinking...</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="p-4 border-t border-slate-700">
        <div className="flex items-end space-x-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={applicationDoc && checklistDoc ? "Ask about compliance, requirements, evidence, or any section..." : "Upload documents first to enable chat..."}
            className="flex-1 bg-slate-900 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-blue-500 focus:outline-none resize-y min-h-[60px] max-h-[300px]"
            rows="2"
            disabled={loading || (!applicationDoc && !checklistDoc && !document)}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white p-3 rounded-lg transition-colors flex-shrink-0"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
