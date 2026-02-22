import { describe, expect, it } from 'vitest'
import { applyFileFilter, applyGrouping, applyKeywordBoost } from '../search-filters.js'
import type { SearchResult } from '../types.js'

/**
 * Helper to create a mock SearchResult
 */
function mockResult(
  filePath: string,
  chunkIndex: number,
  score: number,
  text = 'test'
): SearchResult {
  return {
    filePath,
    chunkIndex,
    text,
    score,
    metadata: { fileName: filePath.split('/').pop()!, fileSize: 100, fileType: '.txt' },
  }
}

// ============================================
// applyGrouping
// ============================================

describe('applyGrouping', () => {
  it('should return empty array for empty input', () => {
    expect(applyGrouping([], 'similar')).toEqual([])
    expect(applyGrouping([], 'related')).toEqual([])
  })

  it('should return single result unchanged', () => {
    const results = [mockResult('/a.txt', 0, 0.1)]
    expect(applyGrouping(results, 'similar')).toEqual(results)
    expect(applyGrouping(results, 'related')).toEqual(results)
  })

  it('should return all results when gaps are uniform (no boundary detected)', () => {
    // Uniform gaps: 0.1, 0.2, 0.3, 0.4 -> gaps are all 0.1
    // With uniform gaps, std=0, threshold=mean, no gap exceeds threshold strictly
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/a.txt', 1, 0.2),
      mockResult('/a.txt', 2, 0.3),
      mockResult('/a.txt', 3, 0.4),
    ]
    expect(applyGrouping(results, 'similar')).toEqual(results)
    expect(applyGrouping(results, 'related')).toEqual(results)
  })

  it('should cut at first boundary in similar mode', () => {
    // Scores: 0.1, 0.15, 0.2, 0.8, 0.85
    // Gaps: 0.05, 0.05, 0.6, 0.05
    // Mean gap = 0.1875, std ≈ 0.238, threshold ≈ 0.544
    // Gap 0.6 > 0.544 → boundary at index 3
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/a.txt', 1, 0.15),
      mockResult('/a.txt', 2, 0.2),
      mockResult('/b.txt', 0, 0.8),
      mockResult('/b.txt', 1, 0.85),
    ]
    const filtered = applyGrouping(results, 'similar')
    expect(filtered).toHaveLength(3)
    expect(filtered.map((r) => r.score)).toEqual([0.1, 0.15, 0.2])
  })

  it('should return all in related mode when only 1 boundary exists', () => {
    // Gaps: [0.01, 0.39, 0.01, 0.01]
    // mean=0.105, std≈0.164, threshold≈0.351 → 1 boundary (gap 0.39) at index 2
    // related mode needs 2 boundaries → returns all
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/a.txt', 1, 0.11),
      mockResult('/b.txt', 0, 0.5),
      mockResult('/b.txt', 1, 0.51),
      mockResult('/b.txt', 2, 0.52),
    ]
    const filtered = applyGrouping(results, 'related')
    expect(filtered).toHaveLength(5)
  })

  it('should cut at second boundary in related mode when 2+ boundaries exist', () => {
    // 3 groups with many small gaps to make 2 large gaps statistically significant
    // Gaps: [0.01, 0.01, 0.01, 0.01, 0.86, 0.01, 0.01, 0.98, 0.01]
    // mean=0.212, std≈0.379, threshold≈0.781
    // 0.86 > 0.781 ✓ (boundary at index 5), 0.98 > 0.781 ✓ (boundary at index 8)
    // related mode: cut at 2nd boundary → first 8 results
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/a.txt', 1, 0.11),
      mockResult('/a.txt', 2, 0.12),
      mockResult('/a.txt', 3, 0.13),
      mockResult('/a.txt', 4, 0.14),
      mockResult('/b.txt', 0, 1.0),
      mockResult('/b.txt', 1, 1.01),
      mockResult('/b.txt', 2, 1.02),
      mockResult('/c.txt', 0, 2.0),
      mockResult('/c.txt', 1, 2.01),
    ]
    const filtered = applyGrouping(results, 'related')
    expect(filtered).toHaveLength(8)
    expect(filtered[filtered.length - 1]!.score).toBe(1.02)
  })
})

// ============================================
// applyFileFilter
// ============================================

