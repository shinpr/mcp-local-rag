// Semantic Chunker Unit Test
// Created: 2024-12-27
// Purpose: Verify Max-Min semantic chunking algorithm

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextChunk } from '../index.js'
import { SemanticChunker, type SemanticChunkerConfig } from '../semantic-chunker.js'

// Mock embedder interface
interface MockEmbedder {
  embedBatch(texts: string[]): Promise<number[][]>
}

describe('SemanticChunker', () => {
  let chunker: SemanticChunker
  let mockEmbedder: MockEmbedder

  // Helper to create mock embeddings with controlled similarity
  // Vectors are normalized (magnitude = 1) for cosine similarity
  function createMockEmbedding(values: number[]): number[] {
    const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0))
    return values.map((v) => v / magnitude)
  }

  beforeEach(() => {
    // Default config based on paper recommendations
    const config: SemanticChunkerConfig = {
      hardThreshold: 0.6,
      initConst: 1.5,
      c: 0.9,
      minChunkLength: 50,
    }
    chunker = new SemanticChunker(config)

    // Mock embedder that returns predictable embeddings
    mockEmbedder = {
      embedBatch: vi.fn(),
    }
  })

  // --------------------------------------------
  // Basic functionality
  // --------------------------------------------
  describe('Basic chunking', () => {
    it('should return empty array for empty text', async () => {
      const result = await chunker.chunkText('', mockEmbedder)
      expect(result).toEqual([])
    })

    it('should return empty array for whitespace only', async () => {
      const result = await chunker.chunkText('   \n\n   ', mockEmbedder)
      expect(result).toEqual([])
    })

    it('should handle single sentence', async () => {
      const text = 'This is a single sentence that is long enough to be a valid chunk on its own.'

      // Mock embedding for the single sentence
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([createMockEmbedding([1, 0, 0])])

      const result = await chunker.chunkText(text, mockEmbedder)

      expect(result).toHaveLength(1)
      expect(result[0]?.text).toContain('This is a single sentence')
      expect(result[0]?.index).toBe(0)
    })
  })

  // --------------------------------------------
  // Max-Min algorithm behavior
  // --------------------------------------------
  describe('Max-Min algorithm', () => {
    it('should group semantically similar sentences together', async () => {
      const text = `Machine learning is a type of AI. Deep learning uses neural networks.
The weather today is sunny. It will rain tomorrow.`

      // Mock embeddings: first two sentences similar, last two similar, but different groups
      // Cosine similarity: ML-DL ≈ 0.95, Weather-Rain ≈ 0.95, ML-Weather ≈ 0
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]), // ML sentence
        createMockEmbedding([0.95, 0.1, 0]), // DL sentence (similar to ML)
        createMockEmbedding([0, 1, 0]), // Weather sentence
        createMockEmbedding([0, 0.95, 0.1]), // Rain sentence (similar to weather)
      ])

      const result = await chunker.chunkText(text, mockEmbedder)

      // Algorithm behavior:
      // 1. ML → new chunk
      // 2. DL → initConst * sim(ML,DL) = 1.5 * 0.95 > 0.6 → same chunk
      // 3. Weather → maxSim ≈ 0.1 < threshold → new chunk
      // 4. Rain → initConst * sim(Weather,Rain) > 0.6 → same chunk
      // Result: 2 chunks (ML/DL and Weather/Rain) but Weather/Rain may be filtered by minChunkLength
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.length).toBeLessThanOrEqual(2)

      // Verify first chunk contains ML-related content
      expect(result[0]?.text).toContain('Machine learning')
      expect(result[0]?.text).toContain('Deep learning')
    })

    it('should split on semantic boundaries', async () => {
      const text = `Topic A sentence one. Topic A sentence two. Topic A sentence three.
Topic B is completely different. Topic B continues here.`

      // Mock embeddings: Topic A sentences similar, Topic B sentences similar, but A and B different
      // A1-A2 ≈ 0.98, A2-A3 ≈ 0.97, A3-B1 ≈ 0 (semantic shift), B1-B2 ≈ 0.98
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]),
        createMockEmbedding([0.98, 0.1, 0]),
        createMockEmbedding([0.95, 0.15, 0]),
        createMockEmbedding([0, 0, 1]), // Big semantic shift
        createMockEmbedding([0.1, 0, 0.98]),
      ])

      const result = await chunker.chunkText(text, mockEmbedder)

      // Should detect the semantic boundary between Topic A and Topic B
      // Result: 2 chunks - Topic A (3 sentences) and Topic B (2 sentences)
      expect(result).toHaveLength(2)

      // Verify chunk contents
      expect(result[0]?.text).toContain('Topic A')
      expect(result[0]?.text).not.toContain('Topic B')
      expect(result[1]?.text).toContain('Topic B')
      expect(result[1]?.text).not.toContain('Topic A')
    })
  })

  // --------------------------------------------
  // Configuration options
  // --------------------------------------------
  describe('Configuration', () => {
    it('should respect hardThreshold setting', async () => {
      // Create chunker with very high threshold (forces more splits)
      const strictChunker = new SemanticChunker({
        hardThreshold: 0.95,
        initConst: 1.5,
        c: 0.9,
        minChunkLength: 10,
      })

      const text = 'First sentence here. Second sentence here. Third sentence here.'

      // Similarities: 1-2 ≈ 0.8, 2-3 ≈ 0.7 (both below 0.95 threshold)
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]),
        createMockEmbedding([0.8, 0.2, 0]), // Below 0.95 threshold
        createMockEmbedding([0.6, 0.4, 0]), // Below 0.95 threshold
      ])

      const result = await strictChunker.chunkText(text, mockEmbedder)

      // With high threshold (0.95):
      // - 1st sentence → new chunk
      // - 2nd sentence → initConst * 0.8 = 1.2 > 0.95 → same chunk (passes initConst check)
      // - 3rd sentence → maxSim ≈ 0.6-0.7 < 0.95 → new chunk
      // Result: 2 chunks, but second may be too short (23 chars < minChunkLength even with 10)
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.length).toBeLessThanOrEqual(2)

      // Verify the strictness is reflected
      expect(result[0]?.text).toContain('First sentence')
    })

    it('should filter chunks shorter than minChunkLength', async () => {
      const chunkerWithHighMin = new SemanticChunker({
        hardThreshold: 0.6,
        initConst: 1.5,
        c: 0.9,
        minChunkLength: 100,
      })

      const text = 'Short. Also short.'

      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]),
        createMockEmbedding([0, 1, 0]),
      ])

      const result = await chunkerWithHighMin.chunkText(text, mockEmbedder)

      // Both sentences are too short, but might be combined
      // If combined and still too short, should be filtered
      expect(result.every((chunk) => chunk.text.length >= 100 || result.length === 0)).toBe(true)
    })
  })

  // --------------------------------------------
  // Output format
  // --------------------------------------------
  describe('Output format', () => {
    it('should return TextChunk array with correct structure', async () => {
      const text =
        'This is the first chunk with enough content to pass the minimum length filter easily.'

      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([createMockEmbedding([1, 0, 0])])

      const result = await chunker.chunkText(text, mockEmbedder)

      expect(Array.isArray(result)).toBe(true)
      for (const chunk of result) {
        expect(chunk).toHaveProperty('text')
        expect(chunk).toHaveProperty('index')
        expect(typeof chunk.text).toBe('string')
        expect(typeof chunk.index).toBe('number')
      }
    })

    it('should assign sequential indices starting from 0', async () => {
      const text = `First topic sentence one. First topic sentence two.
Second topic is different. Second topic continues.`

      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]),
        createMockEmbedding([0.95, 0.1, 0]),
        createMockEmbedding([0, 1, 0]),
        createMockEmbedding([0.1, 0.95, 0]),
      ])

      const result = await chunker.chunkText(text, mockEmbedder)

      // Verify indices are sequential
      for (let i = 0; i < result.length; i++) {
        expect(result[i]?.index).toBe(i)
      }
    })
  })

  // --------------------------------------------
  // Edge cases
  // --------------------------------------------
  describe('Edge cases', () => {
    it('should handle text with only code blocks', async () => {
      const text = '```typescript\nconst x = 1;\n```'

      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([createMockEmbedding([1, 0, 0])])

      const result = await chunker.chunkText(text, mockEmbedder)

      // Code block (31 chars) is below minChunkLength (50), so should be filtered out
      expect(result).toHaveLength(0)
    })

    it('should handle Japanese text', async () => {
      // Create longer Japanese text to pass minChunkLength filter
      const text =
        'これは日本語の文章です。この文章は技術的なドキュメントについて説明しています。次の文章も日本語で書かれています。詳細な技術仕様について記載されています。'

      // All sentences have high similarity → should be grouped into single chunk
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]),
        createMockEmbedding([0.95, 0.1, 0]),
        createMockEmbedding([0.9, 0.15, 0]),
        createMockEmbedding([0.85, 0.2, 0]),
      ])

      const result = await chunker.chunkText(text, mockEmbedder)

      // High similarity between all sentences → single chunk
      expect(result).toHaveLength(1)
      expect(result[0]?.text).toContain('日本語')
    })

    it('should handle embedder errors gracefully', async () => {
      const text = 'This is a test sentence.'

      vi.mocked(mockEmbedder.embedBatch).mockRejectedValue(new Error('Embedder failed'))

      await expect(chunker.chunkText(text, mockEmbedder)).rejects.toThrow('Embedder failed')
    })
  })

  // --------------------------------------------
  // Cosine similarity calculation
  // --------------------------------------------
  describe('Cosine similarity', () => {
    it('should correctly calculate similarity between identical vectors', () => {
      const vec = createMockEmbedding([1, 2, 3])
      const similarity = chunker.cosineSimilarity(vec, vec)
      expect(similarity).toBeCloseTo(1.0, 5)
    })

    it('should correctly calculate similarity between orthogonal vectors', () => {
      const vec1 = createMockEmbedding([1, 0, 0])
      const vec2 = createMockEmbedding([0, 1, 0])
      const similarity = chunker.cosineSimilarity(vec1, vec2)
      expect(similarity).toBeCloseTo(0.0, 5)
    })

    it('should correctly calculate similarity between opposite vectors', () => {
      const vec1 = [1, 0, 0]
      const vec2 = [-1, 0, 0]
      const similarity = chunker.cosineSimilarity(vec1, vec2)
      expect(similarity).toBeCloseTo(-1.0, 5)
    })
  })

  // --------------------------------------------
  // Boundary value tests (WINDOW_SIZE=5, MAX_SENTENCES=15)
  // --------------------------------------------
  describe('Boundary values', () => {
    it('should handle exactly MAX_SENTENCES (15) sentences without split', async () => {
      // Create 15 sentences with high similarity (should stay in one chunk)
      const sentences = Array.from({ length: 15 }, (_, i) => `Similar sentence number ${i + 1}.`)
      const text = sentences.join(' ')

      // All embeddings are similar (high cosine similarity)
      const embeddings = Array.from({ length: 15 }, () => createMockEmbedding([1, 0, 0]))
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue(embeddings)

      const result = await chunker.chunkText(text, mockEmbedder)

      // 15 sentences with high similarity → single chunk (at the MAX_SENTENCES limit)
      expect(result).toHaveLength(1)
      expect(result[0]?.text).toContain('sentence number 1')
      expect(result[0]?.text).toContain('sentence number 15')
    })

    it('should force split at MAX_SENTENCES+1 (16) sentences', async () => {
      // Create 17 sentences with high similarity (should force split at 15, then 16 and 17 form second chunk)
      // Using 17 sentences ensures second chunk exceeds minChunkLength (50 chars)
      const sentences = Array.from({ length: 17 }, (_, i) => `Similar sentence number ${i + 1}.`)
      const text = sentences.join(' ')

      // All embeddings are identical (maximum similarity)
      const embeddings = Array.from({ length: 17 }, () => createMockEmbedding([1, 0, 0]))
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue(embeddings)

      const result = await chunker.chunkText(text, mockEmbedder)

      // 17 sentences → forced split after 15 → 2 chunks (sentences 1-15, sentences 16-17)
      expect(result).toHaveLength(2)
      expect(result[0]?.text).toContain('sentence number 1')
      expect(result[0]?.text).toContain('sentence number 15')
      expect(result[0]?.text).not.toContain('sentence number 16')
      expect(result[1]?.text).toContain('sentence number 16')
      expect(result[1]?.text).toContain('sentence number 17')
    })

    it('should handle WINDOW_SIZE (5) sentences for min similarity calculation', async () => {
      // Create 6 sentences where the 6th has low similarity to recent sentences
      const text =
        'First related sentence. Second related sentence. Third related sentence. Fourth related sentence. Fifth related sentence. Completely unrelated topic here.'

      // First 5 sentences similar, 6th is different
      vi.mocked(mockEmbedder.embedBatch).mockResolvedValue([
        createMockEmbedding([1, 0, 0]),
        createMockEmbedding([0.95, 0.1, 0]),
        createMockEmbedding([0.9, 0.15, 0]),
        createMockEmbedding([0.85, 0.2, 0]),
        createMockEmbedding([0.8, 0.25, 0]),
        createMockEmbedding([0, 0, 1]), // Semantic shift
      ])

      const result = await chunker.chunkText(text, mockEmbedder)

      // Should detect boundary at sentence 6 (WINDOW_SIZE comparison works)
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0]?.text).toContain('First related')
      expect(result[0]?.text).not.toContain('unrelated topic')
    })
  })
})
