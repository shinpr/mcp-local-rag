// PDF Filter Unit Test

import { describe, expect, it, vi } from 'vitest'
import {
  type EmbedderInterface,
  type PageData,
  detectSentencePatterns,
  filterPageBoundarySentences,
  joinFilteredPages,
} from '../pdf-filter'

describe('pdf-filter', () => {
  describe('joinFilteredPages', () => {
    it('should join pages with double newline', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [{ text: 'Page 1', x: 0, y: 400, fontSize: 12, hasEOL: false }],
        },
        {
          pageNum: 2,
          items: [{ text: 'Page 2', x: 0, y: 400, fontSize: 12, hasEOL: false }],
        },
      ]

      const text = joinFilteredPages(pages)
      expect(text).toBe('Page 1\n\nPage 2')
    })

    it('should use hasEOL for line breaks within page', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: 'Line 1', x: 0, y: 400, fontSize: 12, hasEOL: true },
            { text: 'Line 2', x: 0, y: 380, fontSize: 12, hasEOL: false },
          ],
        },
      ]

      const text = joinFilteredPages(pages)
      expect(text).toBe('Line 1\nLine 2')
    })

    it('should skip empty pages', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [{ text: 'Content', x: 0, y: 400, fontSize: 12, hasEOL: false }],
        },
        {
          pageNum: 2,
          items: [],
        },
        {
          pageNum: 3,
          items: [{ text: 'More content', x: 0, y: 400, fontSize: 12, hasEOL: false }],
        },
      ]

      const text = joinFilteredPages(pages)
      expect(text).toBe('Content\n\nMore content')
    })

    it('should trim whitespace from each page', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: '  ', x: 0, y: 500, fontSize: 12, hasEOL: true },
            { text: 'Content', x: 0, y: 400, fontSize: 12, hasEOL: true },
            { text: '  ', x: 0, y: 300, fontSize: 12, hasEOL: false },
          ],
        },
      ]

      const text = joinFilteredPages(pages)
      expect(text).toBe('Content')
    })
  })

  // ============================================
  // Sentence-Level Header/Footer Detection Tests
  // ============================================

  describe('detectSentencePatterns', () => {
    // Helper: Create mock embedder
    const createMockEmbedder = (embeddings: number[][]): EmbedderInterface => ({
      embedBatch: vi.fn().mockResolvedValue(embeddings),
    })

    // Helper: Create pages with sentences
    const createPagesWithSentences = (sentences: string[][]): PageData[] =>
      sentences.map((pageSentences, i) => ({
        pageNum: i + 1,
        items: pageSentences.map((text, j) => ({
          text,
          x: 0,
          y: 800 - j * 20, // Top to bottom
          fontSize: 12,
          hasEOL: true,
        })),
      }))

    it('should return no patterns when pages < minPages', async () => {
      const pages = createPagesWithSentences([['Page 1 content.']])
      const embedder = createMockEmbedder([])

      const result = await detectSentencePatterns(pages, embedder)

      expect(result.removeFirstSentence).toBe(false)
      expect(result.removeLastSentence).toBe(false)
      expect(embedder.embedBatch).not.toHaveBeenCalled()
    })

    it('should detect header when first sentences are similar', async () => {
      // 5 pages with similar first sentences (header pattern)
      const pages = createPagesWithSentences([
        ['Chapter 1 - Introduction.', 'Content A.'],
        ['Chapter 2 - Background.', 'Content B.'],
        ['Chapter 3 - Methods.', 'Content C.'],
        ['Chapter 4 - Results.', 'Content D.'],
        ['Chapter 5 - Discussion.', 'Content E.'],
      ])

      // Similar embeddings for first sentences (similarity > 0.85)
      const embedder = createMockEmbedder([
        [1, 0, 0],
        [0.99, 0.1, 0],
        [0.98, 0.15, 0],
        [0.97, 0.2, 0],
        [0.96, 0.25, 0],
      ])

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      expect(result.removeFirstSentence).toBe(true)
      expect(result.headerSimilarity).toBeGreaterThan(0.85)
    })

    it('should detect footer when last sentences are similar', async () => {
      // 5 pages with similar last sentences (footer pattern like "Page X of Y")
      const pages = createPagesWithSentences([
        ['Content A.', 'Page 1 of 5.'],
        ['Content B.', 'Page 2 of 5.'],
        ['Content C.', 'Page 3 of 5.'],
        ['Content D.', 'Page 4 of 5.'],
        ['Content E.', 'Page 5 of 5.'],
      ])

      // Mock: first call for headers (dissimilar), second call for footers (similar)
      const embedder: EmbedderInterface = {
        embedBatch: vi
          .fn()
          .mockResolvedValueOnce([
            // First sentences - dissimilar
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [0.5, 0.5, 0],
            [0.3, 0.3, 0.3],
          ])
          .mockResolvedValueOnce([
            // Last sentences - similar (page numbers)
            [1, 0, 0],
            [0.99, 0.1, 0],
            [0.98, 0.15, 0],
            [0.97, 0.2, 0],
            [0.96, 0.25, 0],
          ]),
      }

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      expect(result.removeFirstSentence).toBe(false)
      expect(result.removeLastSentence).toBe(true)
      expect(result.footerSimilarity).toBeGreaterThan(0.85)
    })

    it('should not detect patterns when sentences are dissimilar', async () => {
      const pages = createPagesWithSentences([
        ['Unique intro 1.', 'Content A.', 'Unique outro 1.'],
        ['Unique intro 2.', 'Content B.', 'Unique outro 2.'],
        ['Unique intro 3.', 'Content C.', 'Unique outro 3.'],
      ])

      // Dissimilar embeddings (similarity < 0.85)
      const embedder: EmbedderInterface = {
        embedBatch: vi.fn().mockResolvedValue([
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]),
      }

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      expect(result.removeFirstSentence).toBe(false)
      expect(result.removeLastSentence).toBe(false)
    })

    it('should use custom similarity threshold', async () => {
      const pages = createPagesWithSentences([
        ['Header A.', 'Content.'],
        ['Header B.', 'Content.'],
        ['Header C.', 'Content.'],
      ])

      // Embeddings with similarity ~0.7 (below default 0.85, above custom 0.5)
      const embedder = createMockEmbedder([
        [1, 0, 0],
        [0.7, 0.7, 0],
        [0.7, 0, 0.7],
      ])

      const resultDefault = await detectSentencePatterns(pages, embedder, { minPages: 3 })
      expect(resultDefault.removeFirstSentence).toBe(false)

      // Reset mock
      vi.mocked(embedder.embedBatch).mockClear()

      const resultCustom = await detectSentencePatterns(pages, embedder, {
        minPages: 3,
        similarityThreshold: 0.5,
      })
      expect(resultCustom.removeFirstSentence).toBe(true)
    })

    // ============================================
    // Median Pairwise Similarity Tests
    // ============================================

    it('should use median similarity (odd number of pairs)', async () => {
      // 3 pages = 3 pairwise comparisons (odd)
      // Pairs: (0,1), (0,2), (1,2)
      const pages = createPagesWithSentences([
        ['Header A.', 'Content A.'],
        ['Header B.', 'Content B.'],
        ['Header C.', 'Content C.'],
      ])

      // Embeddings designed to produce specific similarities:
      // (0,1): [1,0,0]·[0,1,0] = 0 (low outlier)
      // (0,2): [1,0,0]·[0.95,0.31,0] ≈ 0.95 (high)
      // (1,2): [0,1,0]·[0.95,0.31,0] ≈ 0.31 (median)
      // Sorted: [0, 0.31, 0.95] → median = 0.31 (below threshold)
      const embedder = createMockEmbedder([
        [1, 0, 0],
        [0, 1, 0],
        [0.95, 0.31, 0],
      ])

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      // Median 0.31 < 0.85, so no header detected
      expect(result.removeFirstSentence).toBe(false)
      expect(result.headerSimilarity).toBeLessThan(0.85)
    })

    it('should use median similarity (even number of pairs)', async () => {
      // 4 pages = 6 pairwise comparisons (even)
      // Pairs: (0,1), (0,2), (0,3), (1,2), (1,3), (2,3)
      const pages = createPagesWithSentences([
        ['Header A.', 'Content A.'],
        ['Header B.', 'Content B.'],
        ['Header C.', 'Content C.'],
        ['Header D.', 'Content D.'],
      ])

      // All similar embeddings → high median
      const embedder = createMockEmbedder([
        [1, 0, 0],
        [0.99, 0.1, 0],
        [0.98, 0.15, 0],
        [0.97, 0.2, 0],
      ])

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      // All pairs have high similarity, median should be high
      expect(result.removeFirstSentence).toBe(true)
      expect(result.headerSimilarity).toBeGreaterThan(0.85)
    })

    it('should be robust to outliers using median', async () => {
      // 5 pages = 10 pairwise comparisons
      // With one outlier page, mean would be dragged down
      // But median should remain high
      const pages = createPagesWithSentences([
        ['Chapter 1.', 'Content A.'],
        ['Chapter 2.', 'Content B.'],
        ['Different Title.', 'Content C.'], // Outlier
        ['Chapter 4.', 'Content D.'],
        ['Chapter 5.', 'Content E.'],
      ])

      // 4 similar embeddings + 1 outlier
      // Most pairs (6 out of 10) will have high similarity
      // Outlier pairs (4 out of 10) will have low similarity
      // Median should still be high enough to detect pattern
      const embedder = createMockEmbedder([
        [1, 0, 0],
        [0.99, 0.1, 0],
        [0, 0, 1], // Outlier - orthogonal to others
        [0.98, 0.15, 0],
        [0.97, 0.2, 0],
      ])

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      // Despite outlier, median of majority similar pairs should be high
      expect(result.removeFirstSentence).toBe(true)
    })

    // ============================================
    // Y Coordinate Merge Tests
    // ============================================

    it('should merge sentences with same Y coordinate', async () => {
      // Create page with multiple items on same Y (same line)
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: 'Part A.', x: 0, y: 800, fontSize: 12, hasEOL: false },
            { text: 'Part B.', x: 100, y: 800, fontSize: 12, hasEOL: true }, // Same Y
            { text: 'Content line.', x: 0, y: 750, fontSize: 12, hasEOL: true },
          ],
        },
        {
          pageNum: 2,
          items: [
            { text: 'Part A.', x: 0, y: 800, fontSize: 12, hasEOL: false },
            { text: 'Part B.', x: 100, y: 800, fontSize: 12, hasEOL: true }, // Same Y
            { text: 'Content line 2.', x: 0, y: 750, fontSize: 12, hasEOL: true },
          ],
        },
        {
          pageNum: 3,
          items: [
            { text: 'Part A.', x: 0, y: 800, fontSize: 12, hasEOL: false },
            { text: 'Part B.', x: 100, y: 800, fontSize: 12, hasEOL: true }, // Same Y
            { text: 'Content line 3.', x: 0, y: 750, fontSize: 12, hasEOL: true },
          ],
        },
      ]

      // First sentences (merged: "Part A. Part B.") should be similar
      const embedder: EmbedderInterface = {
        embedBatch: vi
          .fn()
          .mockResolvedValueOnce([
            // First sentences - similar (merged header)
            [1, 0, 0],
            [0.99, 0.05, 0],
            [0.98, 0.1, 0],
          ])
          .mockResolvedValueOnce([
            // Last sentences - dissimilar
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]),
      }

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      // Merged first line should be detected as header
      expect(result.removeFirstSentence).toBe(true)
    })

    it('should treat different Y coordinates as separate sentences', async () => {
      // Create page with items on different Y (different lines)
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: 'Line 1.', x: 0, y: 800, fontSize: 12, hasEOL: true },
            { text: 'Line 2.', x: 0, y: 750, fontSize: 12, hasEOL: true }, // Different Y
            { text: 'Line 3.', x: 0, y: 700, fontSize: 12, hasEOL: true },
          ],
        },
        {
          pageNum: 2,
          items: [
            { text: 'Different 1.', x: 0, y: 800, fontSize: 12, hasEOL: true },
            { text: 'Different 2.', x: 0, y: 750, fontSize: 12, hasEOL: true },
            { text: 'Different 3.', x: 0, y: 700, fontSize: 12, hasEOL: true },
          ],
        },
        {
          pageNum: 3,
          items: [
            { text: 'Another 1.', x: 0, y: 800, fontSize: 12, hasEOL: true },
            { text: 'Another 2.', x: 0, y: 750, fontSize: 12, hasEOL: true },
            { text: 'Another 3.', x: 0, y: 700, fontSize: 12, hasEOL: true },
          ],
        },
      ]

      // First sentences are different → no header detected
      const embedder: EmbedderInterface = {
        embedBatch: vi.fn().mockResolvedValue([
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]),
      }

      const result = await detectSentencePatterns(pages, embedder, { minPages: 3 })

      // Different first lines should not be detected as header
      expect(result.removeFirstSentence).toBe(false)
    })
  })

  describe('filterPageBoundarySentences', () => {
    const createMockEmbedder = (embeddings: number[][]): EmbedderInterface => ({
      embedBatch: vi.fn().mockResolvedValue(embeddings),
    })

    const createPagesWithSentences = (sentences: string[][]): PageData[] =>
      sentences.map((pageSentences, i) => ({
        pageNum: i + 1,
        items: pageSentences.map((text, j) => ({
          text,
          x: 0,
          y: 800 - j * 20,
          fontSize: 12,
          hasEOL: true,
        })),
      }))

    it('should return per-page text when pages < minPages', async () => {
      const pages = createPagesWithSentences([['Single page content.']])
      const embedder = createMockEmbedder([])

      const result = await filterPageBoundarySentences(pages, embedder)

      expect(result).toEqual(['Single page content.'])
      expect(embedder.embedBatch).not.toHaveBeenCalled()
    })

    it('should remove detected header sentences', async () => {
      const pages = createPagesWithSentences([
        ['Header pattern.', 'Page 1 content.'],
        ['Header pattern.', 'Page 2 content.'],
        ['Header pattern.', 'Page 3 content.'],
      ])

      // Similar first sentences, dissimilar last sentences
      const embedder: EmbedderInterface = {
        embedBatch: vi
          .fn()
          .mockResolvedValueOnce([
            // First sentences - similar (header pattern)
            [1, 0, 0],
            [0.99, 0.05, 0],
            [0.98, 0.1, 0],
          ])
          .mockResolvedValueOnce([
            // Last sentences - dissimilar (unique content)
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]),
      }

      const result = await filterPageBoundarySentences(pages, embedder, { minPages: 3 })
      const joined = result.join('\n\n')

      // Should not contain "Header pattern"
      expect(joined).not.toContain('Header pattern')
      expect(joined).toContain('Page 1 content')
      expect(joined).toContain('Page 2 content')
      expect(joined).toContain('Page 3 content')
    })

    it('should remove detected footer sentences', async () => {
      const pages = createPagesWithSentences([
        ['Page 1 content.', 'Footer pattern.'],
        ['Page 2 content.', 'Footer pattern.'],
        ['Page 3 content.', 'Footer pattern.'],
      ])

      // Dissimilar first, similar last
      const embedder: EmbedderInterface = {
        embedBatch: vi
          .fn()
          .mockResolvedValueOnce([
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ])
          .mockResolvedValueOnce([
            [1, 0, 0],
            [0.99, 0.05, 0],
            [0.98, 0.1, 0],
          ]),
      }

      const result = await filterPageBoundarySentences(pages, embedder, { minPages: 3 })
      const joined = result.join('\n\n')

      expect(joined).not.toContain('Footer pattern')
      expect(joined).toContain('Page 1 content')
    })

    it('should preserve content when no patterns detected', async () => {
      const pages = createPagesWithSentences([
        ['Unique A.', 'Content A.', 'End A.'],
        ['Unique B.', 'Content B.', 'End B.'],
        ['Unique C.', 'Content C.', 'End C.'],
      ])

      // All dissimilar
      const embedder: EmbedderInterface = {
        embedBatch: vi.fn().mockResolvedValue([
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]),
      }

      const result = await filterPageBoundarySentences(pages, embedder, { minPages: 3 })
      const joined = result.join('\n\n')

      expect(joined).toContain('Unique A')
      expect(joined).toContain('Content A')
      expect(joined).toContain('End A')
    })
  })
})
