import { apiClient } from './client'

export interface CursorConfigResponse {
  mcpConfigPath: string
  projectRoot: string
  mcpCommand: string
  mcpArgs: string[]
  configExists: boolean
  alreadyConfigured: boolean
  mcpConfig: {
    mcpServers: Record<string, {
      command: string
      args: string[]
      cwd: string
      env: Record<string, string>
    }>
  }
}

export interface CursorSetupResponse {
  success: boolean
  message: string
  mcpConfigPath: string
  backupPath: string | null
}

export async function getCursorConfig(): Promise<CursorConfigResponse> {
  return apiClient.get<CursorConfigResponse>('/cursor/config')
}

export async function setupCursor(): Promise<CursorSetupResponse> {
  return apiClient.post<CursorSetupResponse>('/cursor/setup')
}
