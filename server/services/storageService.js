/**
 * Storage Service — Unified abstraction for PDF and metadata file I/O.
 *
 * Supports two backends controlled by env var STORAGE_MODE:
 *   "local" (default) — files live on the local filesystem
 *   "blob"            — files live in Azure Blob Storage
 *
 * Containers / virtual folders in blob:
 *   documents/      — uploaded PDFs + metadata JSONs (CE page viewer)
 *   applications/   — source application PDFs organized FY/NOFO
 *   extractions/    — cached Azure DI extraction JSONs
 *
 * Every public method returns the same shape regardless of backend so
 * callers never need to know which storage is active.
 */

import { BlobServiceClient } from '@azure/storage-blob'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

// ── Configuration ──────────────────────────────────────────────────────
const STORAGE_MODE = (process.env.STORAGE_MODE || 'local').toLowerCase()  // 'local' | 'blob'
const BLOB_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || ''
const BLOB_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'cereviewtool'

// Local directory roots (used when STORAGE_MODE === 'local', and as
// fallback read paths when blob is primary)
const LOCAL_DIRS = {
  documents: path.join(PROJECT_ROOT, 'documents'),
  applications: path.join(PROJECT_ROOT, 'applications'),
  extractions: path.join(PROJECT_ROOT, 'extractions'),
}

// ── Lazy-initialized blob client ────────────────────────────────────────
let _blobServiceClient = null
let _containerClient = null

function getBlobContainer() {
  if (!_containerClient) {
    if (!BLOB_CONNECTION_STRING) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING is required when STORAGE_MODE=blob')
    }
    _blobServiceClient = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING)
    _containerClient = _blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME)
  }
  return _containerClient
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Ensure a local directory exists */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

/** Convert a category + relative name into a blob name: "documents/abc.pdf" */
function blobName(category, relativePath) {
  return `${category}/${relativePath}`.replace(/\\/g, '/')
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if the service is using blob storage.
 */
export function isBlob() {
  return STORAGE_MODE === 'blob'
}

/**
 * Get the current storage mode string.
 */
export function getStorageMode() {
  return STORAGE_MODE
}

/**
 * Get the local directory for a category (useful for local-mode callers).
 */
export function getLocalDir(category) {
  return LOCAL_DIRS[category] || path.join(PROJECT_ROOT, category)
}

// ── WRITE ───────────────────────────────────────────────────────────────

/**
 * Save a buffer (PDF, JSON, etc.) to storage.
 * @param {string} category - 'documents' | 'applications' | 'extractions'
 * @param {string} relativePath - e.g. "abc123-app.pdf" or "FY26/HRSA-26-006/app.pdf"
 * @param {Buffer|string} data - file contents
 * @param {object} [options] - { contentType }
 */
export async function saveFile(category, relativePath, data, options = {}) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data

  if (STORAGE_MODE === 'blob') {
    const container = getBlobContainer()
    const blockBlob = container.getBlockBlobClient(blobName(category, relativePath))
    await blockBlob.upload(buf, buf.length, {
      blobHTTPHeaders: { blobContentType: options.contentType || 'application/octet-stream' }
    })
  }

  // Always write locally too (local cache / fallback)
  const localDir = getLocalDir(category)
  const fullPath = path.join(localDir, relativePath)
  await ensureDir(path.dirname(fullPath))
  await fs.writeFile(fullPath, buf)

  return fullPath
}

/**
 * Save JSON data to storage.
 */
export async function saveJSON(category, relativePath, obj) {
  const json = JSON.stringify(obj, null, 2)
  return saveFile(category, relativePath, json, { contentType: 'application/json' })
}

// ── READ ────────────────────────────────────────────────────────────────

/**
 * Read a file as a Buffer.
 * In blob mode: tries blob first, falls back to local.
 * In local mode: reads from local disk.
 */
export async function readFile(category, relativePath) {
  if (STORAGE_MODE === 'blob') {
    try {
      const container = getBlobContainer()
      const blob = container.getBlockBlobClient(blobName(category, relativePath))
      const downloadResponse = await blob.download(0)
      return await streamToBuffer(downloadResponse.readableStreamBody)
    } catch (err) {
      // Fallback to local
      if (err.statusCode === 404) {
        return fs.readFile(path.join(getLocalDir(category), relativePath))
      }
      throw err
    }
  }
  return fs.readFile(path.join(getLocalDir(category), relativePath))
}

