// PDF Header/Footer Filter
// - Detects and removes repeating patterns across pages
// - Semantic similarity-based header/footer detection (sentence-level)

import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import { splitIntoSentences } from '../chunker/sentence-splitter.js'

// Re-export for consumers of this module
export type { EmbedderInterface }

// ============================================
// Type Definitions
// ============================================

/**
 * Text item with position information from PDF
 */
export interface TextItemWithPosition {
  text: string
  x: number
  y: number
  fontSize: number
  hasEOL: boolean
}

/**
 * Page data containing positioned text items
 */
export interface PageData {
  pageNum: number
  items: TextItemWithPosition[]
}

/**
 * Detected repeating pattern (header/footer candidate)
 */
export interface RepeatPattern {
  y: number
  text: string
  occurrences: number
}

// ============================================
// Header/Footer Detection
// ============================================

/**
 * Normalize Y coordinate to handle slight variations
 */
function normalizeY(y: number, tolerance: number): number {
  return Math.round(y / tolerance) * tolerance
}

/**
 * Detect header/footer patterns based on text repetition across pages
 *
 * Algorithm:
 * 1. Group text items by normalized Y coordinate
 * 2. Count occurrences of identical text at same Y position
 * 3. Return patterns that appear on >= threshold of pages
 *
 * @param pages - Array of page data with positioned items
 * @param threshold - Minimum occurrence rate (0.6 = 60% of pages)
 * @param yTolerance - Y coordinate tolerance in points (default: 2)
 * @returns Detected repeat patterns (header/footer candidates)
 */
export function detectHeaderFooterPatterns(
  pages: PageData[],
  threshold = 0.6,
  yTolerance = 2
): RepeatPattern[] {
  if (pages.length < 2) {
    // Need at least 2 pages to detect patterns
    return []
  }

  // Map: "normalizedY:text" -> occurrences count
  const patternCounts = new Map<string, { y: number; text: string; count: number }>()

  for (const page of pages) {
    // Track patterns per page (avoid counting duplicates within same page)
    const seenOnPage = new Set<string>()

    for (const item of page.items) {
      const trimmedText = item.text.trim()
      if (trimmedText.length === 0) continue

      const normalizedY = normalizeY(item.y, yTolerance)
      const key = `${normalizedY}:${trimmedText}`

      if (seenOnPage.has(key)) continue
      seenOnPage.add(key)

      const existing = patternCounts.get(key)
      if (existing) {
        existing.count++
      } else {
        patternCounts.set(key, { y: normalizedY, text: trimmedText, count: 1 })
      }
    }
  }

  // Filter patterns that meet threshold
  const minOccurrences = Math.ceil(pages.length * threshold)
  const patterns: RepeatPattern[] = []

  for (const { y, text, count } of patternCounts.values()) {
    if (count >= minOccurrences) {
      patterns.push({ y, text, occurrences: count })
    }
  }

  return patterns
}

// ============================================
// Header/Footer Filtering
// ============================================

/**
 * Filter out header/footer items based on detected patterns
 *
 * @param pages - Array of page data to filter
 * @param patterns - Detected repeat patterns to remove
 * @param yTolerance - Y coordinate tolerance (must match detection tolerance)
 * @returns Filtered page data with header/footer removed
 */
export function filterHeaderFooter(
  pages: PageData[],
  patterns: RepeatPattern[],
  yTolerance = 2
): PageData[] {
  if (patterns.length === 0) {
    return pages
  }

  // Build lookup set for fast pattern matching
  const patternSet = new Set(patterns.map((p) => `${p.y}:${p.text}`))

  return pages.map((page) => ({
    pageNum: page.pageNum,
    items: page.items.filter((item) => {
      const trimmedText = item.text.trim()
      if (trimmedText.length === 0) return true // Keep empty items for spacing

      const normalizedY = normalizeY(item.y, yTolerance)
      const key = `${normalizedY}:${trimmedText}`

      return !patternSet.has(key)
    }),
  }))
}

// ============================================
// Text Joining
// ============================================

/**
 * Sort items by Y coordinate (top to bottom)
 * Higher Y = top of page, Lower Y = bottom of page
 */
