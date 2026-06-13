// RAG MCP Server Integration Test - Embedding Generation
// Split from: rag-server.integration.test.ts (AC-003)

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'

describe('AC-003: Vector Embedding Generation', () => {
  // AC interpretation: [Technical requirement] Text chunks are converted to 384-dimensional vectors
  // Validation: Generate embedding from text, 384-dimensional vector is returned
  it('Text chunk properly converted to 384-dimensional vector', async () => {
    const { Embedder } = await import('../../embedder/index.js')
    const embedder = new Embedder(
      withTestDevice({
        modelPath: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 8,
        cacheDir: testModelCacheDir(),
      })
    )

    await embedder.initialize()

    const testText = 'This is a test text for embedding generation.'
    const embedding = await embedder.embed(testText)

    expect(embedding).toBeDefined()
    expect(Array.isArray(embedding)).toBe(true)
    expect(embedding.length).toBe(384)
    expect(embedding.every((value: number) => typeof value === 'number')).toBe(true)
  })

  // AC interpretation: [Technical requirement] all-MiniLM-L6-v2 model is automatically downloaded on first startup and cached on disk
  // Validation: After initialize(), the configured cache directory is populated with model files (observable side effect of the download/cache)
  it('all-MiniLM-L6-v2 model automatically downloaded on first startup and cached in models/ directory', async () => {
    const cacheDir = './tmp/models'
    const { Embedder } = await import('../../embedder/index.js')
    const embedder = new Embedder(
      withTestDevice({
        modelPath: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 8,
        cacheDir,
      })
    )

    // Model initialization (automatic download on first run)
    await embedder.initialize()

    // Observable side effect of the download: the cache directory is populated.
    const resolvedCacheDir = resolve(cacheDir)
    expect(existsSync(resolvedCacheDir)).toBe(true)
    expect(readdirSync(resolvedCacheDir).length).toBeGreaterThan(0)
  })

  // AC interpretation: [Technical requirement] Embedding generation executed with batch size 8
  // Validation: Generate embeddings for multiple text chunks with batch size 8
  it('Generate embeddings for multiple text chunks (e.g., 16) with batch size 8', async () => {
    const { Embedder } = await import('../../embedder/index.js')
    const embedder = new Embedder(
      withTestDevice({
        modelPath: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 8,
        cacheDir: testModelCacheDir(),
      })
    )

    await embedder.initialize()

    // Create 16 text chunks (2 batches with batch size 8)
    const texts = Array.from({ length: 16 }, (_, i) => `This is test text chunk ${i + 1}.`)
    const embeddings = await embedder.embedBatch(texts)

    // Validation: 16 vectors are returned
    expect(embeddings).toBeDefined()
    expect(Array.isArray(embeddings)).toBe(true)
    expect(embeddings.length).toBe(16)

    // Verify each vector is 384-dimensional
    for (const embedding of embeddings) {
      expect(Array.isArray(embedding)).toBe(true)
      expect(embedding.length).toBe(384)
      expect(embedding.every((value: number) => typeof value === 'number')).toBe(true)
    }
  })

  // Edge Case: Empty string
  // Validation: Empty string embedding generation fails fast with error
  it('Empty string embedding generation throws EmbeddingError (fail-fast)', async () => {
    const { Embedder, EmbeddingError } = await import('../../embedder/index.js')
    const embedder = new Embedder(
      withTestDevice({
        modelPath: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 8,
        cacheDir: testModelCacheDir(),
      })
    )

    await embedder.initialize()

    // Attempt to generate embedding for empty string
    await expect(embedder.embed('')).rejects.toThrow(EmbeddingError)
    await expect(embedder.embed('')).rejects.toThrow('Cannot generate embedding for empty text')
  })

  // Edge Case: Very long text
  // Validation: Embedding generation for text over 1000 characters completes normally
  it('Embedding generation for text over 1000 characters completes normally', async () => {
    const { Embedder } = await import('../../embedder/index.js')
    const embedder = new Embedder(
      withTestDevice({
        modelPath: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 8,
        cacheDir: testModelCacheDir(),
      })
    )

    await embedder.initialize()

    const longText = 'This is a very long text. '.repeat(50) // Approx 1350 characters
    const embedding = await embedder.embed(longText)

    expect(embedding).toBeDefined()
    expect(Array.isArray(embedding)).toBe(true)
    expect(embedding.length).toBe(384)
    expect(embedding.every((value: number) => typeof value === 'number')).toBe(true)
  })
})
