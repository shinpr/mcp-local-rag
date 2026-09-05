import type { AtomicTextRange, SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { DocumentParser } from '../parser/index.js'
import type { FilteredTextFragment } from '../parser/pdf-filter.js'
import type {
  DetectedVisualRegion,
  ProcessedVisualRegion,
  QualityProfile,
} from '../pdf-visual/types.js'
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
  if (fragments.length === 0) return 0
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
  if (page.textFragments.length > 0 || page.text.length === 0) return page.textFragments
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
    const positioned = processedRegions
      .filter((region) => region.pageNum === page.pageNum)
      .map((region) => ({
        region,
        insertionIndex: findInsertionIndex(pageFragments, region),
      }))
      .sort(
        (left, right) =>
          left.insertionIndex - right.insertionIndex ||
          left.region.detectionIndex - right.region.detectionIndex
      )
    const pageVisualIndices = new Map(
      positioned.map((item, index) => [item.region, visualIndex + index] as const)
    )

    const insertionOffsets = new Map<ProcessedVisualRegion, number>()
    for (const item of positioned) {
      const preceding = pageFragments[item.insertionIndex - 1]
      const following = pageFragments[item.insertionIndex]
      insertionOffsets.set(
        item.region,
        Math.max(
          0,
          Math.min(page.text.length, preceding?.pageTextEnd ?? following?.pageTextStart ?? 0)
        )
      )
    }

    const insertionGroups = new Map<number, ProcessedVisualRegion[]>()
    for (const item of positioned) {
      const offset = insertionOffsets.get(item.region) ?? 0
      const group = insertionGroups.get(offset) ?? []
      group.push(item.region)
      insertionGroups.set(offset, group)
    }

    let pageText = ''
    let pageCursor = 0
    const captionRanges = new Map<ProcessedVisualRegion, AtomicTextRange>()
    const anchorOffsets = new Map<ProcessedVisualRegion, number>()
    for (const [offset, group] of [...insertionGroups].sort((left, right) => left[0] - right[0])) {
      pageText += page.text.slice(pageCursor, offset)
      const hasCaption = group.some((region) => region.caption !== null)
      if (hasCaption) {
        const trailingNewlines = pageText.match(/\n*$/)?.[0].length ?? 0
        pageText += pageText.length > 0 ? '\n'.repeat(Math.max(0, 2 - trailingNewlines)) : ''
      }
      let captionIndex = 0
      for (const region of group) {
        if (region.caption === null) {
          anchorOffsets.set(region, pageText.length)
          continue
        }
        if (captionIndex > 0) pageText += '\n\n'
        const start = pageText.length
        pageText += `[Visual content on page ${page.pageNum}, visual ${pageVisualIndices.get(region)}: ${region.caption}]`
        captionRanges.set(region, { start, end: pageText.length })
        anchorOffsets.set(region, start)
        captionIndex += 1
      }
      if (hasCaption && offset < page.text.length) {
        const leadingNewlines = page.text.slice(offset).match(/^\n*/)?.[0].length ?? 0
        pageText += '\n'.repeat(Math.max(0, 2 - leadingNewlines))
      }
      pageCursor = offset
    }
    pageText += page.text.slice(pageCursor)

    const pageSeparator = text.length > 0 && pageText.length > 0 ? '\n\n' : ''
    const pageStart = text.length + pageSeparator.length
    text += pageSeparator + pageText

    for (const positionedRegion of positioned) {
      const currentVisualIndex = visualIndex++
      const relativeCaptionRange = captionRanges.get(positionedRegion.region)
      const captionRange = relativeCaptionRange
        ? {
            start: pageStart + relativeCaptionRange.start,
            end: pageStart + relativeCaptionRange.end,
          }
        : undefined
      if (captionRange) atomicRanges.push(captionRange)
      const anchorOffset = anchorOffsets.get(positionedRegion.region)
      if (anchorOffset === undefined) throw new Error('Visual region has no anchor offset')
      regions.push({
        ...positionedRegion.region,
        visualIndex: currentVisualIndex,
        anchorOffset: pageStart + anchorOffset,
        ...(captionRange ? { captionRange } : {}),
      })
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
  if (chunks.length === 0) return attachmentsByChunkIndex
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
    if (!region)
      throw new Error(`Visual attachment has no ordered region: ${attachment.imageIndex}`)

    const owner = findNearestChunk(chunks, region.anchorOffset)
    if (!owner) throw new Error(`Visual ${attachment.imageIndex} has no owning chunk`)
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
        doc as Parameters<typeof renderer.renderPdfRendition>[0],
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

export async function prepareVisualPdfChunks(
  filePath: string,
  parser: VisualPdfParser,
  chunker: SemanticChunker,
  embedder: EmbedderInterface,
  options: PrepareVisualPdfChunksOptions
): Promise<PrepareVisualPdfChunksResult> {
  const captionerConfig = options.captioner
  const { doc, title, pages } = await parser.parsePdfPages(filePath, embedder)
  try {
    let processed: ProcessedVisualRegion[]
    let omittedImageCount = 0

    if (captionerConfig !== undefined) {
      const pdfVisual = await import('../pdf-visual/index.js')
      const regions = pdfVisual.detectVisualRegions(
        pages.map((page) => ({ pageNum: page.pageNum, stextJson: page.stextJson })),
        doc as Parameters<typeof pdfVisual.detectVisualRegions>[1]
      )
      const captioner = pdfVisual.createCaptioner(captionerConfig)
      try {
        processed = await pdfVisual.processVisualRegions(
          regions,
          doc as Parameters<typeof pdfVisual.processVisualRegions>[1],
          { captioner, includeImages: options.images }
        )
      } finally {
        await captioner.dispose()
      }
    } else {
      const detector = await import('../pdf-visual/detector.js')
      const regions = detector.detectVisualRegions(
        pages.map((page) => ({ pageNum: page.pageNum, stextJson: page.stextJson })),
        doc as Parameters<typeof detector.detectVisualRegions>[1]
      )
      const imageOnly = await processImageOnlyRegions(regions, doc)
      processed = imageOnly.processed
      omittedImageCount += imageOnly.omittedImageCount
    }

    const ordered = buildOrderedVisualDocument(pages, processed)
    const { chunks, embeddings } = await buildChunksAndEmbeddings(
      ordered.text,
      chunker,
      embedder,
      ordered.atomicRanges
    )
    const attachments: VisualAttachment[] = []
    if (options.images) {
      for (const orderedRegion of ordered.regions) {
        if (!orderedRegion.rendition) continue
        try {
          attachments.push(
            createVisualAttachment(orderedRegion.visualIndex, orderedRegion.rendition)
          )
        } catch {
          omittedImageCount += 1
        }
      }
    }
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