function sortItemsByY(items: TextItemWithPosition[]): TextItemWithPosition[] {
  return [...items].sort((a, b) => b.y - a.y)
}

/**
 * Join page items into text (sorted by Y coordinate)
 */
function joinPageItems(items: TextItemWithPosition[]): string {
  const sorted = sortItemsByY(items)
  let text = ''
  for (const item of sorted) {
    text += item.text
    if (item.hasEOL) text += '\n'
    else text += ' '
  }
  return text.trim()
}

/**
 * Join filtered pages into text
 *
 * @param pages - Filtered page data
 * @returns Joined text with proper line breaks
 */
export function joinFilteredPages(pages: PageData[]): string {
  return pages
    .map((page) => joinPageItems(page.items))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

// ============================================
// Sentence-Level Header/Footer Detection
// ============================================

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length || vec1.length === 0) {
    return 0
  }

  let dotProduct = 0
  let norm1 = 0
  let norm2 = 0

  for (let i = 0; i < vec1.length; i++) {
    const v1 = vec1[i] ?? 0
    const v2 = vec2[i] ?? 0
    dotProduct += v1 * v2
    norm1 += v1 * v1
    norm2 += v2 * v2
  }

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

/**
 * Calculate average pairwise similarity for a list of embeddings
 */
function avgPairwiseSimilarity(embeddings: number[][]): number {
  if (embeddings.length < 2) return 1.0

  let totalSim = 0
  let count = 0

  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const embI = embeddings[i]
      const embJ = embeddings[j]
      if (embI && embJ) {
        totalSim += cosineSimilarity(embI, embJ)
        count++
      }
    }
  }

  return count > 0 ? totalSim / count : 0
}

/**
 * Configuration for sentence-level pattern detection
 */
export interface SentencePatternConfig {
  /** Similarity threshold for pattern detection (default: 0.85) */
  similarityThreshold: number
  /** Minimum pages required for pattern detection (default: 3) */
  minPages: number
  /** Number of pages to sample from center for pattern detection (default: 5) */
  samplePages: number
}

/** Default configuration for sentence-level pattern detection */
export const DEFAULT_SENTENCE_PATTERN_CONFIG: SentencePatternConfig = {
  similarityThreshold: 0.85,
  minPages: 3,
  samplePages: 5,
}

/**
 * Result of sentence-level pattern detection
 */
export interface SentencePatternResult {
  /** Whether first sentences should be removed (detected as header) */
  removeFirstSentence: boolean
  /** Whether last sentences should be removed (detected as footer) */
  removeLastSentence: boolean
  /** Average similarity of first sentences */
  headerSimilarity: number
  /** Average similarity of last sentences */
  footerSimilarity: number
}

/**
 * Detect header/footer patterns at sentence level
 *
 * Algorithm:
 * 1. Sample pages from the CENTER of the document (guaranteed to be content pages)
 * 2. Join each sampled page's items into text
 * 3. Split each page text into sentences
 * 4. Collect first/last sentences from sampled pages
 * 5. Embed and calculate average pairwise similarity
 * 6. If similarity > threshold, mark as header/footer
 *
 * Key insight: Middle pages are always content pages (cover, TOC, index are at edges)
 * This avoids outliers that would drag down the average similarity.
 *
 * This approach handles variable content like page numbers ("7 of 75")
 * by using semantic similarity instead of exact text matching.
 *
 * @param pages - Array of page data
 * @param embedder - Embedder for generating embeddings
 * @param config - Configuration options
 * @returns Detection result
 */
