import type { SettingsResponse } from '../types/api'
import { apiClient } from './client'

export async function getSettings(): Promise<SettingsResponse> {
  return apiClient.get<SettingsResponse>('/settings')
}

export async function updateSettings(data: {
  embeddingProvider: string
  apiBaseUrl?: string | null
  apiKey?: string | null
  modelName?: string | null
}): Promise<SettingsResponse> {
  return apiClient.put<SettingsResponse>('/settings', data)
}
