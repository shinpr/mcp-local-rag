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
  fontName?: string
  fontWeight?: string
  blockOrdinal?: number
  lineOrdinal?: number
  bbox?: [number, number, number, number]
}

/**
 * Page data containing positioned text items
 */
export interface PageData {
  pageNum: number
  items: TextItemWithPosition[]
  pageHeight?: number
}

export interface FilteredTextFragment {
  pageNum: number
  blockOrdinal: number
  lineOrdinal: number
  fragmentOrdinal: number
  bbox: [number, number, number, number]
  text: string
  pageTextStart: number
  pageTextEnd: number
}

export interface FilteredPageLayout {
  text: string
  textFragments: FilteredTextFragment[]
}

// ============================================
// Text Joining
// ============================================

/**
 * Join page items into text, preserving the native item stream. `hasEOL`
 * separates fragments on one native line from the next; geometry stays
 * placement metadata and is never a global reading-order comparator.
 */
/** A fragment positioned in the untrimmed page text, before rebasing. */
type RawFragment = Omit<FilteredTextFragment, 'text' | 'pageTextStart' | 'pageTextEnd'> & {
  rawStart: number
  rawEnd: number
}

function buildPageLayout(pageNum: number, items: TextItemWithPosition[]): FilteredPageLayout {
  let rawText = ''
  let previousItem: TextItemWithPosition | undefined
  const rawFragments: RawFragment[] = []
  const fragmentCounts = new Map<string, number>()

  const orderedItems = [...items].sort(
    (left, right) => Math.round(right.y) - Math.round(left.y) || left.x - right.x
  )
  for (let itemIndex = 0; itemIndex < orderedItems.length; itemIndex++) {
    const item = orderedItems[itemIndex]
    if (!item || item.text.trim().length === 0) {
      continue
    }

    if (previousItem) {
      rawText += Math.round(previousItem.y) === Math.round(item.y) ? ' ' : '\n'
    }

    const rawStart = rawText.length
    rawText += item.text
    const rawEnd = rawText.length
    const blockOrdinal = item.blockOrdinal ?? 0
    const lineOrdinal = item.lineOrdinal ?? itemIndex
    const lineKey = `${blockOrdinal}:${lineOrdinal}`
    const fragmentOrdinal = fragmentCounts.get(lineKey) ?? 0
    fragmentCounts.set(lineKey, fragmentOrdinal + 1)
    rawFragments.push({
      pageNum,
      blockOrdinal,
      lineOrdinal,
      fragmentOrdinal,
      bbox: item.bbox ?? [item.x, item.y, item.x, item.y],
      rawStart,
      rawEnd,
    })
    previousItem = item
  }

  return trimToPageText(rawText, rawFragments)
}

/**
 * Trim the page's raw text and rebase every fragment onto it, dropping any
 * fragment that consisted only of the trimmed whitespace.
 */
function trimToPageText(rawText: string, rawFragments: readonly RawFragment[]): FilteredPageLayout {
  const leadingWhitespace = rawText.length - rawText.trimStart().length
  const trailingBoundary = rawText.trimEnd().length
  const text = rawText.slice(leadingWhitespace, trailingBoundary)
  const textFragments: FilteredTextFragment[] = []

  for (const fragment of rawFragments) {
    const clippedStart = Math.max(fragment.rawStart, leadingWhitespace)
    const clippedEnd = Math.min(fragment.rawEnd, trailingBoundary)
    if (clippedStart >= clippedEnd) {
      continue
    }
    const pageTextStart = clippedStart - leadingWhitespace
    const pageTextEnd = clippedEnd - leadingWhitespace
    textFragments.push({
      pageNum: fragment.pageNum,
      blockOrdinal: fragment.blockOrdinal,
      lineOrdinal: fragment.lineOrdinal,
      fragmentOrdinal: fragment.fragmentOrdinal,
      bbox: fragment.bbox,
      text: text.slice(pageTextStart, pageTextEnd),
      pageTextStart,
      pageTextEnd,
    })
  }

  return { text, textFragments }
}

function buildSentenceLayout(
  pageNum: number,
  sentences: readonly SentenceWithY[],
  items: readonly TextItemWithPosition[]
): FilteredPageLayout {
  let text = ''
  const textFragments: FilteredTextFragment[] = []
  for (const sentence of sentences) {
    if (text) {
      text += ' '
    }
    const start = text.length
    text += sentence.text
    const matchingItems = items.filter((item) => Math.round(item.y) === Math.round(sentence.y))
    const first = matchingItems[0]
    const boxes: Array<[number, number, number, number]> = matchingItems.map(
      (item) => item.bbox ?? [item.x, item.y, item.x, item.y]
    )
    const bbox: [number, number, number, number] = boxes.length
      ? [
          Math.min(...boxes.map((box) => box[0])),
          Math.min(...boxes.map((box) => box[1])),
          Math.max(...boxes.map((box) => box[2])),
          Math.max(...boxes.map((box) => box[3])),
        ]
      : [0, 0, 0, 0]
    textFragments.push({
      pageNum,
      blockOrdinal: first?.blockOrdinal ?? 0,
      lineOrdinal: first?.lineOrdinal ?? textFragments.length,
      fragmentOrdinal: 0,
      bbox,
      text: sentence.text,
      pageTextStart: start,
      pageTextEnd: text.length,
    })
  }
  return { text, textFragments }
}

