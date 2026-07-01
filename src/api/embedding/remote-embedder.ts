// OpenAI-compatible remote embedding client (LM Studio, NIM, OpenAI, etc.)

import { AppError } from '../../utils/errors.js'
import type { EmbeddingClient } from './types.js'

export class RemoteEmbeddingError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'embedder', 'internal', cause)
    this.name = 'RemoteEmbeddingError'
  }
}

interface RemoteEmbedderConfig {
  apiBaseUrl: string
  apiKey: string | null
  modelName: string
}

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
}

export class RemoteEmbedder implements EmbeddingClient {
  private readonly config: RemoteEmbedderConfig

  constructor(config: RemoteEmbedderConfig) {
    this.config = config
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text])
    if (!embedding) {
      throw new RemoteEmbeddingError('Remote API returned no embedding')
    }
    return embedding
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    if (texts.some((text) => text.length === 0)) {
      throw new RemoteEmbeddingError('Cannot generate embedding for empty text')
    }

    const baseUrl = this.config.apiBaseUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.modelName,
          input: texts,
        }),
      })
    } catch (error) {
      throw new RemoteEmbeddingError(
        `Failed to reach embedding API at ${baseUrl}: ${(error as Error).message}`,
        error as Error
      )
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new RemoteEmbeddingError(
        `Embedding API error (${response.status}): ${body || response.statusText}`
      )
    }

    let payload: OpenAiEmbeddingResponse
    try {
      payload = (await response.json()) as OpenAiEmbeddingResponse
    } catch (error) {
      throw new RemoteEmbeddingError('Embedding API returned invalid JSON', error as Error)
    }

    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new RemoteEmbeddingError('Embedding API returned unexpected data length')
    }

    const sorted = [...payload.data].sort((a, b) => a.index - b.index)
    return sorted.map((item) => item.embedding)
  }
}
