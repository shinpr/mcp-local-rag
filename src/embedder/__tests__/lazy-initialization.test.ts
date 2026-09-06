// Lazy initialization tests for Embedder
// TDD Red phase: These tests should fail initially

import type { MockInstance } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDevice, testModelCacheDir } from '../../__tests__/test-device.js'
import { privateMembers } from '../../__tests__/test-doubles.js'
import type { EmbedderConfig } from '../index.js'
import { Embedder } from '../index.js'

/**
 * There is no public init-count surface, and mocking transformers instead
 * would leak across files (`isolate: false`) and lose real-model coverage.
 */
function spyOnInitialize(embedder: Embedder): MockInstance {
  return vi.spyOn(privateMembers<{ initialize: () => Promise<void> }>(embedder), 'initialize')
}

describe('Embedder - Lazy Initialization', () => {
  let testConfig: EmbedderConfig

  beforeEach(() => {
    testConfig = {
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: testModelCacheDir(),
      device: getTestDevice(),
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

    // The lazy-init-once contract under concurrency.
    const initializeSpy = spyOnInitialize(embedder)

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

  // Init-failure surfacing on the lazy path is covered in
  // __tests__/embedder/embedder.test.ts ('device validation'), which asserts the
  // same EmbeddingError plus the underlying `Unsupported device` text.

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

    // After init, embed() must not re-initialize.
    const initializeSpy = spyOnInitialize(embedder)

    // Second and third calls should not trigger initialization
    await embedder.embed('second call')
    await embedder.embed('third call')

    expect(initializeSpy).not.toHaveBeenCalled()
  }, 180000)
})
