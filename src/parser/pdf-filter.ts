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
interface TextItemWithPosition {
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

// ============================================
// Text Joining
// ============================================

/**
 * Join page items into text
 *
 * Groups items by Y coordinate (same Y = same line),
 * sorts each group by X coordinate (left to right),
 * then joins groups with newlines (top to bottom).
 */
function joinPageItems(items: TextItemWithPosition[]): string {
  // Group by Y coordinate (rounded to handle minor variations)
  const yGroups = new Map<number, TextItemWithPosition[]>()
  for (const item of items) {
    const y = Math.round(item.y)
    const group = yGroups.get(y) || []
    group.push(item)
    yGroups.set(y, group)
  }

  // Sort groups by Y descending (top to bottom), items by X ascending (left to right)
  return [...yGroups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([_, group]) =>
      group
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .join(' ')
    )
    .join('\n')
    .trim()
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
// Sentence with Y Coordinate
// ============================================

/**
 * Sentence with Y coordinate from first PDF item
 */
interface SentenceWithY {
  text: string
  y: number
}

/**
 * Split page items into sentences with Y coordinate
 *
 * 1. Join items into text (preserving item boundaries)
 * 2. Split into sentences using splitIntoSentences
 * 3. Map each sentence to the Y coordinate of its first item
 * 4. Merge sentences with same Y coordinate
 *
 * @param items - Text items with position
 * @returns Sentences with Y coordinate (merged by Y)
 */
function splitItemsIntoSentencesWithY(items: TextItemWithPosition[]): SentenceWithY[] {
  if (items.length === 0) return []

  // Sort items by Y descending, then X ascending (reading order)
  const sortedItems = [...items].sort((a, b) => {
    const yDiff = b.y - a.y
    if (Math.abs(yDiff) > 1) return yDiff
    return a.x - b.x
  })

  // Build text and track character positions to item mapping
  const charToItem: Array<{ start: number; item: TextItemWithPosition }> = []
  let fullText = ''
  let prevY: number | null = null

  for (const item of sortedItems) {
    // Insert newline when Y coordinate changes (different line)
    // This matches joinPageItems behavior: same Y = space, different Y = newline
    if (prevY !== null && Math.abs(prevY - item.y) > 1) {
      fullText = `${fullText.trimEnd()}\n`
    }

    charToItem.push({ start: fullText.length, item })
    fullText += `${item.text} `
    prevY = item.y
  }

  // Split into sentences
  const sentences = splitIntoSentences(fullText)

  // Map each sentence to Y coordinate of its first character's item
  const sentencesWithY: SentenceWithY[] = []
  let searchStart = 0

  for (const sentence of sentences) {
    // Find where this sentence starts in fullText
    const sentenceStart = fullText.indexOf(sentence.trim(), searchStart)
    if (sentenceStart === -1) continue

    // Find the item that contains this position
    let firstItemY = sortedItems[0]?.y ?? 0
    for (let i = charToItem.length - 1; i >= 0; i--) {
      const entry = charToItem[i]
      if (entry && entry.start <= sentenceStart) {
        firstItemY = Math.round(entry.item.y)
        break
      }
    }

    sentencesWithY.push({ text: sentence, y: firstItemY })
    searchStart = sentenceStart + sentence.length
  }

  // Merge sentences with same Y coordinate
  return mergeSentencesByY(sentencesWithY)
}

/**
 * Merge sentences with same Y coordinate
 *
 * @param sentences - Sentences with Y coordinate
 * @returns Merged sentences (same Y = one sentence)
 */
function mergeSentencesByY(sentences: SentenceWithY[]): SentenceWithY[] {
  if (sentences.length === 0) return []

  const merged: SentenceWithY[] = []
  let current: SentenceWithY | null = null

  for (const sentence of sentences) {
    if (current === null) {
      current = { ...sentence }
    } else if (current.y === sentence.y) {
      // Same Y: merge text
      current.text += ` ${sentence.text}`
    } else {
      // Different Y: push current and start new
      merged.push(current)
      current = { ...sentence }
    }
  }

  if (current !== null) {
    merged.push(current)
  }

  return merged
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
 * Calculate median pairwise similarity for a list of embeddings
 *
 * Uses median instead of mean for robustness against outliers.
 * This handles cases where some pages have different header content
 * (e.g., chapter title changes) that would otherwise drag down the average.
 */
function medianPairwiseSimilarity(embeddings: number[][]): number {
  if (embeddings.length < 2) return 1.0

  const similarities: number[] = []

  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const embI = embeddings[i]
      const embJ = embeddings[j]
      if (embI && embJ) {
        similarities.push(cosineSimilarity(embI, embJ))
      }
    }
  }

  if (similarities.length === 0) return 0

  // Sort and find median
  similarities.sort((a, b) => a - b)
  const mid = Math.floor(similarities.length / 2)

  if (similarities.length % 2 === 0) {
    // Even: average of two middle values
    return ((similarities[mid - 1] ?? 0) + (similarities[mid] ?? 0)) / 2
  }
  // Odd: middle value
  return similarities[mid] ?? 0
}

/**
 * Configuration for sentence-level pattern detection
 */
interface SentencePatternConfig {
  /** Similarity threshold for pattern detection (default: 0.85) */
  similarityThreshold: number
  /** Minimum pages required for pattern detection (default: 3) */
  minPages: number
  /** Number of pages to sample from center for pattern detection (default: 5) */
  samplePages: number
}

/** Default configuration for sentence-level pattern detection */
const DEFAULT_SENTENCE_PATTERN_CONFIG: SentencePatternConfig = {
  similarityThreshold: 0.85,
  minPages: 3,
  samplePages: 5,
}

/**
 * Result of sentence-level pattern detection
 */
interface SentencePatternResult {
  /** Whether first sentences should be removed (detected as header) */
  removeFirstSentence: boolean
  /** Whether last sentences should be removed (detected as footer) */
  removeLastSentence: boolean
  /** Median similarity of first sentences */
  headerSimilarity: number
  /** Median similarity of last sentences */
  footerSimilarity: number
}

/**
 * Detect header/footer patterns at sentence level
 *
 * Algorithm:
 * 1. Sample pages from the CENTER of the document (guaranteed to be content pages)
 * 2. Split each page into sentences with Y coordinate
 * 3. Collect first/last sentences from sampled pages
 * 4. Embed and calculate median pairwise similarity
 * 5. If similarity > threshold, mark as header/footer
 *
 * Key insight: Middle pages are always content pages (cover, TOC, index are at edges).
 * Using median instead of mean provides robustness against outliers.
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

  // 2. Split each page into sentences with Y coordinate (merged by Y)
  const pageSentences: SentenceWithY[][] = samplePages.map((page) =>
    splitItemsIntoSentencesWithY(page.items)
  )

  // 3. Collect first and last sentences from sampled pages
  const firstSentences: string[] = []
  const lastSentences: string[] = []

  for (const sentences of pageSentences) {
    if (sentences.length > 0) {
      firstSentences.push(sentences[0]!.text)
      if (sentences.length > 1) {
        lastSentences.push(sentences[sentences.length - 1]!.text)
      }
    }
  }

  // 5. Detect header pattern (sampled first sentences are semantically similar)
  if (firstSentences.length >= cfg.minPages) {
    const embeddings = await embedder.embedBatch(firstSentences)
    const medianSim = medianPairwiseSimilarity(embeddings)
    result.headerSimilarity = medianSim

    if (medianSim >= cfg.similarityThreshold) {
      result.removeFirstSentence = true
      console.error(
        `Sentence header detected: sampled ${firstSentences.length} center pages (${startIndex + 1}-${endIndex}), median similarity: ${medianSim.toFixed(3)}`
      )
    }
  }

  // 6. Detect footer pattern (sampled last sentences are semantically similar)
  if (lastSentences.length >= cfg.minPages) {
    const embeddings = await embedder.embedBatch(lastSentences)
    const medianSim = medianPairwiseSimilarity(embeddings)
    result.footerSimilarity = medianSim

    if (medianSim >= cfg.similarityThreshold) {
      result.removeLastSentence = true
      console.error(
        `Sentence footer detected: sampled ${lastSentences.length} center pages (${startIndex + 1}-${endIndex}), median similarity: ${medianSim.toFixed(3)}`
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

  // Split each page into sentences with Y coordinate (merged by Y)
  const pageSentences: SentenceWithY[][] = pages.map((page) =>
    splitItemsIntoSentencesWithY(page.items)
  )

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
    .map((sentences) => sentences.map((s) => s.text).join(' '))
    .filter((text) => text.length > 0)
    .join('\n\n')
}
