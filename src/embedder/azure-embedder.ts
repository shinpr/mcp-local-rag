// Azure OpenAI Embedder implementation
// Uses openai package with Azure configuration

import { AzureOpenAI } from 'openai'

// ============================================
// Type Definitions
// ============================================

/**
 * Azure Embedder configuration
 */
export interface AzureEmbedderConfig {
  /** Azure OpenAI API key */
  apiKey: string
  /** Azure OpenAI endpoint */
  endpoint: string
  /** Azure OpenAI deployment name */
  deployment: string
  /** API version */
  apiVersion?: string
}

// ============================================
// Error Classes
// ============================================

/**
 * Azure embedding generation error
 */
export class AzureEmbeddingError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'AzureEmbeddingError'
  }
}

// ============================================
// AzureEmbedder Class
// ============================================

/**
 * Cloud embedding generation class using Azure OpenAI
 *
 * Responsibilities:
 * - Generate embedding vectors using Azure text-embedding-3-small
 * - Azure OpenAI SDK wrapper
 * - Batch processing
 */
export class AzureEmbedder {
  private readonly client: AzureOpenAI
  private readonly config: AzureEmbedderConfig

  constructor(config: AzureEmbedderConfig) {
    this.config = config
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      deployment: config.deployment,
      apiVersion: config.apiVersion ?? '2023-05-15',
    })
  }

  /**
   * Convert single text to embedding vector
   *
   * @param text - Text to embed
   * @returns Embedding vector (1536 dimensions for text-embedding-3-small)
   */
  async embed(text: string): Promise<number[]> {
    if (text.length === 0) {
      throw new AzureEmbeddingError('Cannot generate embedding for empty text')
    }

    try {
      const response = await this.client.embeddings.create({
        input: text,
        model: this.config.deployment,
      })

      const embedding = response.data[0]?.embedding
      if (!embedding) {
        throw new AzureEmbeddingError('No embedding returned from Azure OpenAI')
      }

      return embedding
    } catch (error) {
      if (error instanceof AzureEmbeddingError) {
        throw error
      }
      throw new AzureEmbeddingError(
        `Failed to generate embedding: ${(error as Error).message}`,
        error as Error
      )
    }
  }

  /**
   * Convert multiple texts to embedding vectors
   *
   * @param texts - Array of texts
   * @returns Array of embedding vectors
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return []
    }

    try {
      const response = await this.client.embeddings.create({
        input: texts,
        model: this.config.deployment,
      })

      return response.data.map((item: { embedding: number[] }) => item.embedding)
    } catch (error) {
      throw new AzureEmbeddingError(
        `Failed to generate batch embeddings: ${(error as Error).message}`,
        error as Error
      )
    }
  }
}
