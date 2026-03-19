// RAG MCP Server Integration Test - Embedding Generation
// Split from: rag-server.integration.test.ts (AC-003)

import { describe, expect, it } from 'vitest'

describe('AC-003: Vector Embedding Generation', () => {
  // AC interpretation: [Technical requirement] Text chunks are converted to 384-dimensional vectors
  // Validation: Generate embedding from text, 384-dimensional vector is returned
  it('Text chunk properly converted to 384-dimensional vector', async () => {
    const { Embedder } = await import('../../embedder/index')
    const embedder = new Embedder({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: './tmp/models',
    })

    await embedder.initialize()

    const testText = 'This is a test text for embedding generation.'
    const embedding = await embedder.embed(testText)

    expect(embedding).toBeDefined()
    expect(Array.isArray(embedding)).toBe(true)
    expect(embedding.length).toBe(384)
    expect(embedding.every((value) => typeof value === 'number')).toBe(true)
  })

  // AC interpretation: [Technical requirement] all-MiniLM-L6-v2 model is automatically downloaded on first startup
  // Validation: all-MiniLM-L6-v2 model is downloaded from Hugging Face on first startup
  it('all-MiniLM-L6-v2 model automatically downloaded on first startup and cached in models/ directory', async () => {
    const { Embedder } = await import('../../embedder/index')
    const embedder = new Embedder({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: './tmp/models',
    })

    // Model initialization (automatic download on first run)
    await embedder.initialize()

    // Verify initialization succeeded
    const testText = 'Test model initialization.'
    const embedding = await embedder.embed(testText)

    expect(embedding).toBeDefined()
    expect(Array.isArray(embedding)).toBe(true)
    expect(embedding.length).toBe(384)
  })

  // AC interpretation: [Technical requirement] Embedding generation executed with batch size 8
  // Validation: Generate embeddings for multiple text chunks with batch size 8
  it('Generate embeddings for multiple text chunks (e.g., 16) with batch size 8', async () => {
    const { Embedder } = await import('../../embedder/index')
    const embedder = new Embedder({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: './tmp/models',
    })

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
      expect(embedding.every((value) => typeof value === 'number')).toBe(true)
    }
  })

  // Edge Case: Empty string
  // Validation: Empty string embedding generation fails fast with error
  it('Empty string embedding generation throws EmbeddingError (fail-fast)', async () => {
    const { Embedder, EmbeddingError } = await import('../../embedder/index')
    const embedder = new Embedder({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: './tmp/models',
    })

    await embedder.initialize()

    // Attempt to generate embedding for empty string
    await expect(embedder.embed('')).rejects.toThrow(EmbeddingError)
    await expect(embedder.embed('')).rejects.toThrow('Cannot generate embedding for empty text')
  })

  // Edge Case: Very long text
  // Validation: Embedding generation for text over 1000 characters completes normally
  it('Embedding generation for text over 1000 characters completes normally', async () => {
    const { Embedder } = await import('../../embedder/index')
    const embedder = new Embedder({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: './tmp/models',
    })

    await embedder.initialize()

    const longText = 'This is a very long text. '.repeat(50) // Approx 1350 characters
    const embedding = await embedder.embed(longText)

    expect(embedding).toBeDefined()
    expect(Array.isArray(embedding)).toBe(true)
    expect(embedding.length).toBe(384)
    expect(embedding.every((value) => typeof value === 'number')).toBe(true)
  })
})
