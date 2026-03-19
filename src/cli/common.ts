// Shared CLI component helpers — factory functions for VectorStore and Embedder

import { Embedder } from '../embedder/index.js'
import { VectorStore } from '../vectordb/index.js'
import type { ResolvedGlobalConfig } from './options.js'

/**
 * Create an uninitialized VectorStore from resolved global config.
 * Callers are responsible for calling initialize() before use.
 */
export function createVectorStore(config: ResolvedGlobalConfig): VectorStore {
  return new VectorStore({
    dbPath: config.dbPath,
    tableName: 'chunks',
  })
}

/**
 * Create an uninitialized Embedder from resolved global config.
 * Callers are responsible for managing the Embedder lifecycle.
 */
export function createEmbedder(config: ResolvedGlobalConfig): Embedder {
  return new Embedder({
    modelPath: config.modelName,
    batchSize: 16,
    cacheDir: config.cacheDir,
  })
}
