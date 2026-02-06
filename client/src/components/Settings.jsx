import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Trash2, Database, ToggleLeft, ToggleRight, Save, RefreshCw } from 'lucide-react'
import { getSettings, updateSettings, clearCache, getCacheData } from '../services/api'

export default function Settings() {
  const [settings, setSettings] = useState({
    enableCache: true,
    multipleApplications: false,
    multipleChecklists: true,
    maxCacheSize: 100,
    cacheLocation: './cache'
  })
  const [cacheStats, setCacheStats] = useState({
    analysisCacheSize: 0,
    kvCacheSize: 0,
    totalSize: 0,
    maxSize: 100,
    cacheEnabled: true
  })
  const [cacheData, setCacheData] = useState({ analysis: [], keyvalue: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    loadSettings()
    loadCacheData()
  }, [])

  const loadSettings = async () => {
    try {
      const result = await getSettings()
      setSettings(result.settings)
      setCacheStats(result.cacheStats)
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to load settings: ${error.message}` })
    } finally {
      setLoading(false)
    }
  }

  const loadCacheData = async () => {
    try {
      const result = await getCacheData()
      setCacheData(result.cache)
    } catch (error) {
      console.error('Failed to load cache data:', error)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const result = await updateSettings(settings)
      setSettings(result.settings)
      setMessage({ type: 'success', text: 'Settings saved successfully' })
      setTimeout(() => setMessage(null), 3000)
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to save settings: ${error.message}` })
    } finally {
      setSaving(false)
    }
  }

  const handleClearCache = async (type) => {
    if (!confirm(`Clear ${type} cache? This cannot be undone.`)) return

    try {
      await clearCache(type)
      await loadSettings()
      await loadCacheData()
      setMessage({ type: 'success', text: `${type} cache cleared successfully` })
      setTimeout(() => setMessage(null), 3000)
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to clear cache: ${error.message}` })
    }
  }

  const toggleSetting = (key) => {
    setSettings(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center space-x-3 mb-4">
          <div className="bg-blue-500/10 p-2 rounded-lg">
            <SettingsIcon className="w-6 h-6 text-blue-500" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Settings</h2>
            <p className="text-sm text-gray-400">Configure application behavior and manage cache</p>
          </div>
        </div>

        {message && (
          <div className={`p-4 rounded-lg mb-4 ${
            message.type === 'success' 
              ? 'bg-green-500/10 border border-green-500/20 text-green-400'
              : 'bg-red-500/10 border border-red-500/20 text-red-400'
          }`}>
            {message.text}
          </div>
        )}

        {/* Settings Toggles */}
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-slate-900 rounded-lg border border-slate-600">
            <div>
              <h3 className="font-medium text-white">Enable Cache</h3>
              <p className="text-sm text-gray-400">Store analysis results and key-value pairs for faster access</p>
            </div>
            <button
              onClick={() => toggleSetting('enableCache')}
              className="flex items-center space-x-2"
            >
              {settings.enableCache ? (
                <ToggleRight className="w-10 h-10 text-green-500" />
              ) : (
                <ToggleLeft className="w-10 h-10 text-gray-500" />
              )}
            </button>
          </div>

          <div className="flex items-center justify-between p-4 bg-slate-900 rounded-lg border border-slate-600">
            <div>
              <h3 className="font-medium text-white">Multiple Applications</h3>
              <p className="text-sm text-gray-400">Allow uploading multiple application documents at once</p>
            </div>
            <button
              onClick={() => toggleSetting('multipleApplications')}
              className="flex items-center space-x-2"
            >
              {settings.multipleApplications ? (
                <ToggleRight className="w-10 h-10 text-green-500" />
              ) : (
                <ToggleLeft className="w-10 h-10 text-gray-500" />
              )}
            </button>
          </div>

          <div className="flex items-center justify-between p-4 bg-slate-900 rounded-lg border border-slate-600">
            <div>
              <h3 className="font-medium text-white">Multiple Checklists</h3>
              <p className="text-sm text-gray-400">Allow uploading multiple checklist/guide documents</p>
            </div>
            <button
              onClick={() => toggleSetting('multipleChecklists')}
              className="flex items-center space-x-2"
            >
              {settings.multipleChecklists ? (
                <ToggleRight className="w-10 h-10 text-green-500" />
              ) : (
                <ToggleLeft className="w-10 h-10 text-gray-500" />
              )}
            </button>
          </div>

          <div className="p-4 bg-slate-900 rounded-lg border border-slate-600">
            <label className="block mb-2">
              <span className="font-medium text-white">Max Cache Size</span>
              <p className="text-sm text-gray-400 mb-2">Maximum number of cached items</p>
            </label>
            <input
              type="number"
              value={settings.maxCacheSize}
              onChange={(e) => setSettings(prev => ({ ...prev, maxCacheSize: parseInt(e.target.value) }))}
              className="w-full bg-slate-800 text-white rounded-lg px-4 py-2 border border-slate-600 focus:border-blue-500 focus:outline-none"
              min="10"
              max="1000"
            />
          </div>

          <div className="p-4 bg-slate-900 rounded-lg border border-slate-600">
            <label className="block mb-2">
              <span className="font-medium text-white">Cache Location</span>
              <p className="text-sm text-gray-400 mb-2">Directory path for storing cache files</p>
            </label>
            <input
              type="text"
              value={settings.cacheLocation}
              onChange={(e) => setSettings(prev => ({ ...prev, cacheLocation: e.target.value }))}
              className="w-full bg-slate-800 text-white rounded-lg px-4 py-2 border border-slate-600 focus:border-blue-500 focus:outline-none font-mono text-sm"
              placeholder="./cache"
            />
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="mt-6 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white px-6 py-3 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
        >
          {saving ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              <span>Saving...</span>
            </>
          ) : (
            <>
              <Save className="w-5 h-5" />
              <span>Save Settings</span>
            </>
          )}
        </button>
      </div>

      {/* Cache Statistics */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center space-x-3 mb-4">
          <div className="bg-purple-500/10 p-2 rounded-lg">
            <Database className="w-6 h-6 text-purple-500" />
          </div>
          <h3 className="text-xl font-semibold text-white">Cache Statistics</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-2xl font-bold text-blue-400">{cacheStats.analysisCacheSize}</div>
            <div className="text-sm text-gray-400">Analysis Reports</div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-2xl font-bold text-green-400">{cacheStats.kvCacheSize}</div>
            <div className="text-sm text-gray-400">Key-Value Pairs</div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-2xl font-bold text-purple-400">{cacheStats.totalSize}</div>
            <div className="text-sm text-gray-400">Total Cached Items</div>
          </div>
          <div className="bg-slate-900 rounded-lg p-4 border border-slate-600">
            <div className="text-2xl font-bold text-yellow-400">{cacheStats.maxSize}</div>
            <div className="text-sm text-gray-400">Max Cache Size</div>
          </div>
        </div>

        <div className="flex space-x-4">
          <button
            onClick={() => handleClearCache('analysis')}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clear Analysis Cache</span>
          </button>
          <button
            onClick={() => handleClearCache('keyvalue')}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clear KV Cache</span>
          </button>
          <button
            onClick={() => handleClearCache('all')}
            className="flex-1 bg-red-700 hover:bg-red-800 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clear All Cache</span>
          </button>
        </div>
      </div>

      {/* Cached Analysis Reports */}
      {cacheData.analysis && cacheData.analysis.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
          <h3 className="text-lg font-semibold text-white mb-4">Cached Analysis Reports</h3>
          <div className="space-y-2">
            {cacheData.analysis.map((entry, idx) => (
              <div key={idx} className="bg-slate-900 rounded-lg p-4 border border-slate-600">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-white">{entry.documentName}</div>
                    <div className="text-sm text-gray-400">
                      Cached: {formatDate(entry.timestamp)}
                    </div>
                  </div>
                  <div className="text-sm text-gray-500">ID: {entry.documentId}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
