// Built-in default embedding metadata (Transformers.js / env MODEL_NAME)

import type { ApiConfig } from '../config.js'
import type { DefaultEmbeddingInfo, EmbeddingProvider } from './types.js'

export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DEFAULT_EMBEDDING_DIMENSIONS = 384

const EQUIVALENT_REMOTE_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'

export function resolveDefaultModelName(config: ApiConfig): string {
  return config.modelName || DEFAULT_LOCAL_MODEL
}

export function buildDefaultEmbeddingInfo(config: ApiConfig): DefaultEmbeddingInfo {
  const modelName = resolveDefaultModelName(config)

  return {
    provider: 'local',
    modelName,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    description:
      'Local Transformers.js embeddings (default). Runs on-device via Hugging Face ONNX — no external API required.',
    equivalentProviderOptions: [
      {
        provider: 'local',
        modelName,
        note: 'Built-in default. Select “Local (Transformers.js)” with this model name.',
      },
      {
        provider: 'lm_studio',
        modelName: EQUIVALENT_REMOTE_MODEL,
        note: 'Load the same MiniLM model in LM Studio, then point the API URL to your LM Studio server.',
      },
      {
        provider: 'openai_compatible',
        modelName: EQUIVALENT_REMOTE_MODEL,
        note: 'Any OpenAI-compatible server serving all-MiniLM-L6-v2 (384-dim, mean-pooled, normalized).',
      },
      {
        provider: 'nvidia_nim',
        modelName: 'nvidia/nv-embedqa-e5-v5',
        note: 'Different model — vectors will NOT match the built-in default. Use only for new indexes.',
      },
      {
        provider: 'openai',
        modelName: 'text-embedding-3-small',
        note: 'Different model/dimensions — vectors will NOT match the built-in default. Use only for new indexes.',
      },
    ],
  }
}

export function defaultApiBaseUrl(provider: EmbeddingProvider): string | null {
  switch (provider) {
    case 'lm_studio':
      return 'http://localhost:1234/v1'
    case 'nvidia_nim':
      return 'https://integrate.api.nvidia.com/v1'
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'openai_compatible':
    case 'local':
      return null
  }
}

export function isEmbeddingProvider(value: string): value is EmbeddingProvider {
  return (['local', 'lm_studio', 'nvidia_nim', 'openai', 'openai_compatible'] as const).includes(
    value as EmbeddingProvider
  )
}