function joinPageItems(items: TextItemWithPosition[]): string {
  return buildPageLayout(0, items).text
}

/** Join filtered pages into one text. */
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
 * Split page items into sentences, each mapped to the Y of its first item, and
 * merged when they share a Y.
 */
function splitItemsIntoSentencesWithY(items: TextItemWithPosition[]): SentenceWithY[] {
  if (items.length === 0) {
    return []
  }

  // Sort items by Y descending, then X ascending (reading order)
  const sortedItems = [...items].sort((a, b) => {
    const yDiff = b.y - a.y
    if (Math.abs(yDiff) > 1) {
      return yDiff
    }
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
    // Benign skip (not error masking): this builds the Y-coordinate map used
    // only for header/footer boundary detection. A miss means this sentence
    // is omitted from boundary detection — it does NOT drop the sentence from
    // the document body (that text comes from `fullText`). Misses are expected
    // when `splitIntoSentences` normalizes whitespace differently than the
    // reconstructed `fullText`, so logging here would be noise, not signal.
    if (sentenceStart === -1) {
      continue
    }

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

/** Sentences sharing a Y coordinate are one sentence. */
function mergeSentencesByY(sentences: SentenceWithY[]): SentenceWithY[] {
  if (sentences.length === 0) {
    return []
  }

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
  if (denominator === 0) {
    return 0
  }

  return dotProduct / denominator
}

/**
 * Median pairwise similarity — median rather than mean so one page with
 * different header content (a chapter title change) cannot drag it down.
 */
function medianPairwiseSimilarity(embeddings: number[][]): number {
  if (embeddings.length < 2) {
    return 1.0
  }

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

  if (similarities.length === 0) {
    return 0
  }

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

/** The sentence at the requested edge of a page's sampled sentences. */
function sentenceAtEdge<T>(sentences: readonly T[], edge: 'first' | 'last'): T | undefined {
  if (edge === 'first') {
    return sentences[0]
  }
  return sentences.length > 1 ? sentences.at(-1) : undefined
}

/**
 * Sample pages from the center of the document
 *
 * Center pages are guaranteed to be content (not cover, TOC, or index).
 */
function sampleCenterPages(pages: PageData[], sampleSize: number): PageData[] {
  const centerIndex = Math.floor(pages.length / 2)
  const halfSample = Math.floor(sampleSize / 2)
  const startIndex = Math.max(0, centerIndex - halfSample)
  const endIndex = Math.min(pages.length, startIndex + sampleSize)
  return pages.slice(startIndex, endIndex)
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
  /** Block attribute hints for boosted threshold (from detectBlockAttributeCandidates) */
  blockHints?: BlockAttributeHints
  /** Boosted similarity threshold when block hints match (default: 0.75) */
  boostedThreshold?: number
}

/** Default configuration for sentence-level pattern detection */
const DEFAULT_SENTENCE_PATTERN_CONFIG: SentencePatternConfig = {
  similarityThreshold: 0.85,
  minPages: 3,
  samplePages: 5,
  boostedThreshold: 0.75,
}

// ============================================
// Block-Attribute Pre-filter (Stage 1)
// ============================================

/**
 * Hints for block-level header/footer detection based on font attributes
 */
export interface BlockAttributeHints {
  medianFontSize: number
  headerCandidateYs: Set<number>
  footerCandidateYs: Set<number>
}

/**
 * Stage 1 of header/footer detection: on the sampled center pages, a small
 * font near the top or bottom 10% of the page marks a candidate Y position.
 */
/** Median font size across the sampled pages; 0 when nothing has a size. */
function medianFontSizeOf(samplePages: readonly PageData[]): number {
  const fontSizes: number[] = []
  for (const page of samplePages) {
    for (const item of page.items) {
      if (item.fontSize > 0) {
        fontSizes.push(item.fontSize)
      }
    }
  }
  if (fontSizes.length === 0) {
    return 0
  }
  fontSizes.sort((a, b) => a - b)
  const mid = Math.floor(fontSizes.length / 2)
  const lower = fontSizes[mid - 1] ?? 0
  const upper = fontSizes[mid] ?? 0
  return fontSizes.length % 2 === 0 ? (lower + upper) / 2 : upper
}

/** Actual page height when a sampled page reports one, else the largest Y seen. */
function pageHeightOf(samplePages: readonly PageData[]): number {
  const reported = samplePages.find((page) => page.pageHeight != null)?.pageHeight
  if (reported) {
    return reported
  }
  let maxY = 0
  for (const page of samplePages) {
    for (const item of page.items) {
      if (item.y > maxY) {
        maxY = item.y
      }
    }
  }
  return maxY
}

/** Small-font items sitting in the top or bottom 10% of the page. */
function collectEdgeCandidateYs(
  samplePages: readonly PageData[],
  fontSizeThreshold: number,
  pageHeight: number
): { headerCandidateYs: Set<number>; footerCandidateYs: Set<number> } {
  const headerCandidateYs = new Set<number>()
  const footerCandidateYs = new Set<number>()
  for (const page of samplePages) {
    for (const item of page.items) {
      if (item.fontSize >= fontSizeThreshold) {
        continue
      }
      const roundedY = Math.round(item.y)
      // Header: top 10% of page (large Y values, since Y is inverted)
      if (item.y > pageHeight * 0.9) {
        headerCandidateYs.add(roundedY)
      }
      // Footer: bottom 10% of page (small Y values)
      if (item.y < pageHeight * 0.1) {
        footerCandidateYs.add(roundedY)
      }
    }
  }
  return { headerCandidateYs, footerCandidateYs }
}

export function detectBlockAttributeCandidates(
  pages: PageData[],
  config: Partial<Pick<SentencePatternConfig, 'minPages' | 'samplePages'>> = {}
): BlockAttributeHints {
  const cfg = { ...DEFAULT_SENTENCE_PATTERN_CONFIG, ...config }
  const emptyResult: BlockAttributeHints = {
    medianFontSize: 0,
    headerCandidateYs: new Set(),
    footerCandidateYs: new Set(),
  }

  if (pages.length < cfg.minPages) {
    return emptyResult
  }

  const samplePages = sampleCenterPages(pages, cfg.samplePages)
  const medianFontSize = medianFontSizeOf(samplePages)
  if (medianFontSize === 0) {
    return emptyResult
  }

  const pageHeight = pageHeightOf(samplePages)
  if (pageHeight === 0) {
    return { ...emptyResult, medianFontSize }
  }

  return {
    medianFontSize,
    ...collectEdgeCandidateYs(samplePages, medianFontSize * 0.7, pageHeight),
  }
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
 * Detect header/footer patterns at sentence level.
 *
 * Center pages are sampled because cover, TOC and index sit at the edges, and
 * the median pairwise similarity resists an outlier page. Semantic similarity
 * rather than exact matching is what makes variable text like "7 of 75" match.
 */
/**
 * Shared boundary-pattern detection for the header and footer cases of
 * {@link detectSentencePatterns}. The divergent part — which sentence each page
 * contributes and how its Y is derived — is passed in, so this helper is
 * identical for both boundaries.
 */
async function detectBoundaryPattern(params: {
  label: 'header' | 'footer'
  sentences: string[]
  sentenceYs: number[]
  candidateYs: Set<number> | undefined
  similarityThreshold: number
  boostedThreshold: number | undefined
  embedder: EmbedderInterface
  startIndex: number
  endIndex: number
}): Promise<{ similarity: number; detected: boolean }> {
  const {
    label,
    sentences,
    sentenceYs,
    candidateYs,
    similarityThreshold,
    boostedThreshold,
    embedder,
    startIndex,
    endIndex,
  } = params

  const embeddings = await embedder.embedBatch(sentences)
  const medianSim = medianPairwiseSimilarity(embeddings)

  // Determine effective threshold (boosted if block hints match)
  let threshold = similarityThreshold
  if (candidateYs && sentenceYs.some((y) => candidateYs.has(y))) {
    threshold = boostedThreshold ?? 0.75
  }

  const detected = medianSim >= threshold
  if (detected) {
    console.error(
      `Sentence ${label} detected: sampled ${sentences.length} center pages (${startIndex + 1}-${endIndex}), median similarity: ${medianSim.toFixed(3)}`
    )
  }

  return { similarity: medianSim, detected }
}

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
  const samplePages = sampleCenterPages(pages, cfg.samplePages)
  const firstSamplePage = samplePages[0]
  const startIndex = firstSamplePage === undefined ? 0 : pages.indexOf(firstSamplePage)
  const endIndex = startIndex + samplePages.length

  // 2. Split each page into sentences with Y coordinate (merged by Y)
  const pageSentences: SentenceWithY[][] = samplePages.map((page) =>
    splitItemsIntoSentencesWithY(page.items)
  )

  // 3. Collect first and last sentences from sampled pages
  const firstSentences: string[] = []
  const lastSentences: string[] = []

  for (const sentences of pageSentences) {
    const first = sentences[0]
    if (first === undefined) {
      continue
    }
    firstSentences.push(first.text)
    const last = sentences.length > 1 ? sentences.at(-1) : undefined
    if (last !== undefined) {
      lastSentences.push(last.text)
    }
  }

  // 5. Detect header pattern (sampled first sentences are semantically similar)
  if (firstSentences.length >= cfg.minPages) {
    const firstSentenceYs = pageSentences
      .filter((s) => s.length > 0)
      .map((s) => Math.round(s[0]?.y ?? 0))
    const { similarity, detected } = await detectBoundaryPattern({
      label: 'header',
      sentences: firstSentences,
      sentenceYs: firstSentenceYs,
      candidateYs: cfg.blockHints?.headerCandidateYs,
      similarityThreshold: cfg.similarityThreshold,
      boostedThreshold: cfg.boostedThreshold,
      embedder,
      startIndex,
      endIndex,
    })
    result.headerSimilarity = similarity
    result.removeFirstSentence = detected
  }

  // 6. Detect footer pattern (sampled last sentences are semantically similar)
  if (lastSentences.length >= cfg.minPages) {
    const lastSentenceYs = pageSentences
      .filter((s) => s.length > 1)
      .map((s) => Math.round(s.at(-1)?.y ?? 0))
    const { similarity, detected } = await detectBoundaryPattern({
      label: 'footer',
      sentences: lastSentences,
      sentenceYs: lastSentenceYs,
      candidateYs: cfg.blockHints?.footerCandidateYs,
      similarityThreshold: cfg.similarityThreshold,
      boostedThreshold: cfg.boostedThreshold,
      embedder,
      startIndex,
      endIndex,
    })
    result.footerSimilarity = similarity
    result.removeLastSentence = detected
  }

  return result
}

/**
 * Main entry point for sentence-level header/footer filtering: removes
 * repeating boundary sentences and returns one filtered text per page.
 *
 * Use this rather than {@link joinFilteredPages} when an embedder is available.
 */
export async function filterPageBoundarySentences(
  pages: PageData[],
  embedder: EmbedderInterface,
  config: Partial<SentencePatternConfig> = {}
): Promise<string[]> {
  return (await filterPageBoundaryLayouts(pages, embedder, config)).map((page) => page.text)
}

/**
 * Filter page boundaries while retaining native provenance for every survivor.
 */
export async function filterPageBoundaryLayouts(
  pages: PageData[],
  embedder: EmbedderInterface,
  config: Partial<SentencePatternConfig> = {}
): Promise<FilteredPageLayout[]> {
  const cfg = { ...DEFAULT_SENTENCE_PATTERN_CONFIG, ...config }

  // Need minimum pages to detect patterns
  if (pages.length < cfg.minPages) {
    return pages.map((page) => buildPageLayout(page.pageNum, page.items))
  }

  // Detect block attribute candidates for boosted threshold
  const blockHints = detectBlockAttributeCandidates(pages, cfg)

  // Detect patterns (with block hints for boosted threshold)
  const patterns = await detectSentencePatterns(pages, embedder, { ...cfg, blockHints })

  // If no patterns detected, return normally joined text per page
  if (!patterns.removeFirstSentence && !patterns.removeLastSentence) {
    return pages.map((page) => buildPageLayout(page.pageNum, page.items))
  }

  // Split each page into sentences with Y coordinate (merged by Y)
  const pageSentences: SentenceWithY[][] = pages.map((page) =>
    splitItemsIntoSentencesWithY(page.items)
  )

  const sampledSentences = sampleCenterPages(pages, cfg.samplePages).map(
    (page) => pageSentences[pages.indexOf(page)] ?? []
  )
  const matchesRepeatedBoundary = (
    sentence: SentenceWithY | undefined,
    edge: 'first' | 'last'
  ): boolean => {
    if (!sentence) {
      return false
    }
    // Page numbers may vary; other text and rounded position must repeat.
    const key = (value: SentenceWithY): string =>
      `${Math.round(value.y)}:${value.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()}`
    const target = key(sentence)
    return (
      sampledSentences.filter((sentences) => {
        const candidate = sentenceAtEdge(sentences, edge)
        return candidate !== undefined && key(candidate) === target
      }).length >= 2
    )
  }

  return pages.map((page, pageIndex) => {
    let cleaned = [...(pageSentences[pageIndex] ?? [])]
    if (patterns.removeFirstSentence && matchesRepeatedBoundary(cleaned[0], 'first')) {
      cleaned = cleaned.slice(1)
    }
    if (patterns.removeLastSentence && matchesRepeatedBoundary(cleaned.at(-1), 'last')) {
      cleaned = cleaned.slice(0, -1)
    }
    return buildSentenceLayout(page.pageNum, cleaned, page.items)
  })
}
