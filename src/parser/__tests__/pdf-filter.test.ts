// PDF Filter Unit Test

import { describe, expect, it, vi } from 'vitest'
import {
  type EmbedderInterface,
  type PageData,
  detectHeaderFooterPatterns,
  detectSentencePatterns,
  filterHeaderFooter,
  filterPageBoundarySentences,
  joinFilteredPages,
} from '../pdf-filter'

describe('pdf-filter', () => {
  describe('detectHeaderFooterPatterns', () => {
    it('should return empty array for single page', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [{ text: 'Header', x: 0, y: 800, fontSize: 12, hasEOL: true }],
        },
      ]

      const patterns = detectHeaderFooterPatterns(pages)
      expect(patterns).toEqual([])
    })

    it('should detect pattern appearing on 60%+ of pages', () => {
      // 5 pages, pattern appears on 4 (80%)
      const pages: PageData[] = Array.from({ length: 5 }, (_, i) => ({
        pageNum: i + 1,
        items:
          i < 4
            ? [
                { text: '© 2024 Company', x: 0, y: 40, fontSize: 10, hasEOL: true },
                { text: `Page ${i + 1} content`, x: 0, y: 400, fontSize: 12, hasEOL: true },
              ]
            : [{ text: 'Page 5 content', x: 0, y: 400, fontSize: 12, hasEOL: true }],
      }))

      const patterns = detectHeaderFooterPatterns(pages)
      expect(patterns).toHaveLength(1)
      expect(patterns[0]).toMatchObject({
        text: '© 2024 Company',
        occurrences: 4,
      })
    })

    it('should not detect pattern below threshold', () => {
      // 5 pages, pattern appears on 2 (40% < 60%)
      const pages: PageData[] = Array.from({ length: 5 }, (_, i) => ({
        pageNum: i + 1,
        items:
          i < 2
            ? [
                { text: 'Rare header', x: 0, y: 800, fontSize: 12, hasEOL: true },
                { text: `Page ${i + 1}`, x: 0, y: 400, fontSize: 12, hasEOL: true },
              ]
            : [{ text: `Page ${i + 1}`, x: 0, y: 400, fontSize: 12, hasEOL: true }],
      }))

      const patterns = detectHeaderFooterPatterns(pages)
      expect(patterns).toEqual([])
    })

    it('should handle Y coordinate tolerance', () => {
      // Same text at slightly different Y positions (within tolerance)
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [{ text: 'Footer', x: 0, y: 40, fontSize: 10, hasEOL: true }],
        },
        {
          pageNum: 2,
          items: [{ text: 'Footer', x: 0, y: 41, fontSize: 10, hasEOL: true }],
        },
        {
          pageNum: 3,
          items: [{ text: 'Footer', x: 0, y: 39, fontSize: 10, hasEOL: true }],
        },
      ]

      const patterns = detectHeaderFooterPatterns(pages, 0.6, 2)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].text).toBe('Footer')
    })

    it('should detect multiple patterns (header and footer)', () => {
      const pages: PageData[] = Array.from({ length: 3 }, (_, i) => ({
        pageNum: i + 1,
        items: [
          { text: 'Company Header', x: 0, y: 800, fontSize: 14, hasEOL: true },
          { text: `Page ${i + 1} content`, x: 0, y: 400, fontSize: 12, hasEOL: true },
          { text: '© 2024', x: 0, y: 40, fontSize: 8, hasEOL: true },
        ],
      }))

      const patterns = detectHeaderFooterPatterns(pages)
      expect(patterns).toHaveLength(2)
      expect(patterns.map((p) => p.text)).toContain('Company Header')
      expect(patterns.map((p) => p.text)).toContain('© 2024')
    })

    it('should ignore empty text', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: '', x: 0, y: 40, fontSize: 10, hasEOL: true },
            { text: '   ', x: 0, y: 50, fontSize: 10, hasEOL: true },
          ],
        },
        {
          pageNum: 2,
          items: [
            { text: '', x: 0, y: 40, fontSize: 10, hasEOL: true },
            { text: '   ', x: 0, y: 50, fontSize: 10, hasEOL: true },
          ],
        },
      ]

      const patterns = detectHeaderFooterPatterns(pages)
      expect(patterns).toEqual([])
    })

    it('should count each pattern only once per page', () => {
      // Same text appears twice on same page
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: 'Duplicate', x: 0, y: 40, fontSize: 10, hasEOL: true },
            { text: 'Duplicate', x: 100, y: 40, fontSize: 10, hasEOL: true },
          ],
        },
        {
          pageNum: 2,
          items: [{ text: 'Duplicate', x: 0, y: 40, fontSize: 10, hasEOL: true }],
        },
      ]

      const patterns = detectHeaderFooterPatterns(pages)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].occurrences).toBe(2) // Not 3
    })
  })

  describe('filterHeaderFooter', () => {
    it('should remove items matching detected patterns', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: 'Header', x: 0, y: 800, fontSize: 12, hasEOL: true },
            { text: 'Content 1', x: 0, y: 400, fontSize: 12, hasEOL: true },
            { text: 'Footer', x: 0, y: 40, fontSize: 10, hasEOL: true },
          ],
        },
        {
          pageNum: 2,
          items: [
            { text: 'Header', x: 0, y: 800, fontSize: 12, hasEOL: true },
            { text: 'Content 2', x: 0, y: 400, fontSize: 12, hasEOL: true },
            { text: 'Footer', x: 0, y: 40, fontSize: 10, hasEOL: true },
          ],
        },
      ]

      const patterns = detectHeaderFooterPatterns(pages)
      const filtered = filterHeaderFooter(pages, patterns)

      expect(filtered[0].items).toHaveLength(1)
      expect(filtered[0].items[0].text).toBe('Content 1')
      expect(filtered[1].items).toHaveLength(1)
      expect(filtered[1].items[0].text).toBe('Content 2')
    })

    it('should return original pages when no patterns', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [{ text: 'Unique content', x: 0, y: 400, fontSize: 12, hasEOL: true }],
        },
      ]

      const filtered = filterHeaderFooter(pages, [])
      expect(filtered).toEqual(pages)
    })

    it('should preserve empty items for spacing', () => {
      const pages: PageData[] = [
        {
          pageNum: 1,
          items: [
            { text: '', x: 0, y: 500, fontSize: 12, hasEOL: true },
            { text: 'Content', x: 0, y: 400, fontSize: 12, hasEOL: true },
          ],
        },
      ]

      const filtered = filterHeaderFooter(pages, [{ y: 500, text: 'Other', occurrences: 2 }])
      expect(filtered[0].items).toHaveLength(2)
    })
  })

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

    it('should return joined text when pages < minPages', async () => {
      const pages = createPagesWithSentences([['Single page content.']])
      const embedder = createMockEmbedder([])

      const result = await filterPageBoundarySentences(pages, embedder)

      expect(result).toBe('Single page content.')
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

      // Should not contain "Header pattern"
      expect(result).not.toContain('Header pattern')
      expect(result).toContain('Page 1 content')
      expect(result).toContain('Page 2 content')
      expect(result).toContain('Page 3 content')
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

      expect(result).not.toContain('Footer pattern')
      expect(result).toContain('Page 1 content')
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

      expect(result).toContain('Unique A')
      expect(result).toContain('Content A')
      expect(result).toContain('End A')
    })
  })
})