describe('applyFileFilter', () => {
  it('should return empty array for empty input', () => {
    expect(applyFileFilter([], 3)).toEqual([])
  })

  it('should return all results when maxFiles >= unique files', () => {
    const results = [mockResult('/a.txt', 0, 0.1), mockResult('/b.txt', 0, 0.2)]
    expect(applyFileFilter(results, 2)).toEqual(results)
    expect(applyFileFilter(results, 5)).toEqual(results)
  })

  it('should keep only chunks from the best-scoring file when maxFiles=1', () => {
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/a.txt', 1, 0.15),
      mockResult('/b.txt', 0, 0.2),
      mockResult('/b.txt', 1, 0.25),
    ]
    const filtered = applyFileFilter(results, 1)
    expect(filtered).toHaveLength(2)
    expect(filtered.every((r) => r.filePath === '/a.txt')).toBe(true)
  })

  it('should keep top 2 files when maxFiles=2', () => {
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/b.txt', 0, 0.2),
      mockResult('/c.txt', 0, 0.3),
      mockResult('/a.txt', 1, 0.35),
      mockResult('/c.txt', 1, 0.4),
    ]
    const filtered = applyFileFilter(results, 2)
    const filePaths = new Set(filtered.map((r) => r.filePath))
    expect(filePaths).toEqual(new Set(['/a.txt', '/b.txt']))
  })

  it('should preserve original chunk order', () => {
    const results = [
      mockResult('/a.txt', 0, 0.1),
      mockResult('/b.txt', 0, 0.5),
      mockResult('/a.txt', 1, 0.6),
      mockResult('/c.txt', 0, 0.2),
      mockResult('/c.txt', 1, 0.7),
    ]
    // Best scores: a=0.1, c=0.2, b=0.5 → top 2 = a, c
    const filtered = applyFileFilter(results, 2)
    expect(filtered.map((r) => `${r.filePath}:${r.chunkIndex}`)).toEqual([
      '/a.txt:0',
      '/a.txt:1',
      '/c.txt:0',
      '/c.txt:1',
    ])
  })
})

// ============================================
// applyKeywordBoost
// ============================================

describe('applyKeywordBoost', () => {
  it('should leave scores unchanged when no FTS results', () => {
    const results = [mockResult('/a.txt', 0, 0.5), mockResult('/b.txt', 0, 0.8)]
    const boosted = applyKeywordBoost(results, [], 0.6)
    expect(boosted[0]!.score).toBeCloseTo(0.5)
    expect(boosted[1]!.score).toBeCloseTo(0.8)
  })

  it('should reduce score for keyword-matching chunks', () => {
    const results = [mockResult('/a.txt', 0, 0.5), mockResult('/b.txt', 0, 0.8)]
    const ftsResults = [{ filePath: '/a.txt', chunkIndex: 0, _score: 10.0 }]
    const boosted = applyKeywordBoost(results, ftsResults, 0.6)
    // /a.txt:0 normalized = 10/10 = 1.0, boosted = 0.5 / (1 + 1.0 * 0.6) = 0.5/1.6 ≈ 0.3125
    // /b.txt:0 no match, stays 0.8
    expect(boosted[0]!.filePath).toBe('/a.txt')
    expect(boosted[0]!.score).toBeCloseTo(0.3125)
    expect(boosted[1]!.score).toBeCloseTo(0.8)
  })

  it('should normalize FTS scores relative to max BM25 score', () => {
    const results = [mockResult('/a.txt', 0, 0.6), mockResult('/b.txt', 0, 0.6)]
    const ftsResults = [
      { filePath: '/a.txt', chunkIndex: 0, _score: 10.0 },
      { filePath: '/b.txt', chunkIndex: 0, _score: 5.0 },
    ]
    const boosted = applyKeywordBoost(results, ftsResults, 1.0)
    // /a.txt:0 normalized = 10/10 = 1.0, boosted = 0.6 / (1 + 1.0) = 0.3
    // /b.txt:0 normalized = 5/10 = 0.5, boosted = 0.6 / (1 + 0.5) = 0.4
    expect(boosted[0]!.score).toBeCloseTo(0.3)
    expect(boosted[1]!.score).toBeCloseTo(0.4)
  })

  it('should not boost when weight=0', () => {
    const results = [mockResult('/a.txt', 0, 0.5), mockResult('/b.txt', 0, 0.8)]
    const ftsResults = [{ filePath: '/a.txt', chunkIndex: 0, _score: 10.0 }]
    const boosted = applyKeywordBoost(results, ftsResults, 0)
    // weight=0: boosted = score / (1 + normalized * 0) = score / 1 = score
    expect(boosted[0]!.score).toBeCloseTo(0.5)
    expect(boosted[1]!.score).toBeCloseTo(0.8)
  })

  it('should re-sort results by boosted score', () => {
    const results = [mockResult('/a.txt', 0, 0.5), mockResult('/b.txt', 0, 0.3)]
    // /b.txt has better vector score, but /a.txt gets keyword boost
    const ftsResults = [{ filePath: '/a.txt', chunkIndex: 0, _score: 10.0 }]
    const boosted = applyKeywordBoost(results, ftsResults, 1.0)
    // /a.txt: 0.5 / (1 + 1.0) = 0.25
    // /b.txt: 0.3 (no boost)
    expect(boosted[0]!.filePath).toBe('/a.txt')
    expect(boosted[0]!.score).toBeCloseTo(0.25)
    expect(boosted[1]!.filePath).toBe('/b.txt')
    expect(boosted[1]!.score).toBeCloseTo(0.3)
  })
})
