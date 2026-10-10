// PDF Header/Footer Filter
// - Detects and removes repeating patterns across pages
// - Semantic similarity-based header/footer detection (sentence-level)

import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import { splitIntoSentenceUnits } from '../chunker/sentence-splitter.js'

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

function beginsNewNativeBlock(
  previousItem: TextItemWithPosition,
  item: TextItemWithPosition
): boolean {
  if (previousItem.blockOrdinal !== undefined && item.blockOrdinal !== undefined) {
    return previousItem.blockOrdinal !== item.blockOrdinal
  }
  return (
    previousItem.blockOrdinal !== undefined ||
    item.blockOrdinal !== undefined ||
    previousItem.hasEOL
  )
}

function buildPageLayout(pageNum: number, items: TextItemWithPosition[]): FilteredPageLayout {
  let rawText = ''
  let previousItem: TextItemWithPosition | undefined
  const rawFragments: RawFragment[] = []
  const fragmentCounts = new Map<string, number>()

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]
    if (!item || item.text.trim().length === 0) {
      continue
    }

    if (previousItem) {
      rawText += beginsNewNativeBlock(previousItem, item) ? '\n' : ' '
    }

    const rawStart = rawText.length
    rawText += item.text
    const rawEnd = rawText.length
    const blockOrdinal = item.blockOrdinal ?? itemIndex
    const lineOrdinal = item.lineOrdinal ?? 0
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

interface KeptTextSegment {
  sourceStart: number
  sourceEnd: number
  outputStart: number
}

/** Remove only selected source ranges and rebase the surviving fragments. */
function removeSourceSpans(
  layout: FilteredPageLayout,
  spans: readonly Pick<SentenceWithY, 'sourceStart' | 'sourceEnd'>[]
): FilteredPageLayout {
  const kept: KeptTextSegment[] = []
  const orderedSpans = spans
    .map((span) => ({
      start: Math.max(0, Math.min(layout.text.length, span.sourceStart)),
      end: Math.max(0, Math.min(layout.text.length, span.sourceEnd)),
    }))
    .filter((span) => span.start < span.end)
    .sort((left, right) => left.start - right.start)
  let sourceCursor = 0
  let outputText = ''

  const keepRange = (sourceStart: number, sourceEnd: number): void => {
    if (sourceStart >= sourceEnd) {
      return
    }
    kept.push({ sourceStart, sourceEnd, outputStart: outputText.length })
    outputText += layout.text.slice(sourceStart, sourceEnd)
  }

  for (const span of orderedSpans) {
    const start = Math.max(sourceCursor, span.start)
    if (start > sourceCursor) {
      keepRange(sourceCursor, start)
    }
    sourceCursor = Math.max(sourceCursor, span.end)
  }
  if (sourceCursor < layout.text.length) {
    keepRange(sourceCursor, layout.text.length)
  }

  const leadingWhitespace = outputText.length - outputText.trimStart().length
  const trailingBoundary = outputText.trimEnd().length
  const text = outputText.slice(leadingWhitespace, trailingBoundary)
  const textFragments: FilteredTextFragment[] = []

  for (const fragment of layout.textFragments) {
    for (const segment of kept) {
      const sourceStart = Math.max(fragment.pageTextStart, segment.sourceStart)
      const sourceEnd = Math.min(fragment.pageTextEnd, segment.sourceEnd)
      if (sourceStart >= sourceEnd) {
        continue
      }

      const outputStart = segment.outputStart + sourceStart - segment.sourceStart
      const outputEnd = segment.outputStart + sourceEnd - segment.sourceStart
      const clippedStart = Math.max(outputStart, leadingWhitespace)
      const clippedEnd = Math.min(outputEnd, trailingBoundary)
      if (clippedStart >= clippedEnd) {
        continue
      }

      const pageTextStart = clippedStart - leadingWhitespace
      const pageTextEnd = clippedEnd - leadingWhitespace
      textFragments.push({
        ...fragment,
        text: text.slice(pageTextStart, pageTextEnd),
        pageTextStart,
        pageTextEnd,
      })
    }
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
  sourceStart: number
  sourceEnd: number
}

/**
 * Split the ordered page text into sentence units while retaining exact source
 * spans. Y is used only as the boundary detector's geometric hint.
 */
function splitItemsIntoSentencesWithY(
  pageNum: number,
  items: TextItemWithPosition[]
): SentenceWithY[] {
  if (items.length === 0) {
    return []
  }

  const layout = buildPageLayout(pageNum, items)
  return splitIntoSentenceUnits(layout.text).map((unit) => {
    const firstFragment = layout.textFragments.find(
      (fragment) =>
        fragment.pageTextStart < unit.sourceEnd && fragment.pageTextEnd > unit.sourceStart
    )
    const firstItemIndex = firstFragment
      ? items.findIndex(
          (item, index) =>
            (item.blockOrdinal ?? index) === firstFragment.blockOrdinal &&
            (item.lineOrdinal ?? 0) === firstFragment.lineOrdinal &&
            item.text.includes(firstFragment.text)
        )
      : -1
    return {
      text: unit.text,
      y: firstItemIndex >= 0 ? Math.round(items[firstItemIndex]?.y ?? 0) : 0,
      sourceStart: unit.sourceStart,
      sourceEnd: unit.sourceEnd,
    }
  })
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

  // 2. Split each page in its ordered source layout and retain first-item Y.
  const pageSentences: SentenceWithY[][] = samplePages.map((page) =>
    splitItemsIntoSentencesWithY(page.pageNum, page.items)
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
  const layouts = pages.map((page) => buildPageLayout(page.pageNum, page.items))

  // Need minimum pages to detect patterns
  if (pages.length < cfg.minPages) {
    return layouts
  }

  // Detect block attribute candidates for boosted threshold
  const blockHints = detectBlockAttributeCandidates(pages, cfg)

  // Detect patterns (with block hints for boosted threshold)
  const patterns = await detectSentencePatterns(pages, embedder, { ...cfg, blockHints })

  // If no patterns detected, return normally joined text per page
  if (!patterns.removeFirstSentence && !patterns.removeLastSentence) {
    return layouts
  }

  // Keep sentence source spans so a detected boundary removes only its text.
  const pageSentences: SentenceWithY[][] = pages.map((page) =>
    splitItemsIntoSentencesWithY(page.pageNum, page.items)
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

  return layouts.map((layout, pageIndex) => {
    let cleaned = [...(pageSentences[pageIndex] ?? [])]
    const removed: SentenceWithY[] = []
    if (patterns.removeFirstSentence && matchesRepeatedBoundary(cleaned[0], 'first')) {
      if (cleaned[0]) {
        removed.push(cleaned[0])
      }
      cleaned = cleaned.slice(1)
    }
    const last = cleaned.at(-1)
    if (patterns.removeLastSentence && matchesRepeatedBoundary(last, 'last')) {
      if (last) {
        removed.push(last)
      }
      cleaned = cleaned.slice(0, -1)
    }
    return removeSourceSpans(layout, removed)
  })
}
