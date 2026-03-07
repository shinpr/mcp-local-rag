// Lazy initialization tests for Embedder
// TDD Red phase: These tests should fail initially

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedderConfig } from '../index.js'
import { Embedder, EmbeddingError } from '../index.js'

describe('Embedder - Lazy Initialization', () => {
  let testConfig: EmbedderConfig

  beforeEach(() => {
    testConfig = {
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: './tmp/models-lazy-test',
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Test 1: Lazy initialization on first embed() call
  it('should initialize on first embed() call without explicit initialize()', async () => {
    const embedder = new Embedder(testConfig)
    // Note: NOT calling await embedder.initialize()

    const result = await embedder.embed('test text for lazy initialization')

    expect(result).toBeDefined()
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(384)
    expect(result.every((value) => typeof value === 'number')).toBe(true)
  }, 180000) // 3 minute timeout for model download

  // Test 2: Lazy initialization on first embedBatch() call
  it('should initialize on first embedBatch() call without explicit initialize()', async () => {
    const embedder = new Embedder(testConfig)
    // Note: NOT calling await embedder.initialize()

    const texts = ['first text', 'second text', 'third text']
    const results = await embedder.embedBatch(texts)

    expect(results).toBeDefined()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(3)
    expect(results.every((embedding) => embedding.length === 384)).toBe(true)
  }, 180000)

  // Test 3: Initialization should happen only once for concurrent calls
  it('should initialize only once for concurrent embed() calls', async () => {
    const embedder = new Embedder(testConfig)

    // Spy on the initialize method to count how many times it's called
    const initializeSpy = vi.spyOn(embedder as any, 'initialize')

    // Make 5 concurrent embed() calls
    const promises = Array.from({ length: 5 }, (_, i) => embedder.embed(`concurrent test ${i}`))

    const results = await Promise.all(promises)

    // Verify all calls succeeded
    expect(results).toHaveLength(5)
    expect(results.every((result) => result.length === 384)).toBe(true)

    // Verify initialize was called only once
    expect(initializeSpy).toHaveBeenCalledTimes(1)
  }, 180000)

  // Test 4: Retry should be possible after initialization failure
  it('should allow retry after initialization failure', async () => {
    // First attempt with invalid model path
    const embedderWithInvalidPath = new Embedder({
      ...testConfig,
      modelPath: 'invalid/nonexistent-model',
    })

    // First call should fail
    await expect(embedderWithInvalidPath.embed('test')).rejects.toThrow()

    // Second attempt with valid model path
    const embedderWithValidPath = new Embedder(testConfig)

    // This should succeed (retry with new instance)
    const result = await embedderWithValidPath.embed('test after retry')
    expect(result).toBeDefined()
    expect(result.length).toBe(384)
  }, 180000)

  // Test 5: Error message should provide detailed guidance
  it('should provide detailed error message with guidance on initialization failure', async () => {
    const embedderWithInvalidPath = new Embedder({
      ...testConfig,
      modelPath: 'invalid/nonexistent-model',
    })

    try {
      await embedderWithInvalidPath.embed('test')
      // Should not reach here
      expect.fail('Expected embed() to throw an error')
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingError)
      const errorMessage = (error as EmbeddingError).message

      // Verify error message contains helpful guidance
      expect(errorMessage).toContain('Possible causes')
      expect(errorMessage).toContain('Recommended actions')
      expect(errorMessage).toContain(testConfig.cacheDir)
      expect(errorMessage).toContain('Check your internet connection')
      expect(errorMessage).toContain('delete cache')
    }
  }, 30000)

  // Test 6: Explicit initialize() should still work (backward compatibility)
  it('should still work with explicit initialize() call for backward compatibility', async () => {
    const embedder = new Embedder(testConfig)

    // Explicit initialize (existing behavior)
    await embedder.initialize()

    const result = await embedder.embed('test with explicit initialize')

    expect(result).toBeDefined()
    expect(result.length).toBe(384)
  }, 180000)

  // Test 7: Multiple calls to embed() after lazy initialization should not reinitialize
  it('should not reinitialize on subsequent embed() calls', async () => {
    const embedder = new Embedder(testConfig)

    // First call triggers lazy initialization
    await embedder.embed('first call')

    // Spy on initialize after first call
    const initializeSpy = vi.spyOn(embedder as any, 'initialize')

    // Second and third calls should not trigger initialization
    await embedder.embed('second call')
    await embedder.embed('third call')

    expect(initializeSpy).not.toHaveBeenCalled()
  }, 180000)
})
