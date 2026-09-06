// Search filter functions extracted from VectorStore for testability

import type { GroupingMode, SearchResult } from './types.js'

/**
 * Standard deviation multiplier for detecting group boundaries.
 * A gap is considered a "boundary" if it exceeds mean + k*std.
 * Value of 1.5 means gaps > 1.5 standard deviations above mean are boundaries.
 */
const GROUPING_BOUNDARY_STD_MULTIPLIER = 1.5

/**
 * Cut the distance-sorted results at gaps wider than `mean + k*std`:
 * `similar` keeps the first group, `related` up to two.
 */
export function applyGrouping(results: SearchResult[], mode: GroupingMode): SearchResult[] {
  if (results.length <= 1) {
    return results
  }

  // Calculate gaps between consecutive results with their indices
  const gaps: { index: number; gap: number }[] = []
  for (let i = 0; i < results.length - 1; i++) {
    const current = results[i]
    const next = results[i + 1]
    if (current !== undefined && next !== undefined) {
      gaps.push({ index: i + 1, gap: next.score - current.score })
    }
  }

  if (gaps.length === 0) {
    return results
  }

  // Calculate statistical threshold to identify significant gaps (group boundaries)
  const gapValues = gaps.map((g) => g.gap)
  const mean = gapValues.reduce((a, b) => a + b, 0) / gapValues.length
  const variance = gapValues.reduce((a, b) => a + (b - mean) ** 2, 0) / gapValues.length
  const std = Math.sqrt(variance)
  const threshold = mean + GROUPING_BOUNDARY_STD_MULTIPLIER * std

  // Find all significant gaps (group boundaries)
  const boundaries = gaps.filter((g) => g.gap > threshold).map((g) => g.index)

  // If no boundaries found, return all results
  if (boundaries.length === 0) {
    return results
  }

  // Determine how many groups to include based on mode
  // 'similar': 1 group (cut at first boundary)
  // 'related': 2 groups (cut at second boundary, or return all if only 1 boundary)
  const groupsToInclude = mode === 'similar' ? 1 : 2
  const boundaryIndex = groupsToInclude - 1

  // If we don't have enough boundaries, return all results for 'related' mode
  if (boundaryIndex >= boundaries.length) {
    return mode === 'related' ? results : results.slice(0, boundaries[0])
  }

  // Cut at the appropriate boundary
  return results.slice(0, boundaries[boundaryIndex])
}

/**
 * Rank files by their best (lowest-distance) chunk and keep only the top
 * `maxFiles` files' chunks.
 */
export function applyFileFilter(results: SearchResult[], maxFiles: number): SearchResult[] {
  if (results.length === 0) {
    return results
  }

  // Find the best (lowest) score per file
  const fileScores = new Map<string, number>()
  for (const result of results) {
    const current = fileScores.get(result.filePath)
    if (current === undefined || result.score < current) {
      fileScores.set(result.filePath, result.score)
    }
  }

  // If we have fewer or equal files than maxFiles, return all
  if (fileScores.size <= maxFiles) {
    return results
  }

  // Sort files by best score (ascending) and take top N
  const topFiles = new Set(
    [...fileScores.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, maxFiles)
      .map(([filePath]) => filePath)
  )

  // Filter results to only include chunks from top files
  return results.filter((result) => topFiles.has(result.filePath))
}

/**
 * Rerank by `distance / (1 + keyword_normalized * weight)`. Multiplicative, so
 * a keyword match improves ranking without dominating semantic similarity and
 * a document with no match keeps its original distance.
 */
/**
 * BM25 score of one raw FTS row. A `_score` that is not a number scores 0, so
 * the row keeps its vector distance instead of normalizing to `NaN`. `NaN` and
 * `Infinity` ARE numbers and pass through unchanged.
 */
function readBm25Score(row: FtsRow): number {
  const score = row?.['_score']
  return typeof score === 'number' ? score : 0
}

/** One raw row from a LanceDB full-text search; entries can be missing. */
export type FtsRow = Record<string, unknown> | null | undefined

export function applyKeywordBoost(
  vectorResults: SearchResult[],
  ftsResults: readonly FtsRow[],
  weight: number
): SearchResult[] {
  // Build FTS score map with normalized scores (0-1)
  let maxBm25Score = 0
  for (const result of ftsResults) {
    const score = readBm25Score(result)
    if (score > maxBm25Score) {
      maxBm25Score = score
    }
  }

  const ftsScoreMap = new Map<string, number>()
  for (const result of ftsResults) {
    if (!result) {
      continue
    }
    const key = `${result['filePath']}:${result['chunkIndex']}`
    const rawScore = readBm25Score(result)
    const normalized = maxBm25Score > 0 ? rawScore / maxBm25Score : 0
    ftsScoreMap.set(key, normalized)
  }

  // Apply multiplicative boost to vector results
  const boostedResults = vectorResults.map((result) => {
    const key = `${result.filePath}:${result.chunkIndex}`
    const keywordScore = ftsScoreMap.get(key) ?? 0

    // Multiplicative boost: distance / (1 + keyword * weight)
    // - If keyword matches (score=1) and weight=1: distance halved
    // - If no keyword match (score=0): distance unchanged
    const boostedDistance = result.score / (1 + keywordScore * weight)

    return {
      ...result,
      score: boostedDistance,
    }
  })

  // Re-sort by boosted distance (ascending = better)
  return boostedResults.sort((a, b) => a.score - b.score)
}
