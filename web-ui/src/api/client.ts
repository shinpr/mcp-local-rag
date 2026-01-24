// API client for MCP Local RAG backend

const API_BASE = '/api/v1'

/**
 * Search result from query
 */
export interface SearchResult {
  filePath: string
  chunkIndex: number
  text: string
  score: number
  source?: string
}

/**
 * File info from list
 */
export interface FileInfo {
  filePath: string
  chunkCount: number
  source?: string
}

/**
 * System status
 */
export interface SystemStatus {
  totalDocuments: number
  totalChunks: number
  dbSizeBytes: number
  modelName: string
  dbPath: string
}

/**
 * Ingest result
 */
export interface IngestResult {
  filePath: string
  chunkCount: number
  timestamp: string
}

/**
 * API error response
 */
export interface ApiError {
  error: string
}

/**
 * Generic fetch wrapper with error handling
 */
async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error((data as ApiError).error || 'Request failed')
  }

  return data as T
}

/**
 * Search documents
 */
export async function searchDocuments(
  query: string,
  limit?: number
): Promise<SearchResult[]> {
  const data = await fetchApi<{ results: SearchResult[] }>('/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  })
  return data.results
}

/**
 * Upload a file
 */
export async function uploadFile(file: File): Promise<IngestResult> {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_BASE}/files/upload`, {
    method: 'POST',
    body: formData,
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error((data as ApiError).error || 'Upload failed')
  }

  return data as IngestResult
}

/**
 * Ingest content string
 */
export async function ingestData(
  content: string,
  source: string,
  format: 'text' | 'html' | 'markdown'
): Promise<IngestResult> {
  return fetchApi<IngestResult>('/data', {
    method: 'POST',
    body: JSON.stringify({ content, metadata: { source, format } }),
  })
}

/**
 * List ingested files
 */
export async function listFiles(): Promise<FileInfo[]> {
  const data = await fetchApi<{ files: FileInfo[] }>('/files')
  return data.files
}

/**
 * Delete a file or source
 */
export async function deleteFile(options: {
  filePath?: string
  source?: string
}): Promise<void> {
  await fetchApi('/files', {
    method: 'DELETE',
    body: JSON.stringify(options),
  })
}

/**
 * Get system status
 */
export async function getStatus(): Promise<SystemStatus> {
  return fetchApi<SystemStatus>('/status')
}
