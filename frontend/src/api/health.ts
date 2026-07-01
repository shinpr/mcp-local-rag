import { apiClient } from './client'
import type { HealthResponse } from '../types/api'

export async function getHealth(): Promise<HealthResponse> {
  return apiClient.get<HealthResponse>('/health')
}
