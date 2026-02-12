import { useState, useEffect } from 'react'
import {
  Shield, Plus, Trash2, FileText, Link2, AlertCircle, CheckCircle,
  Edit3, Save, X, FolderOpen, ChevronDown, ChevronRight, Loader2
} from 'lucide-react'
import {
  getDocumentMappings, addApplicationType, deleteApplicationType, updateApplicationType,
  addDocumentMapping, deleteDocumentMapping, getStoredChecklists
} from '../services/api'

export default function AdminModule() {
  const [applicationTypes, setApplicationTypes] = useState([])
  const [mappings, setMappings] = useState([])
  const [storedChecklists, setStoredChecklists] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  // New application type form
  const [newTypeName, setNewTypeName] = useState('')
  const [newTypeDesc, setNewTypeDesc] = useState('')
  const [addingType, setAddingType] = useState(false)

  // Edit mode
  const [editingType, setEditingType] = useState(null)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  // Expanded types (to show their mappings)
  const [expandedTypes, setExpandedTypes] = useState({})

  // Add mapping state
  const [addingMappingFor, setAddingMappingFor] = useState(null)

  useEffect(() => {
    loadData()
  }, [])

  // Auto-clear success message
  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(null), 3000)
      return () => clearTimeout(t)
    }
  }, [success])

  const loadData = async () => {
    setLoading(true)
    try {
      const [mappingsResult, checklistsResult] = await Promise.all([
        getDocumentMappings(),
        getStoredChecklists().catch(() => ({ checklists: [] }))
      ])
      setApplicationTypes(mappingsResult.applicationTypes || [])
      setMappings(mappingsResult.mappings || [])
      setStoredChecklists(checklistsResult.checklists || [])
    } catch (e) {
      setError(`Failed to load data: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleAddType = async () => {
    if (!newTypeName.trim()) return
    setAddingType(true)
    setError(null)
    try {
      const result = await addApplicationType(newTypeName.trim(), newTypeDesc.trim())
      setApplicationTypes(result.applicationTypes || [])
      setNewTypeName('')
      setNewTypeDesc('')
      setSuccess('Application type added')
    } catch (e) {
      setError(e.message)
    } finally {
      setAddingType(false)
    }
  }

  const handleDeleteType = async (id, name) => {
    if (!confirm(`Delete application type "${name}" and all its checklist mappings?`)) return
    try {
      const result = await deleteApplicationType(id)
      setApplicationTypes(result.applicationTypes || [])
      setMappings(prev => prev.filter(m => m.applicationTypeId !== id))
      setSuccess('Application type deleted')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleUpdateType = async (id) => {
    try {
      const result = await updateApplicationType(id, { name: editName, description: editDesc })
      setApplicationTypes(result.applicationTypes || [])
      setEditingType(null)
      setSuccess('Application type updated')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleAddMapping = async (applicationTypeId, checklist) => {
    try {
      const result = await addDocumentMapping(
        applicationTypeId,
        checklist.id,
        checklist.displayName || checklist.originalName,
        true
      )
      setMappings(result.mappings || [])
      setAddingMappingFor(null)
      setSuccess('Checklist mapping added')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDeleteMapping = async (mappingId) => {
    try {
      const result = await deleteDocumentMapping(mappingId)
      setMappings(result.mappings || [])
      setSuccess('Mapping removed')
    } catch (e) {
      setError(e.message)
    }
  }

  const getMappingsForType = (typeId) => {
    return mappings.filter(m => m.applicationTypeId === typeId)
  }

  const toggleExpand = (typeId) => {
    setExpandedTypes(prev => ({ ...prev, [typeId]: !prev[typeId] }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <div className="flex items-center space-x-3 mb-2">
          <div className="bg-amber-500/10 p-2 rounded-lg">
            <Shield className="w-6 h-6 text-amber-500" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-white">Admin — Document Mapper</h2>
            <p className="text-sm text-gray-400">
              Configure which checklist documents are required for each application type.
              These mappings are used by the batch processor.
            </p>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-center space-x-2 text-red-400">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto p-1 hover:bg-red-500/20 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {success && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-center space-x-2 text-green-400">
          <CheckCircle className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{success}</span>
        </div>
      )}

      {/* Add Application Type */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h3 className="text-lg font-semibold text-white mb-4 flex items-center space-x-2">
          <Plus className="w-5 h-5 text-blue-400" />
          <span>Add Application Type</span>
        </h3>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-gray-400 mb-1">Type Name *</label>
            <input
              type="text"
              value={newTypeName}
              onChange={(e) => setNewTypeName(e.target.value)}
              placeholder="e.g., New Access Point (NAP)"
              className="w-full bg-slate-900 text-white rounded-lg px-4 py-2.5 border border-slate-600 focus:border-blue-500 focus:outline-none text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleAddType()}
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <input
              type="text"
              value={newTypeDesc}
              onChange={(e) => setNewTypeDesc(e.target.value)}
              placeholder="e.g., New application for health center access points"
              className="w-full bg-slate-900 text-white rounded-lg px-4 py-2.5 border border-slate-600 focus:border-blue-500 focus:outline-none text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleAddType()}
            />
          </div>
          <button
            onClick={handleAddType}
            disabled={!newTypeName.trim() || addingType}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white px-5 py-2.5 rounded-lg font-medium transition-colors flex items-center space-x-2 flex-shrink-0"
          >
            {addingType ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            <span>Add</span>
          </button>
        </div>
      </div>

      {/* Application Types & Mappings */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <div className="p-6 border-b border-slate-700">
          <h3 className="text-lg font-semibold text-white flex items-center space-x-2">
            <Link2 className="w-5 h-5 text-purple-400" />
            <span>Application Types & Required Checklists</span>
          </h3>
          <p className="text-sm text-gray-400 mt-1">
            {applicationTypes.length} application type(s) configured
          </p>
        </div>

        {applicationTypes.length === 0 ? (
          <div className="p-12 text-center">
            <Shield className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400">No application types configured yet</p>
            <p className="text-gray-500 text-sm mt-1">Add an application type above to get started</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-700">
            {applicationTypes.map(appType => {
              const typeMappings = getMappingsForType(appType.id)
              const isExpanded = expandedTypes[appType.id]
              const isEditing = editingType === appType.id

              return (
                <div key={appType.id}>
                  {/* Type Header */}
                  <div className="p-4 flex items-center justify-between hover:bg-slate-700/30 transition-colors">
                    <div className="flex items-center space-x-3 flex-1">
                      <button onClick={() => toggleExpand(appType.id)} className="text-gray-400 hover:text-white">
                        {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      </button>
                      <div className="bg-purple-500/10 p-1.5 rounded">
                        <FolderOpen className="w-4 h-4 text-purple-400" />
                      </div>
                      {isEditing ? (
                        <div className="flex items-center space-x-2 flex-1">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="bg-slate-900 text-white rounded px-3 py-1.5 border border-slate-600 focus:border-blue-500 focus:outline-none text-sm flex-1"
                          />
                          <input
                            type="text"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="Description"
                            className="bg-slate-900 text-white rounded px-3 py-1.5 border border-slate-600 focus:border-blue-500 focus:outline-none text-sm flex-1"
                          />
                          <button onClick={() => handleUpdateType(appType.id)} className="p-1.5 hover:bg-green-500/20 rounded text-green-400">
                            <Save className="w-4 h-4" />
                          </button>
                          <button onClick={() => setEditingType(null)} className="p-1.5 hover:bg-slate-600 rounded text-gray-400">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex-1">
                          <div className="text-white font-medium text-sm">{appType.name}</div>
                          {appType.description && (
                            <div className="text-xs text-gray-400">{appType.description}</div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs text-gray-400 bg-slate-700 px-2 py-1 rounded">
                        {typeMappings.length} checklist(s)
                      </span>
                      {!isEditing && (
                        <>
                          <button
                            onClick={() => { setEditingType(appType.id); setEditName(appType.name); setEditDesc(appType.description || '') }}
                            className="p-1.5 hover:bg-slate-600 rounded text-gray-400 hover:text-white transition-colors"
                            title="Edit"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteType(appType.id, appType.name)}
                            className="p-1.5 hover:bg-red-500/20 rounded text-gray-400 hover:text-red-400 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Expanded: Mappings */}
                  {isExpanded && (
                    <div className="bg-slate-900/50 px-4 pb-4 pt-2 ml-12">
                      {/* Existing Mappings */}
                      {typeMappings.length > 0 ? (
                        <div className="space-y-2 mb-3">
                          {typeMappings.map(mapping => (
                            <div key={mapping.id} className="flex items-center justify-between bg-slate-800 rounded-lg p-3 border border-slate-600">
                              <div className="flex items-center space-x-2">
                                <FileText className="w-4 h-4 text-green-400 flex-shrink-0" />
                                <span className="text-sm text-white">{mapping.checklistName}</span>
                                {mapping.required && (
                                  <span className="text-xs bg-red-500/10 text-red-400 px-2 py-0.5 rounded-full">Required</span>
                                )}
                              </div>
                              <button
                                onClick={() => handleDeleteMapping(mapping.id)}
                                className="p-1 hover:bg-red-500/20 rounded text-gray-400 hover:text-red-400 transition-colors"
                                title="Remove mapping"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500 mb-3">No checklists mapped yet</p>
                      )}

                      {/* Add Mapping */}
                      {addingMappingFor === appType.id ? (
                        <div className="bg-slate-800 rounded-lg p-4 border border-blue-500/30">
                          <div className="text-xs text-gray-400 mb-2">Select a stored checklist to attach:</div>
                          {storedChecklists.length === 0 ? (
                            <p className="text-sm text-gray-500">No stored checklists available. Upload a checklist first via Compare & Validate.</p>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              {storedChecklists
                                .filter(cl => !typeMappings.some(m => m.checklistId === cl.id))
                                .map(cl => (
                                  <button
                                    key={cl.id}
                                    onClick={() => handleAddMapping(appType.id, cl)}
                                    className="flex items-center space-x-2 p-3 bg-slate-900 rounded-lg border border-slate-600 hover:border-green-500/40 hover:bg-slate-800 transition-all text-left"
                                  >
                                    <FileText className="w-4 h-4 text-green-400 flex-shrink-0" />
                                    <span className="text-sm text-white truncate">{cl.displayName || cl.originalName}</span>
                                  </button>
                                ))}
                            </div>
                          )}
                          <button
                            onClick={() => setAddingMappingFor(null)}
                            className="mt-3 text-xs text-gray-400 hover:text-white transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setAddingMappingFor(appType.id)}
                          className="flex items-center space-x-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          <span>Attach Checklist</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
