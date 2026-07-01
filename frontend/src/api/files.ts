import { apiClient } from './client'
import type {
  FileResponse,
  UploadResponse,
  IndexJobResponse,
} from '../types/api'

export async function getProjectFiles(
  projectId: number,
): Promise<FileResponse[]> {
  return apiClient.get<FileResponse[]>(`/projects/${projectId}/files`)
}

export async function uploadFile(
  projectId: number,
  file: File,
): Promise<UploadResponse> {
  return apiClient.upload<UploadResponse>(
    `/projects/${projectId}/files/upload`,
    file,
  )
}

export async function deleteFile(fileId: number): Promise<{ deleted: boolean }> {
  return apiClient.delete<{ deleted: boolean }>(`/files/${fileId}`)
}

export async function indexProject(
  projectId: number,
  fileIds?: number[],
): Promise<IndexJobResponse> {
  return apiClient.post<IndexJobResponse>(`/projects/${projectId}/index`, {
    fileIds,
  })
}

export async function reindexProject(
  projectId: number,
): Promise<{ jobId: number; status: string }> {
  return apiClient.post(`/projects/${projectId}/reindex`)
}

export async function reindexFile(
  fileId: number,
): Promise<{ jobId: number; status: string }> {
  return apiClient.post(`/files/${fileId}/reindex`)
}

export async function getJobStatus(
  jobId: number,
): Promise<{
  id: number
  status: string
  filesProcessed: number
  chunksCreated: number
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}> {
  return apiClient.get(`/jobs/${jobId}`)
}