export async function detectSentencePatterns(
  pages: PageData[],
  embedder: EmbedderInterface,
  config: Partial<SentencePatternConfig> = {}
): Promise<SentencePatternResult> {
  const cfg = { ...DEFAULT_SENTENCE_PATTERN_CONFIG, ...config }

  const result: SentencePatternResult = {
    removeFirstSentence: false,
    removeLastSentence: false,
    headerSimilarity: 0,
    footerSimilarity: 0,
  }

  // Need minimum pages to detect patterns reliably
  if (pages.length < cfg.minPages) {
    return result
  }

  // 1. Sample pages from the CENTER of the document
  // Middle pages are guaranteed to be content (not cover, TOC, or index)
  const centerIndex = Math.floor(pages.length / 2)
  const halfSample = Math.floor(cfg.samplePages / 2)
  const startIndex = Math.max(0, centerIndex - halfSample)
  const endIndex = Math.min(pages.length, startIndex + cfg.samplePages)
  const samplePages = pages.slice(startIndex, endIndex)

  // 2. Join each sampled page into text (sorted by Y coordinate)
  const pageTexts = samplePages.map((page) => joinPageItems(page.items))

  // 3. Split each page into sentences
  const pageSentences: string[][] = pageTexts.map((text) => splitIntoSentences(text))

  // 4. Collect first and last sentences from sampled pages
  const firstSentences: string[] = []
  const lastSentences: string[] = []

  for (const sentences of pageSentences) {
    if (sentences.length > 0) {
      firstSentences.push(sentences[0]!)
      if (sentences.length > 1) {
        lastSentences.push(sentences[sentences.length - 1]!)
      }
    }
  }

  // 5. Detect header pattern (sampled first sentences are semantically similar)
  if (firstSentences.length >= cfg.minPages) {
    const embeddings = await embedder.embedBatch(firstSentences)
    const avgSim = avgPairwiseSimilarity(embeddings)
    result.headerSimilarity = avgSim

    if (avgSim >= cfg.similarityThreshold) {
      result.removeFirstSentence = true
      console.error(
        `Sentence header detected: sampled ${firstSentences.length} center pages (${startIndex + 1}-${endIndex}), avg similarity: ${avgSim.toFixed(3)}`
      )
    }
  }

  // 6. Detect footer pattern (sampled last sentences are semantically similar)
  if (lastSentences.length >= cfg.minPages) {
    const embeddings = await embedder.embedBatch(lastSentences)
    const avgSim = avgPairwiseSimilarity(embeddings)
    result.footerSimilarity = avgSim

    if (avgSim >= cfg.similarityThreshold) {
      result.removeLastSentence = true
      console.error(
        `Sentence footer detected: sampled ${lastSentences.length} center pages (${startIndex + 1}-${endIndex}), avg similarity: ${avgSim.toFixed(3)}`
      )
    }
  }

  return result
}

/**
 * Filter page boundary sentences and join into text
 *
 * This is the main entry point for sentence-level header/footer filtering.
 * It detects and removes repeating sentence patterns at page boundaries.
 *
 * Use this instead of joinFilteredPages when embedder is available.
 *
 * @param pages - Array of page data
 * @param embedder - Embedder for generating embeddings
 * @param config - Configuration options
 * @returns Filtered text with header/footer sentences removed
 */
export async function filterPageBoundarySentences(
  pages: PageData[],
  embedder: EmbedderInterface,
  config: Partial<SentencePatternConfig> = {}
): Promise<string> {
  const cfg = { ...DEFAULT_SENTENCE_PATTERN_CONFIG, ...config }

  // Need minimum pages to detect patterns
  if (pages.length < cfg.minPages) {
    return joinFilteredPages(pages)
  }

  // Detect patterns
  const patterns = await detectSentencePatterns(pages, embedder, cfg)

  // If no patterns detected, return normally joined text
  if (!patterns.removeFirstSentence && !patterns.removeLastSentence) {
    return joinFilteredPages(pages)
  }

  // Join each page into text (sorted by Y coordinate)
  const pageTexts = pages.map((page) => joinPageItems(page.items))

  // Split each page into sentences
  const pageSentences: string[][] = pageTexts.map((text) => splitIntoSentences(text))

  // Remove detected patterns from page sentences
  const cleanedPageSentences = pageSentences.map((sentences) => {
    let cleaned = [...sentences]

    if (patterns.removeFirstSentence && cleaned.length > 0) {
      cleaned = cleaned.slice(1)
    }

    if (patterns.removeLastSentence && cleaned.length > 0) {
      cleaned = cleaned.slice(0, -1)
    }

    return cleaned
  })

  // Join back into final text
  return cleanedPageSentences
    .map((sentences) => sentences.join(' '))
    .filter((text) => text.length > 0)
    .join('\n\n')
}
