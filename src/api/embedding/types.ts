// Embedding provider types for API-configurable embeddings

export const EMBEDDING_PROVIDERS = [
  'local',
  'lm_studio',
  'nvidia_nim',
  'openai',
  'openai_compatible',
] as const

export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number]

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

export interface ResolvedEmbeddingSettings {
  provider: EmbeddingProvider
  apiBaseUrl: string | null
  apiKey: string | null
  modelName: string
}

export interface DefaultEmbeddingInfo {
  provider: EmbeddingProvider
  modelName: string
  dimensions: number
  description: string
  equivalentProviderOptions: Array<{
    provider: EmbeddingProvider
    modelName: string
    note: string
  }>
}
