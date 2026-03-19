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
    mocks.Embedder.mockReset()
  })

  it('should construct VectorStore with dbPath and tableName from config', () => {
    const config = makeConfig({ dbPath: '/data/my-db' })

    createVectorStore(config)

    expect(mocks.VectorStore).toHaveBeenCalledOnce()
    expect(mocks.VectorStore).toHaveBeenCalledWith({
      dbPath: '/data/my-db',
      tableName: 'chunks',
    })
  })

  it('should always use "chunks" as tableName regardless of config', () => {
    createVectorStore(makeConfig({ dbPath: './other-db' }))

    expect(mocks.VectorStore).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'chunks' }))
  })

  it('should return a VectorStore instance (not call initialize)', () => {
    const result = createVectorStore(makeConfig())

    // Verify we got the mock instance back (constructed via new)
    expect(result).toBeDefined()
    expect(mocks.VectorStore).toHaveBeenCalledOnce()
  })
})

describe('createEmbedder', () => {
  afterEach(() => {
    mocks.VectorStore.mockReset()
    mocks.Embedder.mockReset()
  })

  it('should construct Embedder with modelPath, batchSize, and cacheDir from config', () => {
    const config = makeConfig({
      modelName: 'custom/model',
      cacheDir: '/custom/cache',
    })

    createEmbedder(config)

    expect(mocks.Embedder).toHaveBeenCalledOnce()
    expect(mocks.Embedder).toHaveBeenCalledWith({
      modelPath: 'custom/model',
      batchSize: 16,
      cacheDir: '/custom/cache',
    })
  })

  it('should map modelName to modelPath in Embedder config', () => {
    createEmbedder(makeConfig({ modelName: 'some/other-model' }))

    expect(mocks.Embedder).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'some/other-model' })
    )
  })

  it('should use batchSize of 16', () => {
    createEmbedder(makeConfig())

    expect(mocks.Embedder).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 16 }))
  })

  it('should use default config values correctly', () => {
    const config = makeConfig()

    createEmbedder(config)

    expect(mocks.Embedder).toHaveBeenCalledWith({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 16,
      cacheDir: './test-cache/',
    })
  })
})
