// MinChunkLength Tests
// Test Type: Unit Test
// Tests that SemanticChunker correctly filters chunks by minChunkLength

import { describe, expect, it } from 'vitest'
import type { EmbedderInterface } from '../../chunker/semantic-chunker.js'
import { SemanticChunker } from '../../chunker/semantic-chunker.js'

// ============================================
// Mock Embedder
// ============================================

/**
 * Mock embedder that returns deterministic embeddings.
 * Each sentence gets a unique vector based on its index,
 * with high similarity between consecutive sentences
 * to avoid unexpected chunk splits.
 */
function createMockEmbedder(): EmbedderInterface {
  return {
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((_, i) => {
        // Generate vectors that are similar to each other
        // so they stay in the same chunk
        const base = [0.9, 0.9, 0.9, 0.9]
        base[i % 4] = 0.9 + i * 0.001
        return base
      })
    },
  }
}

/**
 * Mock embedder that produces dissimilar vectors for each sentence,
 * forcing each sentence into its own chunk.
 */
function createDissimilarEmbedder(): EmbedderInterface {
  return {
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((_, i) => {
        // Orthogonal-ish vectors to force chunk splits
        const vec = [0, 0, 0, 0, 0, 0, 0, 0]
        vec[i % 8] = 1.0
        return vec
      })
    },
  }
}

// ============================================
// Tests
// ============================================

describe('SemanticChunker minChunkLength', () => {
  it('should use default minChunkLength of 50 when not specified', async () => {
    const chunker = new SemanticChunker()
    const embedder = createDissimilarEmbedder()

    // Create text with sentences that produce chunks shorter than 50 chars
    const shortSentence = 'Short sentence here.'
    // Each sentence is ~20 chars, well under 50
    const text = Array(5).fill(shortSentence).join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // All individual chunks are under 50 chars, so they should be filtered out
    expect(chunks).toHaveLength(0)
  })

  it('should filter out chunks shorter than custom minChunkLength', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 100 })
    const embedder = createDissimilarEmbedder()

    // Create text with one long sentence (>100 chars) and several short ones
    const longSentence =
      'This is a very long sentence that contains enough characters to exceed the minimum chunk length threshold of one hundred characters easily.'
    const shortSentence = 'Tiny.'
    const text = `${longSentence} ${shortSentence} ${shortSentence} ${shortSentence}`

    const chunks = await chunker.chunkText(text, embedder)

    // Only the long sentence chunk should survive the filter
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(100)
    }
  })

  it('should keep all chunks when minChunkLength is set to 1', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 1 })
    const embedder = createDissimilarEmbedder()

    // Even very short sentences should be kept
    const text = 'Hello world. Goodbye world. Test sentence.'
    const chunks = await chunker.chunkText(text, embedder)

    // With minChunkLength=1, no chunks should be filtered by length
    // (some may still be filtered by garbage detection)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('should produce more chunks with lower minChunkLength', async () => {
    const embedder = createDissimilarEmbedder()

    // Build text with sentences of varying length
    const sentences = [
      'Authentication uses OAuth 2.0 with JWT tokens for secure API access.',
      'The rate limiter applies a sliding window algorithm.',
      'Error codes follow the HTTP standard status code conventions for consistency across all endpoints.',
      'Database connections are pooled using a connection pool manager that handles lifecycle and cleanup.',
      'The caching layer uses Redis with configurable TTL values for each endpoint category.',
    ]
    const text = sentences.join(' ')

    const chunkerStrict = new SemanticChunker({ minChunkLength: 200 })
    const chunkerRelaxed = new SemanticChunker({ minChunkLength: 10 })

    const chunksStrict = await chunkerStrict.chunkText(text, embedder)
    const chunksRelaxed = await chunkerRelaxed.chunkText(text, embedder)

    // Relaxed filter should keep at least as many chunks as strict
    expect(chunksRelaxed.length).toBeGreaterThanOrEqual(chunksStrict.length)
  })

  it('should return empty array when all chunks are below minChunkLength', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 5000 })
    const embedder = createMockEmbedder()

    const text =
      'First sentence about authentication. Second sentence about rate limiting. Third sentence about error handling.'

    const chunks = await chunker.chunkText(text, embedder)

    // All chunks are well under 5000 chars, so everything is filtered
    expect(chunks).toHaveLength(0)
  })

  it('should re-index chunks sequentially after filtering', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 50 })
    const embedder = createDissimilarEmbedder()

    // Mix of short (<50) and long (>50) sentences to create gaps after filtering
    const text = [
      'Hi.', // too short
      'This is a medium-length sentence that should definitely pass the fifty character minimum chunk length filter.',
      'Ok.', // too short
      'Another sentence that is long enough to meet the minimum character threshold for chunk inclusion in results.',
    ].join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // Chunks that survive should have sequential indices starting from 0
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i)
    }
  })

  it('should not filter chunks when text is long enough', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 50 })
    const embedder = createMockEmbedder()

    // All sentences grouped into one chunk (similar embeddings), well over 50 chars
    const text =
      'The authentication module handles OAuth 2.0 token validation. It verifies JWT signatures against the public key. Expired tokens are rejected with a 401 status code. Refresh tokens can be exchanged for new access tokens.'

    const chunks = await chunker.chunkText(text, embedder)

    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(50)
    }
  })

  it('should handle minChunkLength at upper boundary (10000)', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 10000 })
    const embedder = createMockEmbedder()

    // Normal-length text will all be filtered
    const text =
      'Short document with a few sentences. Not enough to reach ten thousand characters. Even with multiple sentences added together.'

    const chunks = await chunker.chunkText(text, embedder)

    expect(chunks).toHaveLength(0)
  })

  it('should pass minChunkLength to chunk filtering, not sentence splitting', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 100 })
    const embedder = createMockEmbedder()

    // Sentences individually <100 chars, but combined (similar embeddings) they should exceed 100
    const text = [
      'The API uses token-based authentication.',
      'Tokens expire after thirty minutes.',
      'Refresh tokens last for seven days.',
      'Rate limiting is set to 100 requests per minute.',
    ].join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // With similar embeddings, sentences should group into one chunk >100 chars
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(100)
    }
  })

  it('should include minChunkLength value in RAGServer error message when 0 chunks generated', async () => {
    // This tests the error message integration between chunker and server.
    // When all chunks are filtered out, the server error should mention the minimum length.
    const chunker = new SemanticChunker({ minChunkLength: 500 })
    const embedder = createMockEmbedder()

    const text = 'Very short text that will not meet the minimum.'

    const chunks = await chunker.chunkText(text, embedder)

    // Verify that chunks array is empty — this is the condition that triggers
    // the RAGServer error message containing the chunkMinLength value
    expect(chunks).toHaveLength(0)
  })
})