/**
 * Read a file as a UTF-8 string.
 */
export async function readFileText(category, relativePath) {
  const buf = await readFile(category, relativePath)
  return buf.toString('utf-8')
}

/**
 * Read and parse a JSON file.
 */
export async function readJSON(category, relativePath) {
  const text = await readFileText(category, relativePath)
  return JSON.parse(text)
}

// ── EXISTS ──────────────────────────────────────────────────────────────

/**
 * Check if a file exists.
 */
export async function exists(category, relativePath) {
  if (STORAGE_MODE === 'blob') {
    try {
      const container = getBlobContainer()
      const blob = container.getBlockBlobClient(blobName(category, relativePath))
      return await blob.exists()
    } catch {
      return false
    }
  }
  try {
    await fs.access(path.join(getLocalDir(category), relativePath))
    return true
  } catch {
    return false
  }
}

// ── LIST ────────────────────────────────────────────────────────────────

/**
 * List files under a prefix within a category.
 * @param {string} category
 * @param {string} [prefix] - optional sub-path prefix (e.g. "FY26/HRSA-26-006")
 * @param {object} [options] - { extension: '.pdf', recursive: true }
 * @returns {Promise<Array<{name: string, relativePath: string, size: number}>>}
 */
export async function listFiles(category, prefix = '', options = {}) {
  const { extension, recursive = true } = options

  if (STORAGE_MODE === 'blob') {
    const container = getBlobContainer()
    const blobPrefix = prefix ? `${category}/${prefix}`.replace(/\\/g, '/') : `${category}/`
    const results = []

    for await (const blob of container.listBlobsFlat({ prefix: blobPrefix })) {
      const relPath = blob.name.substring(category.length + 1) // strip "category/"
      if (extension && !relPath.toLowerCase().endsWith(extension.toLowerCase())) continue
      if (!recursive && relPath.includes('/') && relPath.indexOf('/') !== relPath.lastIndexOf('/')) continue
      results.push({
        name: path.basename(relPath),
        relativePath: relPath,
        size: blob.properties.contentLength || 0
      })
    }
    return results
  }

  // Local mode
  const baseDir = path.join(getLocalDir(category), prefix)
  return _listLocalRecursive(baseDir, '', extension, recursive)
}

async function _listLocalRecursive(baseDir, subPath, extension, recursive) {
  const results = []
  const dirPath = path.join(baseDir, subPath)
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const relPath = subPath ? `${subPath}/${entry.name}` : entry.name
      if (entry.isFile()) {
        if (extension && !entry.name.toLowerCase().endsWith(extension.toLowerCase())) continue
        const stat = await fs.stat(path.join(dirPath, entry.name))
        results.push({ name: entry.name, relativePath: relPath, size: stat.size })
      } else if (entry.isDirectory() && recursive) {
        results.push(...await _listLocalRecursive(baseDir, relPath, extension, recursive))
      }
    }
  } catch { /* dir may not exist */ }
  return results
}

// ── DELETE ───────────────────────────────────────────────────────────────

/**
 * Delete a file.
 */
export async function deleteFile(category, relativePath) {
  if (STORAGE_MODE === 'blob') {
    try {
      const container = getBlobContainer()
      const blob = container.getBlockBlobClient(blobName(category, relativePath))
      await blob.deleteIfExists()
    } catch { /* ignore */ }
  }
  // Also delete local copy
  try {
    await fs.unlink(path.join(getLocalDir(category), relativePath))
  } catch { /* ignore */ }
}

// ── STREAM (for serving to HTTP response) ───────────────────────────────

/**
 * Stream a file to an Express response.
 * Sets Content-Type and Content-Disposition headers automatically.
 */
