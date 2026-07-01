// TypeScript types for API responses

export interface AuthResponse {
  id: number
  email: string
  username: string
  token: string
}

export interface UserResponse {
  id: number
  email: string
  username: string
}

export interface ProjectResponse {
  id: number
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectDetailResponse extends ProjectResponse {
  stats: {
    documentCount: number
    chunkCount: number
  }
}

export interface FileResponse {
  id: number
  originalFilename: string
  fileType: string
  fileSize: number
  sha256Hash: string | null
  indexingStatus: string
  chunkCount: number
  errorMessage: string | null
}

export interface UploadResponse {
  id: number
  originalFilename: string
  fileType: string
  fileSize: number
  sha256Hash: string | null
  indexingStatus: string
}

export interface IndexJobResponse {
  jobId: number
  status: string
  filesQueued: number
}

export interface SearchResultItem {
  content: string
  source: string
  filename: string
  chunkIndex: number
  score: number
}

export interface SearchResponse {
  projectName: string
  query: string
  results: SearchResultItem[]
  warning?: string
}

export interface HealthResponse {
  status: 'ok'
  version: string
  uptime: number
}
