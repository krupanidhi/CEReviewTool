import axios from 'axios'

const API_BASE_URL = '/api'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10 * 60 * 1000, // 10 minutes per request (chunked processing)
  headers: {
    'Content-Type': 'application/json'
  }
})

/**
 * Upload a document for analysis
 * @param {File} file - The file to upload
 * @returns {Promise<Object>} Upload result with analysis data
 */
export async function uploadDocument(file) {
  try {
    const formData = new FormData()
    formData.append('file', file)

    const response = await apiClient.post('/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    })

    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to upload document')
  }
}

/**
 * Get list of all documents
 * @returns {Promise<Object>} List of documents
 */
export async function getDocuments() {
  try {
    const response = await apiClient.get('/documents')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to fetch documents')
  }
}

/**
 * Get a specific document by ID
 * @param {string} id - Document ID
 * @returns {Promise<Object>} Document details
 */
export async function getDocumentById(id) {
  try {
    const response = await apiClient.get(`/documents/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to fetch document')
  }
}

/**
 * Delete a document
 * @param {string} id - Document ID
 * @returns {Promise<Object>} Delete result
 */
export async function deleteDocument(id) {
  try {
    const response = await apiClient.delete(`/documents/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to delete document')
  }
}

/**
 * Download structured JSON for a document
 * @param {string} id - Document ID
 * @returns {Promise<Object>} Structured document data
 */
export async function downloadStructuredJSON(id) {
  try {
    const response = await apiClient.get(`/documents/${id}/structured`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to download structured JSON')
  }
}

/**
 * Analyze document data with AI
 * @param {Object} documentData - Extracted document data
 * @param {string} prompt - Optional custom prompt
 * @returns {Promise<Object>} AI analysis result
 */
export async function analyzeDocument(documentData, prompt = null) {
  try {
    const response = await apiClient.post('/analyze', {
      documentData,
      prompt
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to analyze document')
  }
}

/**
 * Validate document against checklist
 * @param {Object} documentData - Extracted document data
 * @param {Array} checklist - Validation checklist items
 * @returns {Promise<Object>} Validation results
 */
export async function validateWithChecklist(documentData, checklist) {
  try {
    const response = await apiClient.post('/analyze/validate', {
      documentData,
      checklist
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to validate document')
  }
}

/**
 * Compare application document against checklist
 * @param {Object} applicationData - Extracted application data
 * @param {Object} checklistData - Extracted checklist data
 * @returns {Promise<Object>} Comparison results
 */
export async function compareDocuments(applicationData, checklistData) {
  try {
    const response = await apiClient.post('/compare', {
      applicationData,
      checklistData
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to compare documents')
  }
}

/**
 * Chat with fine-tuned model
 * @param {string} message - User message
 * @param {Array} history - Conversation history
 * @param {Object} context - Optional document context
 * @returns {Promise<Object>} Chat response
 */
export async function chatWithModel(message, history = [], context = null) {
  try {
    const response = await apiClient.post('/chat', {
      message,
      history,
      context
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to send chat message')
  }
}

/**
 * Get settings
 * @returns {Promise<Object>} Settings and cache stats
 */
export async function getSettings() {
  try {
    const response = await apiClient.get('/settings')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to get settings')
  }
}

/**
 * Update settings
 * @param {Object} settings - Settings to update
 * @returns {Promise<Object>} Updated settings
 */
export async function updateSettings(settings) {
  try {
    const response = await apiClient.put('/settings', settings)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to update settings')
  }
}

/**
 * Get cache data
 * @param {string} type - Cache type (analysis, keyvalue, or all)
 * @param {string} documentId - Optional document ID filter
 * @returns {Promise<Object>} Cache data
 */
export async function getCacheData(type = null, documentId = null) {
  try {
    const params = {}
    if (type) params.type = type
    if (documentId) params.documentId = documentId
    
    const response = await apiClient.get('/settings/cache', { params })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to get cache data')
  }
}

/**
 * Clear cache
 * @param {string} type - Cache type to clear (all, analysis, keyvalue)
 * @returns {Promise<Object>} Result
 */
export async function clearCache(type = 'all') {
  try {
    const response = await apiClient.delete('/settings/cache', { params: { type } })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to clear cache')
  }
}

/**
 * Get program-specific questions with user-provided answers
 * @returns {Promise<Object>} Questions and user answers
 */
export async function getQAQuestions() {
  try {
    const response = await apiClient.get('/qa-comparison/questions')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to get questions')
  }
}

/**
 * Run QA comparison analysis - AI derives answers from application and compares with user answers
 * @param {Object} applicationData - Extracted application data
 * @returns {Promise<Object>} Comparison results
 */
export async function runQAComparison(applicationData) {
  try {
    const response = await apiClient.post('/qa-comparison/analyze', {
      applicationData
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to run QA comparison')
  }
}

/**
 * Get standard checklist questions with user-provided answers
 * @returns {Promise<Object>} Questions, user answers, and metadata
 */
export async function getStandardQuestions() {
  try {
    const response = await apiClient.get('/qa-comparison/standard-questions')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to get standard questions')
  }
}

/**
 * Run Standard Checklist comparison analysis
 * @param {Object} applicationData - Extracted application data
 * @returns {Promise<Object>} Comparison results with metadata
 */
export async function runStandardComparison(applicationData) {
  try {
    const response = await apiClient.post('/qa-comparison/standard-analyze', {
      applicationData
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to run standard comparison')
  }
}

// ============================================================
// Stored Checklists API
// ============================================================

/**
 * List all stored checklists (metadata only)
 * @returns {Promise<Object>} List of stored checklists
 */
export async function getStoredChecklists() {
  try {
    const response = await apiClient.get('/stored-checklists')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to list stored checklists')
  }
}

/**
 * Load a stored checklist by ID (full data for comparison)
 * @param {string} id - Stored checklist ID
 * @returns {Promise<Object>} Full checklist data
 */
export async function loadStoredChecklist(id) {
  try {
    const response = await apiClient.get(`/stored-checklists/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to load stored checklist')
  }
}

/**
 * Save a checklist for future reuse (after initial upload + extraction)
 * @param {string} originalName - Original filename
 * @param {Object} data - Extracted analysis data
 * @param {Object} structuredData - Structured transformation data
 * @param {string} label - Optional display name
 * @returns {Promise<Object>} Save result
 */
export async function saveStoredChecklist(originalName, data, structuredData, label = null) {
  try {
    const response = await apiClient.post('/stored-checklists/save', {
      originalName,
      data,
      structuredData,
      label
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to save checklist')
  }
}

/**
 * Delete a stored checklist
 * @param {string} id - Stored checklist ID
 * @returns {Promise<Object>} Delete result
 */
export async function deleteStoredChecklist(id) {
  try {
    const response = await apiClient.delete(`/stored-checklists/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to delete stored checklist')
  }
}

/**
 * Rename a stored checklist
 * @param {string} id - Stored checklist ID
 * @param {string} displayName - New display name
 * @returns {Promise<Object>} Updated checklist metadata
 */
export async function renameStoredChecklist(id, displayName) {
  try {
    const response = await apiClient.put(`/stored-checklists/${id}/rename`, { displayName })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to rename checklist')
  }
}

// ============================================================
// Processed Applications API
// ============================================================

/**
 * List all processed applications (metadata only)
 * @returns {Promise<Object>} List of processed applications and status
 */
export async function getProcessedApplications() {
  try {
    const response = await apiClient.get('/processed-applications')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to list processed applications')
  }
}

/**
 * Get processing queue status
 * @returns {Promise<Object>} Queue status summary
 */
export async function getProcessingStatus() {
  try {
    const response = await apiClient.get('/processed-applications/status')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to get processing status')
  }
}

/**
 * Get a single processed application with full cached data
 * @param {string} id - Application ID
 * @returns {Promise<Object>} Full application data
 */
export async function getProcessedApplication(id) {
  try {
    const response = await apiClient.get(`/processed-applications/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to get processed application')
  }
}

/**
 * Queue applications for background processing
 * @param {Array} applications - Array of { name, data } objects
 * @param {Object} checklistData - Checklist data for comparison
 * @param {Array} selectedSections - Selected checklist sections
 * @param {string} checklistName - Name of the checklist
 * @returns {Promise<Object>} Queued application metadata
 */
export async function queueApplications(applications, checklistData, selectedSections, checklistName) {
  try {
    const response = await apiClient.post('/processed-applications/queue', {
      applications,
      checklistData,
      selectedSections,
      checklistName
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to queue applications')
  }
}

/**
 * Save an already-completed comparison result to the processed applications cache
 * @param {string} applicationName - Application name
 * @param {string} checklistName - Checklist name
 * @param {Object} comparisonResult - The full comparison result object
 * @returns {Promise<Object>} Saved application metadata
 */
export async function saveProcessedApplication(applicationName, checklistName, comparisonResult, selectedSections = null, applicationId = null) {
  try {
    const response = await apiClient.post('/processed-applications/save', {
      applicationName,
      checklistName,
      comparisonResult,
      selectedSections,
      applicationId
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to save processed application')
  }
}

/**
 * Delete a processed application
 * @param {string} id - Application ID
 * @returns {Promise<Object>} Delete result
 */
export async function deleteProcessedApplication(id) {
  try {
    const response = await apiClient.delete(`/processed-applications/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to delete processed application')
  }
}

/**
 * Delete ALL processed applications and their cached data
 * @returns {Promise<Object>} Delete result with count
 */
export async function deleteAllProcessedApplications() {
  try {
    const response = await apiClient.delete('/processed-applications/all')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to delete all processed applications')
  }
}

/**
 * Reprocess an application (clear cache and re-run comparison)
 * @param {string} id - Application ID
 * @param {Object} data - { applicationData, checklistData, selectedSections }
 * @returns {Promise<Object>} Reprocess result
 */
export async function reprocessApplication(id, data = {}) {
  try {
    const response = await apiClient.post(`/processed-applications/${id}/reprocess`, data)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to reprocess application')
  }
}

// ============================================================
// Admin API
// ============================================================

/**
 * Get all document mappings (application type -> required checklists)
 * @returns {Promise<Object>} Application types and mappings
 */
export async function getDocumentMappings() {
  try {
    const response = await apiClient.get('/admin/mappings')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to load mappings')
  }
}

/**
 * Add a new application type
 * @param {string} name - Application type name
 * @param {string} description - Description
 * @returns {Promise<Object>} Updated application types
 */
export async function addApplicationType(name, description = '') {
  try {
    const response = await apiClient.post('/admin/application-types', { name, description })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to add application type')
  }
}

/**
 * Delete an application type
 * @param {string} id - Application type ID
 * @returns {Promise<Object>} Updated application types
 */
export async function deleteApplicationType(id) {
  try {
    const response = await apiClient.delete(`/admin/application-types/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to delete application type')
  }
}

/**
 * Update an application type
 * @param {string} id - Application type ID
 * @param {Object} updates - { name, description }
 * @returns {Promise<Object>} Updated application types
 */
export async function updateApplicationType(id, updates) {
  try {
    const response = await apiClient.put(`/admin/application-types/${id}`, updates)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to update application type')
  }
}

/**
 * Add a checklist requirement mapping
 * @param {string} applicationTypeId - Application type ID
 * @param {string} checklistId - Checklist ID
 * @param {string} checklistName - Checklist display name
 * @param {boolean} required - Whether the checklist is required
 * @returns {Promise<Object>} Updated mappings
 */
export async function addDocumentMapping(applicationTypeId, checklistId, checklistName, required = true) {
  try {
    const response = await apiClient.post('/admin/mappings', {
      applicationTypeId, checklistId, checklistName, required
    })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to add mapping')
  }
}

/**
 * Delete a checklist requirement mapping
 * @param {string} id - Mapping ID
 * @returns {Promise<Object>} Updated mappings
 */
export async function deleteDocumentMapping(id) {
  try {
    const response = await apiClient.delete(`/admin/mappings/${id}`)
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to delete mapping')
  }
}

/**
 * Save processing logs to server as a text file
 * @param {Array} logs - Array of log entries
 * @param {string} sessionId - Optional session identifier
 * @returns {Promise<Object>} Save result with filename and path
 */
export async function saveLogsToServer(logs, sessionId) {
  try {
    const response = await apiClient.post('/logs/save', { logs, sessionId })
    return response.data
  } catch (error) {
    console.warn('Failed to save logs to server:', error.message)
    return null
  }
}

/**
 * Get server configuration (endpoints, folder paths) for UI logging
 * @returns {Promise<Object>} Config with endpoints and folders
 */
export async function getConfig() {
  try {
    const response = await apiClient.get('/config')
    return response.data
  } catch (error) {
    console.warn('Failed to fetch config:', error.message)
    return null
  }
}

/**
 * Check API health
 * @returns {Promise<Object>} Health status
 */
export async function checkHealth() {
  try {
    const response = await apiClient.get('/health')
    return response.data
  } catch (error) {
    throw new Error('API is not available')
  }
}

// ============================================================
// Applications Browser API
// ============================================================

/**
 * Browse applications organized by FY → NOFO → PDF files
 * @returns {Promise<Object>} Folder structure with fiscal years, NOFOs, and application files
 */
export async function browseApplications() {
  try {
    const response = await apiClient.get('/applications/browse')
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to browse applications')
  }
}

/**
 * Extract an application PDF from the applications folder using Azure DI.
 * Uses cached extraction if available.
 * @param {string} relPath - Relative path within applications/ (e.g., "FY26/HRSA-26-002/file.pdf")
 * @returns {Promise<Object>} Extracted application data
 */
export async function extractApplicationFromFolder(relPath) {
  try {
    const response = await apiClient.post('/applications/extract', { path: relPath })
    return response.data
  } catch (error) {
    throw new Error(error.response?.data?.message || error.message || 'Failed to extract application')
  }
}