export async function streamToResponse(category, relativePath, res, options = {}) {
  const { contentType = 'application/pdf', fileName } = options
  const displayName = fileName || path.basename(relativePath)

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `inline; filename="${displayName}"`)

  if (STORAGE_MODE === 'blob') {
    try {
      const container = getBlobContainer()
      const blob = container.getBlockBlobClient(blobName(category, relativePath))
      const downloadResponse = await blob.download(0)
      downloadResponse.readableStreamBody.pipe(res)
      return true
    } catch (err) {
      if (err.statusCode === 404) {
        // Fall through to local
      } else {
        throw err
      }
    }
  }

  // Local fallback
  const localPath = path.join(getLocalDir(category), relativePath)
  try {
    await fs.access(localPath)
    const stream = fsSync.createReadStream(localPath)
    stream.pipe(res)
    return true
  } catch {
    return false
  }
}

// ── SAS URL (for direct browser access, blob mode only) ─────────────────

/**
 * Generate a temporary SAS URL for direct browser access to a blob.
 * Returns null in local mode.
 * @param {string} category
 * @param {string} relativePath
 * @param {number} [expiryMinutes=60]
 */
export async function getSasUrl(category, relativePath, expiryMinutes = 60) {
  if (STORAGE_MODE !== 'blob') return null

  const { BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } = await import('@azure/storage-blob')
  const container = getBlobContainer()
  const blob = container.getBlockBlobClient(blobName(category, relativePath))

  // For SAS, we need the shared key credential
  // Parse from connection string
  const connParts = {}
  BLOB_CONNECTION_STRING.split(';').forEach(part => {
    const [key, ...vals] = part.split('=')
    connParts[key] = vals.join('=')
  })

  const sharedKeyCredential = new StorageSharedKeyCredential(
    connParts.AccountName,
    connParts.AccountKey
  )

  const expiresOn = new Date()
  expiresOn.setMinutes(expiresOn.getMinutes() + expiryMinutes)

  const sasToken = generateBlobSASQueryParameters({
    containerName: BLOB_CONTAINER_NAME,
    blobName: blobName(category, relativePath),
    permissions: BlobSASPermissions.parse('r'),
    expiresOn,
  }, sharedKeyCredential).toString()

  return `${blob.url}?${sasToken}`
}

// ── COPY (local file → storage) ─────────────────────────────────────────

/**
 * Copy a local file into storage. Useful for batch processing where
 * PDFs start on local disk and need to be registered in blob.
 */
export async function importLocalFile(localPath, category, relativePath, options = {}) {
  const buf = await fs.readFile(localPath)
  return saveFile(category, relativePath, buf, options)
}

// ── INIT (ensure container exists in blob mode) ─────────────────────────

/**
 * Initialize storage. Call once at server startup.
 * In blob mode, creates the container if it doesn't exist.
 * In local mode, creates the local directories.
 */
export async function initialize() {
  console.log(`📦 Storage mode: ${STORAGE_MODE.toUpperCase()}`)

  if (STORAGE_MODE === 'blob') {
    if (!BLOB_CONNECTION_STRING) {
      console.error('❌ AZURE_STORAGE_CONNECTION_STRING is required when STORAGE_MODE=blob')
      console.log('   Falling back to local storage')
      // Don't crash — allow graceful degradation
      return
    }
    try {
      const container = getBlobContainer()
      await container.createIfNotExists({ access: 'blob' })
      console.log(`   Container: ${BLOB_CONTAINER_NAME} ✅`)
    } catch (err) {
      console.error(`❌ Blob init failed: ${err.message}`)
    }
  }

  // Always ensure local dirs exist (for caching / fallback)
  for (const dir of Object.values(LOCAL_DIRS)) {
    await ensureDir(dir)
  }
  console.log(`   Local dirs ready ✅`)
}

// ── Internal helpers ────────────────────────────────────────────────────

async function streamToBuffer(readableStream) {
  const chunks = []
  for await (const chunk of readableStream) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// ── Default export ──────────────────────────────────────────────────────
export default {
  isBlob,
  getStorageMode,
  getLocalDir,
  saveFile,
  saveJSON,
  readFile,
  readFileText,
  readJSON,
  exists,
  listFiles,
  deleteFile,
  streamToResponse,
  getSasUrl,
  importLocalFile,
  initialize,
}
