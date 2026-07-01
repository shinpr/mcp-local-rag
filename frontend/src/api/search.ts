import { apiClient } from './client'
import type { SearchResponse } from '../types/api'

export async function searchProject(
  projectName: string,
  query: string,
  limit?: number,
): Promise<SearchResponse> {
  return apiClient.post<SearchResponse>('/search', {
    projectName,
    query,
    limit,
  })
}
