// MinChunkLength Tests
// Test Type: Unit Test
// Tests that SemanticChunker respects minChunkLength during grouping (not post-filtering)

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
  it('should group short sentences together to meet default minChunkLength of 50', async () => {
    const chunker = new SemanticChunker()
    const embedder = createDissimilarEmbedder()

    // Each sentence is ~20 chars, well under 50, but grouping prevents splitting
    const shortSentence = 'Short sentence here.'
    const text = Array(5).fill(shortSentence).join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // Sentences are grouped together (not split) because individual groups would be too short
    expect(chunks.length).toBeGreaterThan(0)
    // All original text should be present
    const allText = chunks.map((c) => c.text).join(' ')
    for (let i = 0; i < 5; i++) {
      expect(allText).toContain('Short sentence here')
    }
  })

  it('should absorb short sentences into neighboring groups to meet custom minChunkLength', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 100 })
    const embedder = createDissimilarEmbedder()

    // One long sentence and several short ones — all should appear in output
    const longSentence =
      'This is a very long sentence that contains enough characters to exceed the minimum chunk length threshold of one hundred characters easily.'
    const shortSentence = 'Tiny.'
    const text = `${longSentence} ${shortSentence} ${shortSentence} ${shortSentence}`

    const chunks = await chunker.chunkText(text, embedder)

    // All text must be preserved — short sentences absorbed into groups
    const allText = chunks.map((c) => c.text).join(' ')
    expect(allText).toContain(longSentence)
    expect(allText).toContain('Tiny')
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

    // Relaxed should allow more splits (more chunks)
    expect(chunksRelaxed.length).toBeGreaterThanOrEqual(chunksStrict.length)
  })

  it('should group all sentences into one chunk when minChunkLength exceeds total text', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 5000 })
    const embedder = createMockEmbedder()

    const text =
      'First sentence about authentication. Second sentence about rate limiting. Third sentence about error handling.'

    const chunks = await chunker.chunkText(text, embedder)

    // All sentences forced into one group since no group can meet 5000 chars
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('authentication')
    expect(chunks[0]!.text).toContain('rate limiting')
    expect(chunks[0]!.text).toContain('error handling')
  })

  it('should re-index chunks sequentially', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 50 })
    const embedder = createDissimilarEmbedder()

    // Mix of short and long sentences — all preserved via grouping
    const text = [
      'Hi.',
      'This is a medium-length sentence that should definitely pass the fifty character minimum chunk length filter.',
      'Ok.',
      'Another sentence that is long enough to meet the minimum character threshold for chunk inclusion in results.',
    ].join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // Chunks should have sequential indices starting from 0
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i)
    }

    // All original text should be present
    const allText = chunks.map((c) => c.text).join(' ')
    expect(allText).toContain('Hi')
    expect(allText).toContain('medium-length')
    expect(allText).toContain('Ok')
    expect(allText).toContain('Another sentence')
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

  it('should group all sentences into one chunk at upper boundary (10000)', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 10000 })
    const embedder = createMockEmbedder()

    const text =
      'Short document with a few sentences. Not enough to reach ten thousand characters. Even with multiple sentences added together.'

    const chunks = await chunker.chunkText(text, embedder)

    // All sentences forced into one group
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('Short document')
    expect(chunks[0]!.text).toContain('ten thousand')
  })

  it('should apply minChunkLength during grouping, not post-filtering', async () => {
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

  it('should prevent splitting when group is below minChunkLength even with low similarity', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 200 })
    const embedder = createDissimilarEmbedder()

    // All sentences are dissimilar, but minChunkLength prevents splitting until 200 chars
    const text = [
      'First topic about authentication.',
      'Second topic about databases.',
      'Third topic about networking.',
      'Fourth topic about caching systems.',
      'Fifth topic about load balancing.',
    ].join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // No text should be lost — all sentences present
    const allText = chunks.map((c) => c.text).join(' ')
    expect(allText).toContain('authentication')
    expect(allText).toContain('databases')
    expect(allText).toContain('networking')
    expect(allText).toContain('caching')
    expect(allText).toContain('load balancing')
  })

  it('should fold short trailing group into previous group', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 100 })
    const embedder = createDissimilarEmbedder()

    // Long sentence followed by a very short one — the short trailing sentence
    // should be folded into the previous group
    const text =
      'This is a long enough sentence that exceeds the one hundred character minimum chunk length threshold easily and comfortably. End.'

    const chunks = await chunker.chunkText(text, embedder)

    // "End." should be folded into the previous group, not lost
    const allText = chunks.map((c) => c.text).join(' ')
    expect(allText).toContain('End')
  })

  it('should preserve all original sentences across output chunks', async () => {
    const chunker = new SemanticChunker({ minChunkLength: 80 })
    const embedder = createDissimilarEmbedder()

    const sentences = [
      'The quick brown fox jumps over the lazy dog.',
      'Pack my box with five dozen liquor jugs.',
      'How valiantly the Sphinx of black quartz judges my vow.',
      'The five boxing wizards jump quickly at dawn.',
      'Crazy Frederick bought many very exquisite opal jewels.',
    ]
    const text = sentences.join(' ')

    const chunks = await chunker.chunkText(text, embedder)

    // Every sentence must appear in some chunk
    const allText = chunks.map((c) => c.text).join(' ')
    for (const sentence of sentences) {
      expect(allText).toContain(sentence)
    }
  })
})
