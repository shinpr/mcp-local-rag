import { apiClient } from './client'
import type { ProjectResponse, ProjectDetailResponse } from '../types/api'

export async function getProjects(): Promise<ProjectResponse[]> {
  return apiClient.get<ProjectResponse[]>('/projects')
}

export async function getProject(id: number): Promise<ProjectDetailResponse> {
  return apiClient.get<ProjectDetailResponse>(`/projects/${id}`)
}

export async function createProject(
  name: string,
  description?: string,
): Promise<ProjectResponse> {
  return apiClient.post<ProjectResponse>('/projects', { name, description })
}

export async function deleteProject(id: number): Promise<{ deleted: boolean }> {
  return apiClient.delete<{ deleted: boolean }>(`/projects/${id}`)
}
