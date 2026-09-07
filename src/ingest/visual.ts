import type { AtomicTextRange, SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { DocumentParser } from '../parser/index.js'
import type { FilteredTextFragment } from '../parser/pdf-filter.js'
import type { DetectedVisualRegion, ProcessedVisualRegion } from '../pdf-visual/types.js'
import type { QualityProfile } from '../utils/visual-profile.js'
import type { VisualAttachment } from '../vectordb/types.js'
import { buildChunksAndEmbeddings, createVisualAttachment, findNearestChunk } from './compute.js'

export interface VisualPdfParser {
  parsePdfPages: DocumentParser['parsePdfPages']
}

export interface CaptionerConfig {
  profile: QualityProfile
  cacheDir: string
  device?: string | undefined
}

/** Collaborators one visual PDF ingest run needs, injected as a unit. */
export interface VisualIngestCollaborators {
  parser: VisualPdfParser
  chunker: SemanticChunker
  embedder: EmbedderInterface
}

export interface PrepareVisualPdfChunksOptions {
  images: boolean
  captioner?: CaptionerConfig
}

export interface PrepareVisualPdfChunksResult {
  chunks: TextChunk[]
  embeddings: number[][]
  title: string | null
  text: string
  atomicRanges: AtomicTextRange[]
  visualAttachments: Map<number, VisualAttachment[]>
  omittedImageCount: number
}

export interface OrderedVisualPage {
  pageNum: number
  text: string
  textFragments: readonly FilteredTextFragment[]
}

export interface OrderedVisualRegion extends ProcessedVisualRegion {
  visualIndex: number
  anchorOffset: number
  captionRange?: AtomicTextRange
}

export interface OrderedVisualDocument {
  text: string
  atomicRanges: AtomicTextRange[]
  regions: OrderedVisualRegion[]
}

function horizontalOverlap(left: readonly number[], right: readonly number[]): boolean {
  return Math.min(left[2] ?? 0, right[2] ?? 0) >= Math.max(left[0] ?? 0, right[0] ?? 0)
}

function xCenter(bbox: readonly number[]): number {
  return ((bbox[0] ?? 0) + (bbox[2] ?? 0)) / 2
}

function yCenter(bbox: readonly number[]): number {
  return ((bbox[1] ?? 0) + (bbox[3] ?? 0)) / 2
}

function findInsertionIndex(
  fragments: readonly FilteredTextFragment[],
  region: DetectedVisualRegion
): number {
  if (fragments.length === 0) {
    return 0
  }
  let candidates = fragments
    .map((fragment, index) => ({ fragment, index }))
    .filter(({ fragment }) => horizontalOverlap(fragment.bbox, region.bbox))

  if (candidates.length === 0) {
    const regionCenter = xCenter(region.bbox)
    const minimumDistance = Math.min(
      ...fragments.map((fragment) => Math.abs(xCenter(fragment.bbox) - regionCenter))
    )
    candidates = fragments
      .map((fragment, index) => ({ fragment, index }))
      .filter(({ fragment }) => Math.abs(xCenter(fragment.bbox) - regionCenter) === minimumDistance)
  }

  const regionMidpoint = yCenter(region.bbox)
  const preceding = candidates.filter(({ fragment }) => yCenter(fragment.bbox) <= regionMidpoint)
  if (preceding.length > 0) {
    return Math.max(...preceding.map(({ index }) => index + 1))
  }
  return Math.min(...candidates.map(({ index }) => index))
}

function fallbackFragments(page: OrderedVisualPage): readonly FilteredTextFragment[] {
  if (page.textFragments.length > 0 || page.text.length === 0) {
    return page.textFragments
  }
  return [
    {
      pageNum: page.pageNum,
      blockOrdinal: 0,
      lineOrdinal: 0,
      fragmentOrdinal: 0,
      bbox: [0, 0, 0, 0],
      text: page.text,
      pageTextStart: 0,
      pageTextEnd: page.text.length,
    },
  ]
}

/** One region with the fragment slot it should be inserted before. */
interface PositionedRegion {
  region: ProcessedVisualRegion
  insertionIndex: number
}

/** Regions on one page, ordered by insertion slot then detection order. */
function positionRegions(
  page: OrderedVisualPage,
  pageFragments: readonly FilteredTextFragment[],
  processedRegions: readonly ProcessedVisualRegion[]
): PositionedRegion[] {
  return processedRegions
    .filter((region) => region.pageNum === page.pageNum)
    .map((region) => ({ region, insertionIndex: findInsertionIndex(pageFragments, region) }))
    .sort(
      (left, right) =>
        left.insertionIndex - right.insertionIndex ||
        left.region.detectionIndex - right.region.detectionIndex
    )
}

/**
 * Group regions by the character offset in the page text they are inserted at,
 * so regions landing in the same gap are emitted together.
 */
function groupByInsertionOffset(
  page: OrderedVisualPage,
  pageFragments: readonly FilteredTextFragment[],
  positioned: readonly PositionedRegion[]
): Map<number, ProcessedVisualRegion[]> {
  const groups = new Map<number, ProcessedVisualRegion[]>()
  for (const item of positioned) {
    const preceding = pageFragments[item.insertionIndex - 1]
    const following = pageFragments[item.insertionIndex]
    const offset = Math.max(
      0,
      Math.min(page.text.length, preceding?.pageTextEnd ?? following?.pageTextStart ?? 0)
    )
    const group = groups.get(offset) ?? []
    group.push(item.region)
    groups.set(offset, group)
  }
  return groups
}

/** Page text with captions spliced in, plus where each region landed. */
interface RenderedPage {
  pageText: string
  captionRanges: Map<ProcessedVisualRegion, AtomicTextRange>
  anchorOffsets: Map<ProcessedVisualRegion, number>
}

/** Newlines needed so `adjacent` is separated by a blank line. */
function blankLinePadding(adjacent: string): string {
  const present = adjacent.match(/^\n*/)?.[0].length ?? 0
  return '\n'.repeat(Math.max(0, 2 - present))
}

/**
 * Append one insertion group's captions to `pageText`, recording each region's
 * caption range and anchor offset. Uncaptioned regions only get an anchor.
 */
function appendGroupCaptions(
  pageText: string,
  group: readonly ProcessedVisualRegion[],
  context: {
    page: OrderedVisualPage
    pageVisualIndices: Map<ProcessedVisualRegion, number>
    captionRanges: Map<ProcessedVisualRegion, AtomicTextRange>
    anchorOffsets: Map<ProcessedVisualRegion, number>
  }
): string {
  const { page, pageVisualIndices, ...into } = context
  let text = pageText
  let captionIndex = 0
  for (const region of group) {
    if (region.caption === null) {
      into.anchorOffsets.set(region, text.length)
      continue
    }
    if (captionIndex > 0) {
      text += '\n\n'
    }
    const start = text.length
    text += `[Visual content on page ${page.pageNum}, visual ${pageVisualIndices.get(region)}: ${region.caption}]`
    into.captionRanges.set(region, { start, end: text.length })
    into.anchorOffsets.set(region, start)
    captionIndex += 1
  }
  return text
}

function renderPageWithCaptions(
  page: OrderedVisualPage,
  insertionGroups: Map<number, ProcessedVisualRegion[]>,
  pageVisualIndices: Map<ProcessedVisualRegion, number>
): RenderedPage {
  let pageText = ''
  let pageCursor = 0
  const captionRanges = new Map<ProcessedVisualRegion, AtomicTextRange>()
  const anchorOffsets = new Map<ProcessedVisualRegion, number>()

  for (const [offset, group] of [...insertionGroups].sort((left, right) => left[0] - right[0])) {
    pageText += page.text.slice(pageCursor, offset)
    const hasCaption = group.some((region) => region.caption !== null)
    if (hasCaption && pageText.length > 0) {
      pageText += blankLinePadding(pageText.match(/\n*$/)?.[0] ?? '')
    }
    pageText = appendGroupCaptions(pageText, group, {
      page,
      pageVisualIndices,
      captionRanges,
      anchorOffsets,
    })
    if (hasCaption && offset < page.text.length) {
      pageText += blankLinePadding(page.text.slice(offset))
    }
    pageCursor = offset
  }
  pageText += page.text.slice(pageCursor)

  return { pageText, captionRanges, anchorOffsets }
}

/** Rebase one page-relative region onto the whole-document text. */
function toOrderedRegion(
  region: ProcessedVisualRegion,
  rendered: RenderedPage,
  pageStart: number,
  visualIndex: number
): OrderedVisualRegion {
  const relative = rendered.captionRanges.get(region)
  const captionRange = relative
    ? { start: pageStart + relative.start, end: pageStart + relative.end }
    : undefined
  const anchorOffset = rendered.anchorOffsets.get(region)
  if (anchorOffset === undefined) {
    throw new Error('Visual region has no anchor offset')
  }
  return {
    ...region,
    visualIndex,
    anchorOffset: pageStart + anchorOffset,
    ...(captionRange ? { captionRange } : {}),
  }
}

export function buildOrderedVisualDocument(
  pages: readonly OrderedVisualPage[],
  processedRegions: readonly ProcessedVisualRegion[]
): OrderedVisualDocument {
  let text = ''
  let visualIndex = 0
  const atomicRanges: AtomicTextRange[] = []
  const regions: OrderedVisualRegion[] = []
  const consumedRegions = new Set<ProcessedVisualRegion>()

  for (const page of pages) {
    const pageFragments = fallbackFragments(page)
    const positioned = positionRegions(page, pageFragments, processedRegions)
    const pageVisualIndices = new Map(
      positioned.map((item, index) => [item.region, visualIndex + index] as const)
    )
    const insertionGroups = groupByInsertionOffset(page, pageFragments, positioned)
    const rendered = renderPageWithCaptions(page, insertionGroups, pageVisualIndices)

    const pageSeparator = text.length > 0 && rendered.pageText.length > 0 ? '\n\n' : ''
    const pageStart = text.length + pageSeparator.length
    text += pageSeparator + rendered.pageText

    for (const positionedRegion of positioned) {
      const record = toOrderedRegion(positionedRegion.region, rendered, pageStart, visualIndex++)
      if (record.captionRange) {
        atomicRanges.push(record.captionRange)
      }
      regions.push(record)
      consumedRegions.add(positionedRegion.region)
    }
  }

  if (consumedRegions.size !== processedRegions.length) {
    throw new Error('A processed visual region has no matching PDF page')
  }

  return { text, atomicRanges, regions }
}

function assignVisualAttachments(
  document: OrderedVisualDocument,
  chunks: readonly TextChunk[],
  attachments: readonly VisualAttachment[]
): Map<number, VisualAttachment[]> {
  const attachmentsByChunkIndex = new Map<number, VisualAttachment[]>()
  if (chunks.length === 0) {
    return attachmentsByChunkIndex
  }
  const regionByVisualIndex = new Map(
    document.regions.map((region) => [region.visualIndex, region] as const)
  )
  const seenVisualIndices = new Set<number>()

  for (const attachment of [...attachments].sort(
    (left, right) => left.imageIndex - right.imageIndex
  )) {
    if (seenVisualIndices.has(attachment.imageIndex)) {
      throw new Error(`Duplicate visual attachment index: ${attachment.imageIndex}`)
    }
    seenVisualIndices.add(attachment.imageIndex)
    const region = regionByVisualIndex.get(attachment.imageIndex)
    if (!region) {
      throw new Error(`Visual attachment has no ordered region: ${attachment.imageIndex}`)
    }

    const owner = findNearestChunk(chunks, region.anchorOffset)
    if (!owner) {
      throw new Error(`Visual ${attachment.imageIndex} has no owning chunk`)
    }
    const current = attachmentsByChunkIndex.get(owner.index) ?? []
    current.push(attachment)
    attachmentsByChunkIndex.set(owner.index, current)
  }
  return attachmentsByChunkIndex
}

async function processImageOnlyRegions(
  regions: DetectedVisualRegion[],
  doc: Awaited<ReturnType<VisualPdfParser['parsePdfPages']>>['doc']
): Promise<{
  processed: ProcessedVisualRegion[]
  omittedImageCount: number
}> {
  const renderer = await import('../pdf-visual/renderer.js')
  const processed: ProcessedVisualRegion[] = []
  let omittedImageCount = 0
  for (const region of regions) {
    try {
      const image = await renderer.renderPdfRendition(
        doc,
        region.pageNum,
        region.bbox,
        region.evidence
      )
      processed.push({ ...region, caption: null, rendition: image })
    } catch {
      omittedImageCount += 1
      processed.push({ ...region, caption: null })
    }
  }
  return { processed, omittedImageCount }
}

/**
 * Detect visual regions and turn them into processed ones. With a captioner
 * configured the VLM barrel is loaded and every region is captioned; without
 * one only the lighter detector is loaded and regions carry images alone.
 */
async function detectAndProcessRegions(
  pages: Awaited<ReturnType<VisualPdfParser['parsePdfPages']>>['pages'],
  doc: Awaited<ReturnType<VisualPdfParser['parsePdfPages']>>['doc'],
  captionerConfig: CaptionerConfig | undefined,
  includeImages: boolean
): Promise<{ processed: ProcessedVisualRegion[]; omittedImageCount: number }> {
  const pageRefs = pages.map((page) => ({ pageNum: page.pageNum, stextJson: page.stextJson }))
  if (captionerConfig === undefined) {
    const detector = await import('../pdf-visual/detector.js')
    return processImageOnlyRegions(detector.detectVisualRegions(pageRefs, doc), doc)
  }
  const pdfVisual = await import('../pdf-visual/index.js')
  const regions = pdfVisual.detectVisualRegions(pageRefs, doc)
  const captioner = pdfVisual.createCaptioner(captionerConfig)
  try {
    const processed = await pdfVisual.processVisualRegions(regions, doc, {
      captioner,
      includeImages,
    })
    return { processed, omittedImageCount: 0 }
  } finally {
    await captioner.dispose()
  }
}

/** Encode every rendered region; one that cannot be encoded is omitted, not fatal. */
function collectAttachments(regions: readonly OrderedVisualRegion[]): {
  attachments: VisualAttachment[]
  omittedImageCount: number
} {
  const attachments: VisualAttachment[] = []
  let omittedImageCount = 0
  for (const region of regions) {
    if (!region.rendition) {
      continue
    }
    try {
      attachments.push(createVisualAttachment(region.visualIndex, region.rendition))
    } catch {
      omittedImageCount += 1
    }
  }
  return { attachments, omittedImageCount }
}

export async function prepareVisualPdfChunks(
  filePath: string,
  collaborators: VisualIngestCollaborators,
  options: PrepareVisualPdfChunksOptions
): Promise<PrepareVisualPdfChunksResult> {
  const { parser, chunker, embedder } = collaborators
  const captionerConfig = options.captioner
  const { doc, title, pages } = await parser.parsePdfPages(filePath, embedder)
  try {
    let omittedImageCount = 0

    const detected = await detectAndProcessRegions(pages, doc, captionerConfig, options.images)
    const processed = detected.processed
    omittedImageCount += detected.omittedImageCount

    const ordered = buildOrderedVisualDocument(pages, processed)
    const { chunks, embeddings } = await buildChunksAndEmbeddings(
      ordered.text,
      chunker,
      embedder,
      ordered.atomicRanges
    )
    const collected = options.images
      ? collectAttachments(ordered.regions)
      : { attachments: [], omittedImageCount: 0 }
    const attachments = collected.attachments
    omittedImageCount += collected.omittedImageCount
    const visualAttachments = assignVisualAttachments(ordered, chunks, attachments)
    return {
      chunks,
      embeddings,
      title,
      text: ordered.text,
      atomicRanges: ordered.atomicRanges,
      visualAttachments,
      omittedImageCount,
    }
  } finally {
    try {
      doc.destroy()
    } catch (destroyError) {
      const message = destroyError instanceof Error ? destroyError.message : String(destroyError)
      console.warn(`prepareVisualPdfChunks: doc.destroy() failed: ${message}`)
    }
  }
}
