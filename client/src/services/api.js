import axios from 'axios'

const API_BASE_URL = '/api'

const apiClient = axios.create({
  baseURL: API_BASE_URL,
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
