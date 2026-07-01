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

/** Dev-only credentials for login form prefill (empty in production). */
export interface AuthDefaultsResponse {
  email?: string
  username?: string
  password?: string
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
  /** Present when the same file content was already uploaded to this project */
  duplicate?: boolean
  message?: string
  replaced?: boolean
}

export interface UploadFileResult extends UploadResponse {
  duplicate: boolean
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
  /** Present when metadata shows indexed chunks but LanceDB returned no hits */
  warning?: string
}

export interface HealthResponse {
  status: 'ok'
  version: string
  uptime: number
}

export interface ApiError {
  error: string
  message: string
}
