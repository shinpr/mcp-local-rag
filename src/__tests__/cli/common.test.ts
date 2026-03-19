// CLI Common Helpers Tests
// Test Type: Unit Test
// Tests createVectorStore and createEmbedder factory functions

import { afterEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    VectorStore: vi.fn(),
    Embedder: vi.fn(),
  }
})

// Mock VectorStore
vi.mock('../../vectordb/index.js', () => ({
  VectorStore: mocks.VectorStore,
}))

// Mock Embedder
vi.mock('../../embedder/index.js', () => ({
  Embedder: mocks.Embedder,
}))

import { createEmbedder, createVectorStore } from '../../cli/common.js'
import type { ResolvedGlobalConfig } from '../../cli/options.js'

// ============================================
// Test Data
// ============================================

function makeConfig(overrides: Partial<ResolvedGlobalConfig> = {}): ResolvedGlobalConfig {
  return {
    dbPath: './test-db/',
    cacheDir: './test-cache/',
    modelName: 'Xenova/all-MiniLM-L6-v2',
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

describe('createVectorStore', () => {
  afterEach(() => {
    mocks.VectorStore.mockReset()
  })

  it('should construct VectorStore with dbPath from config', () => {
    createVectorStore(makeConfig({ dbPath: '/data/my-db' }))

    expect(mocks.VectorStore).toHaveBeenCalledOnce()
    expect(mocks.VectorStore).toHaveBeenCalledWith({
      dbPath: '/data/my-db',
      tableName: 'chunks',
    })
  })
})

describe('createEmbedder', () => {
  afterEach(() => {
    mocks.Embedder.mockReset()
  })

  it('should map modelName to modelPath in Embedder config', () => {
    createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

    expect(mocks.Embedder).toHaveBeenCalledOnce()
    expect(mocks.Embedder).toHaveBeenCalledWith({
      modelPath: 'custom/model',
      batchSize: 16,
      cacheDir: '/custom/cache',
    })
  })
})
