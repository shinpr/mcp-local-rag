// Deferred RAG service references — populated after embedder/vector store init

import type { Embedder } from '../embedder/index.js'
import type { VectorStore } from '../vectordb/index.js'

export interface RagServices {
  vectorStore: VectorStore | null
  embedder: Embedder | null
}

export function createRagServices(): RagServices {
  return { vectorStore: null, embedder: null }
}

export function getVectorStore(services: RagServices): VectorStore {
  if (!services.vectorStore) throw new Error('VectorStore not initialized')
  return services.vectorStore
}

export function getEmbedder(services: RagServices): Embedder {
  if (!services.embedder) throw new Error('Embedder not initialized')
  return services.embedder
}
