// Deferred RAG service references — populated after embedder/vector store init

import type { Embedder } from '../embedder/index.js'
import type { VectorStore } from '../vectordb/index.js'
import type { EmbeddingService } from './embedding/embedding-service.js'
import type { EmbeddingClient } from './embedding/types.js'

export interface RagServices {
  vectorStore: VectorStore | null
  embedder: Embedder | null
  embeddingService: EmbeddingService | null
}

export function createRagServices(): RagServices {
  return { vectorStore: null, embedder: null, embeddingService: null }
}

export function getVectorStore(services: RagServices): VectorStore {
  if (!services.vectorStore) throw new Error('VectorStore not initialized')
  return services.vectorStore
}

export function getEmbedder(services: RagServices): Embedder {
  if (!services.embedder) throw new Error('Embedder not initialized')
  return services.embedder
}

export function getEmbeddingService(services: RagServices): EmbeddingService {
  if (!services.embeddingService) throw new Error('EmbeddingService not initialized')
  return services.embeddingService
}

export async function getEmbeddingClientForUser(
  services: RagServices,
  userId: number
): Promise<EmbeddingClient> {
  return getEmbeddingService(services).getClientForUser(userId)
}
