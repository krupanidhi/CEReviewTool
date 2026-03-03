import { useState } from 'react'

function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    // Simple validation
    if (!username || !password) {
      setError('Please enter both username and password')
      setLoading(false)
      return
    }

    // Validate credentials
    const validUsers = {
      'TestUser1': '#GemsUser1',
      'TestUser2': '#GemsUser1'
    }
    
    if (validUsers[username] && validUsers[username] === password) {
      setTimeout(() => {
        onLogin({ username })
        setLoading(false)
      }, 500)
    } else {
      setError('Invalid username or password')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#EFF6FB',
      padding: '20px'
    }}>
      <div style={{
        width: '100%',
        maxWidth: '450px',
        background: '#FFFFFF',
        borderRadius: '16px',
        padding: '40px',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.1)',
        border: '1px solid #D9E8F6'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <img 
            src="/image/HRSA_Logo.png"
            alt="HRSA Logo" 
            style={{ height: '80px', width: 'auto', marginBottom: '20px' }}
          />
          <h1 style={{ color: '#0B4778', fontSize: '1.8rem', marginBottom: '8px' }}>
            AI Review Assistant
          </h1>
          <p style={{ color: '#64748b', fontSize: '0.95rem' }}>
            Sign in to access the application
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              color: '#0B4778',
              fontSize: '0.9rem',
              fontWeight: '600',
              marginBottom: '8px'
            }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              style={{
                width: '100%',
                padding: '12px 16px',
                background: '#FFFFFF',
                border: '2px solid #D9E8F6',
                borderRadius: '8px',
                color: '#0B4778',
                fontSize: '1rem',
                outline: 'none',
                transition: 'border-color 0.3s',
                boxSizing: 'border-box'
              }}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#D9E8F6'}
            />
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label style={{
              display: 'block',
              color: '#0B4778',
              fontSize: '0.9rem',
              fontWeight: '600',
              marginBottom: '8px'
            }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              style={{
                width: '100%',
                padding: '12px 16px',
                background: '#FFFFFF',
                border: '2px solid #D9E8F6',
                borderRadius: '8px',
                color: '#0B4778',
                fontSize: '1rem',
                outline: 'none',
                transition: 'border-color 0.3s',
                boxSizing: 'border-box'
              }}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#D9E8F6'}
            />
          </div>

          {error && (
            <div style={{
              padding: '12px',
              background: '#fef2f2',
              border: '1px solid #ef4444',
              borderRadius: '8px',
              color: '#dc2626',
              fontSize: '0.9rem',
              marginBottom: '20px'
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              background: loading ? '#64748b' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: '600',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.3s',
              boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)'
            }}
            onMouseEnter={(e) => {
              if (!loading) e.target.style.background = '#2563eb'
            }}
            onMouseLeave={(e) => {
              if (!loading) e.target.style.background = '#3b82f6'
            }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div style={{
          marginTop: '24px',
          padding: '16px',
          background: '#EFF6FB',
          borderRadius: '8px',
          border: '1px solid #D9E8F6'
        }}>
          <p style={{
            color: '#64748b',
            fontSize: '0.85rem',
            margin: 0,
            textAlign: 'center'
          }}>
            🔒 Secure access to HRSA compliance analysis tools
          </p>
        </div>
      </div>
    </div>
  )
}

export default Login
