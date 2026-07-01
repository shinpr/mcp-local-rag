import { apiClient } from './client'

export interface SkillGenerateResponse {
  projectName: string
  skillMarkdown: string
}

export interface AgentsGenerateResponse {
  projectName: string
  agentsBlock: string
}

export async function generateSkill(
  projectName: string,
  task?: string,
): Promise<SkillGenerateResponse> {
  return apiClient.post<SkillGenerateResponse>('/skill/generate', {
    projectName,
    task,
  })
}

export async function generateAgentsBlock(
  projectName: string,
  repoPath?: string,
): Promise<AgentsGenerateResponse> {
  return apiClient.post<AgentsGenerateResponse>('/agents/generate', {
    projectName,
    repoPath,
  })
}
