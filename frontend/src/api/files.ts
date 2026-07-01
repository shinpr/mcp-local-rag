import { apiClient, ApiClientError } from './client'
import type {
  FileResponse,
  UploadFileResult,
  IndexJobResponse,
} from '../types/api'

export type { UploadFileResult }

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export async function getProjectFiles(
  projectId: number,
): Promise<FileResponse[]> {
  return apiClient.get<FileResponse[]>(`/projects/${projectId}/files`)
}

export async function uploadFile(
  projectId: number,
  file: File,
): Promise<UploadFileResult> {
  try {
    const result = await apiClient.upload<UploadFileResult>(
      `/projects/${projectId}/files/upload`,
      file,
    )
    return { ...result, duplicate: result.duplicate ?? false }
  } catch (error) {
    // Back-compat: older API returned 409 for duplicate content in the same project
    if (error instanceof ApiClientError && error.status === 409) {
      return {
        id: 0,
        originalFilename: file.name,
        fileType: fileExtension(file.name),
        fileSize: file.size,
        sha256Hash: null,
        indexingStatus: 'pending',
        duplicate: true,
        message: 'Already uploaded (same content)',
      }
    }
    throw error
  }
}

export async function replaceFile(
  fileId: number,
  file: File,
): Promise<UploadFileResult> {
  const result = await apiClient.upload<UploadFileResult>(
    `/files/${fileId}/replace`,
    file,
  )
  return { ...result, duplicate: false }
}

export async function downloadFile(fileId: number, filename: string): Promise<void> {
  await apiClient.download(`/files/${fileId}/download`, filename)
}

export async function deleteFile(fileId: number): Promise<{ deleted: boolean }> {
  return apiClient.delete<{ deleted: boolean }>(`/files/${fileId}`)
}

export async function indexProject(
  projectId: number,
  fileIds?: number[],
): Promise<IndexJobResponse> {
  const body = fileIds && fileIds.length > 0 ? { fileIds } : {}
  return apiClient.post<IndexJobResponse>(`/projects/${projectId}/index`, body)
}

export async function resetStuckProject(
  projectId: number,
): Promise<{ jobsFailed: number; filesReset: number }> {
  return apiClient.post(`/projects/${projectId}/reset-stuck`, {})
}

export async function reindexProject(
  projectId: number,
  fileIds?: number[],
): Promise<IndexJobResponse> {
  const body = fileIds && fileIds.length > 0 ? { fileIds } : {}
  return apiClient.post<IndexJobResponse>(`/projects/${projectId}/reindex`, body)
}

export async function reindexFile(fileId: number): Promise<IndexJobResponse> {
  return apiClient.post<IndexJobResponse>(`/files/${fileId}/reindex`, {})
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
