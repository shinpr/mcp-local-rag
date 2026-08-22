import { basename } from 'node:path'

import type { AtomicTextRange, SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { DocumentParser } from '../parser/index.js'
import type { FilteredTextFragment, PdfColumnBand } from '../parser/pdf-filter.js'
import { extractPdfTitle } from '../parser/title-extractor.js'
import type {
  DetectedVisualRegion,
  ProcessedVisualRegion,
  QualityProfile,
  VisualAttachment,
} from '../pdf-visual/types.js'
import { buildChunksAndEmbeddings } from './compute.js'

export interface VisualPdfParser {
  parsePdfPages: DocumentParser['parsePdfPages']
  parsePdf?: DocumentParser['parsePdf']
}

export interface CaptionerConfig {
  profile: QualityProfile
  cacheDir: string
  device?: string | undefined
}

export interface PrepareVisualPdfChunksOptions extends CaptionerConfig {
  visual?: boolean
  images?: boolean
}

export interface PrepareVisualPdfChunksResult {
  chunks: TextChunk[]
  embeddings: number[][]
  title: string | null
  text: string
  atomicRanges: AtomicTextRange[]
  visualAttachments: Map<number, VisualAttachment[]>
}

export interface OrderedVisualPage {
  pageNum: number
  text: string
  textFragments: readonly FilteredTextFragment[]
}

export interface OrderedTextFragment extends FilteredTextFragment {
  documentStart: number
  documentEnd: number
  documentOrdinal: number
}

export interface OrderedVisualRegion extends ProcessedVisualRegion {
  visualIndex: number
  documentOrdinal: number
  captionRange?: AtomicTextRange
}

export interface OrderedVisualDocument {
  text: string
  atomicRanges: AtomicTextRange[]
  fragments: OrderedTextFragment[]
  regions: OrderedVisualRegion[]
}

interface PositionedRegion {
  region: ProcessedVisualRegion
  insertionIndex: number
}

function horizontalOverlap(left: readonly number[], right: readonly number[]): boolean {
  return Math.min(left[2] ?? 0, right[2] ?? 0) >= Math.max(left[0] ?? 0, right[0] ?? 0)
}

function axisOverlap(start1: number, end1: number, start2: number, end2: number): number {
  return Math.max(0, Math.min(end1, end2) - Math.max(start1, start2))
}

function xCenter(bbox: readonly number[]): number {
  return ((bbox[0] ?? 0) + (bbox[2] ?? 0)) / 2
}

function yCenter(bbox: readonly number[]): number {
  return ((bbox[1] ?? 0) + (bbox[3] ?? 0)) / 2
}

interface AvailableColumnBand extends PdfColumnBand {
  fragments: Array<{ fragment: FilteredTextFragment; index: number }>
}

function selectColumnBand(
  fragments: readonly FilteredTextFragment[],
  region: DetectedVisualRegion
): AvailableColumnBand | null {
  const bands = new Map<string, AvailableColumnBand>()
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index]
    const metadata = fragment?.columnBand
    if (!fragment || !metadata) continue
    const key = `${metadata.sectionIndex}:${metadata.bandIndex}`
    const existing = bands.get(key)
    if (existing) {
      existing.fragments.push({ fragment, index })
    } else {
      bands.set(key, { ...metadata, fragments: [{ fragment, index }] })
    }
  }
  if (bands.size === 0) return null

  const regionWidth = region.bbox[2] - region.bbox[0]
  const firstBand = bands.values().next().value as AvailableColumnBand | undefined
  if (firstBand && regionWidth > firstBand.pageWidth * 0.6) return null

  const sections = new Map<number, AvailableColumnBand[]>()
  for (const band of bands.values()) {
    const section = sections.get(band.sectionIndex) ?? []
    section.push(band)
    sections.set(band.sectionIndex, section)
  }
  const selectedSection = [...sections.entries()]
    .map(([sectionIndex, sectionBands]) => {
      const y0 = Math.min(...sectionBands.map((band) => band.bbox[1]))
      const y1 = Math.max(...sectionBands.map((band) => band.bbox[3]))
      return { sectionIndex, sectionBands, y0, y1 }
    })
    .sort(
      (left, right) =>
        axisOverlap(region.bbox[1], region.bbox[3], right.y0, right.y1) -
          axisOverlap(region.bbox[1], region.bbox[3], left.y0, left.y1) ||
        Math.abs(yCenter([0, left.y0, 0, left.y1]) - yCenter(region.bbox)) -
          Math.abs(yCenter([0, right.y0, 0, right.y1]) - yCenter(region.bbox)) ||
        left.sectionIndex - right.sectionIndex
    )[0]
  if (!selectedSection) return null

  return selectedSection.sectionBands.sort(
    (left, right) =>
      axisOverlap(region.bbox[0], region.bbox[2], right.bbox[0], right.bbox[2]) -
        axisOverlap(region.bbox[0], region.bbox[2], left.bbox[0], left.bbox[2]) ||
      Math.abs(xCenter(left.bbox) - xCenter(region.bbox)) -
        Math.abs(xCenter(right.bbox) - xCenter(region.bbox)) ||
      left.bbox[0] - right.bbox[0] ||
      left.bandIndex - right.bandIndex
  )[0] as AvailableColumnBand
}

function findInsertionIndex(
  fragments: readonly FilteredTextFragment[],
  region: DetectedVisualRegion
): number {
  if (fragments.length === 0) return 0
  const selectedBand = selectColumnBand(fragments, region)
  let candidates = selectedBand
    ? selectedBand.fragments
    : fragments
        .map((fragment, index) => ({ fragment, index }))
        .filter(({ fragment }) => horizontalOverlap(fragment.bbox, region.bbox))

  if (!selectedBand && candidates.length === 0) {
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
  let documentOrdinal = 0
  let visualIndex = 0
  const atomicRanges: AtomicTextRange[] = []
  const fragments: OrderedTextFragment[] = []
  const regions: OrderedVisualRegion[] = []
  const consumedRegions = new Set<ProcessedVisualRegion>()

  const appendText = (value: string): AtomicTextRange | null => {
    if (value.length === 0) return null
    if (text.length > 0) text += '\n\n'
    const start = text.length
    text += value
    return { start, end: text.length }
  }

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

    let positionedIndex = 0
    for (let fragmentIndex = 0; fragmentIndex <= pageFragments.length; fragmentIndex++) {
      while (positioned[positionedIndex]?.insertionIndex === fragmentIndex) {
        const positionedRegion = positioned[positionedIndex] as PositionedRegion
        const currentVisualIndex = visualIndex++
        const captionText = positionedRegion.region.caption
          ? `[Visual content on page ${page.pageNum}, visual ${currentVisualIndex}: ${positionedRegion.region.caption}]`
          : null
        const captionRange = captionText ? appendText(captionText) : null
        if (captionRange) atomicRanges.push(captionRange)
        regions.push({
          ...positionedRegion.region,
          visualIndex: currentVisualIndex,
          documentOrdinal,
          ...(captionRange ? { captionRange } : {}),
        })
        consumedRegions.add(positionedRegion.region)
        documentOrdinal++
        positionedIndex++
      }

      const fragment = pageFragments[fragmentIndex]
      if (!fragment) continue
      const range = appendText(fragment.text)
      if (range) {
        fragments.push({
          ...fragment,
          documentStart: range.start,
          documentEnd: range.end,
          documentOrdinal,
        })
      }
      documentOrdinal++
    }
  }

  if (consumedRegions.size !== processedRegions.length) {
    throw new Error('A processed visual region has no matching PDF page')
  }

  return { text, atomicRanges, fragments, regions }
}

type OwnershipTuple = [number, number, number, number, number]

function compareOwnershipTuple(left: OwnershipTuple, right: OwnershipTuple): number {
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function rectangleGapSquared(fragment: OrderedTextFragment, region: OrderedVisualRegion): number {
  const [fragmentX0, fragmentY0, fragmentX1, fragmentY1] = fragment.bbox
  const [regionX0, regionY0, regionX1, regionY1] = region.bbox
  const dx = Math.max(0, fragmentX0 - regionX1, regionX0 - fragmentX1)
  const dy = Math.max(0, fragmentY0 - regionY1, regionY0 - fragmentY1)
  return dx * dx + dy * dy
}

function overlapsChunk(fragment: OrderedTextFragment, chunk: TextChunk): boolean {
  return fragment.documentStart < chunk.sourceEnd && fragment.documentEnd > chunk.sourceStart
}

export function assignVisualAttachments(
  document: OrderedVisualDocument,
  chunks: readonly TextChunk[],
  attachments: readonly VisualAttachment[]
): Map<number, VisualAttachment[]> {
  const attachmentsByChunkIndex = new Map<number, VisualAttachment[]>()
  const regionByVisualIndex = new Map(
    document.regions.map((region) => [region.visualIndex, region] as const)
  )
  const seenVisualIndices = new Set<number>()

  for (const attachment of [...attachments].sort(
    (left, right) => left.visualIndex - right.visualIndex
  )) {
    if (seenVisualIndices.has(attachment.visualIndex)) {
      throw new Error(`Duplicate visual attachment index: ${attachment.visualIndex}`)
    }
    seenVisualIndices.add(attachment.visualIndex)
    const region = regionByVisualIndex.get(attachment.visualIndex)
    if (!region)
      throw new Error(`Visual attachment has no ordered region: ${attachment.visualIndex}`)

    let owner: TextChunk | undefined
    if (region.captionRange) {
      const owners = chunks.filter(
        (chunk) =>
          chunk.sourceStart <= (region.captionRange?.start ?? -1) &&
          chunk.sourceEnd >= (region.captionRange?.end ?? Number.POSITIVE_INFINITY)
      )
      if (owners.length !== 1) {
        throw new Error(`Caption range for visual ${attachment.visualIndex} has no unique chunk`)
      }
      owner = owners[0]
    } else {
      let bestTuple: OwnershipTuple | undefined
      for (const chunk of chunks) {
        for (const fragment of document.fragments) {
          if (!overlapsChunk(fragment, chunk)) continue
          const pageDistance = Math.abs(fragment.pageNum - region.pageNum)
          const ordinalDistance = Math.abs(fragment.documentOrdinal - region.documentOrdinal)
          const tuple: OwnershipTuple = [
            pageDistance,
            pageDistance === 0 ? rectangleGapSquared(fragment, region) : ordinalDistance,
            ordinalDistance,
            fragment.documentOrdinal < region.documentOrdinal ? 0 : 1,
            chunk.index,
          ]
          if (!bestTuple || compareOwnershipTuple(tuple, bestTuple) < 0) {
            bestTuple = tuple
            owner = chunk
          }
        }
      }
    }

    if (!owner) continue
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
  createAttachment: typeof import('../pdf-visual/renderer.js').createVisualAttachment
}> {
  const renderer = await import('../pdf-visual/renderer.js')
  const processed: ProcessedVisualRegion[] = []
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
      console.warn(
        `PDF rendition failed for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without image`
      )
      processed.push({ ...region, caption: null })
    }
  }
  return { processed, createAttachment: renderer.createVisualAttachment }
}

export async function prepareVisualPdfChunks(
  filePath: string,
  parser: VisualPdfParser,
  chunker: SemanticChunker,
  embedder: EmbedderInterface,
  options: PrepareVisualPdfChunksOptions
): Promise<PrepareVisualPdfChunksResult> {
  const visual = options.visual ?? true
  const images = options.images ?? false

  if (!visual && !images) {
    if (!parser.parsePdf) throw new Error('Text-only PDF preparation requires parsePdf')
    const parsed = await parser.parsePdf(filePath, embedder)
    const { chunks, embeddings } = await buildChunksAndEmbeddings(
      parsed.content,
      chunker,
      embedder,
      parsed.atomicRanges
    )
    return {
      chunks,
      embeddings,
      title: parsed.title || null,
      text: parsed.content,
      atomicRanges: [...(parsed.atomicRanges ?? [])],
      visualAttachments: new Map(),
    }
  }

  const { doc, metadataTitle, pages } = await parser.parsePdfPages(filePath, embedder)
  try {
    let processed: ProcessedVisualRegion[]
    let createAttachment: (
      region: DetectedVisualRegion,
      visualIndex: number,
      rendition: NonNullable<ProcessedVisualRegion['rendition']>
    ) => VisualAttachment

    if (visual) {
      const pdfVisual = await import('../pdf-visual/index.js')
      const regions = pdfVisual.detectVisualRegions(
        pages.map((page) => ({ pageNum: page.pageNum, stextJson: page.stextJson })),
        doc as Parameters<typeof pdfVisual.detectVisualRegions>[1]
      )
      const captioner = pdfVisual.createCaptioner(options)
      processed = await pdfVisual.processVisualRegions(
        regions,
        doc as Parameters<typeof pdfVisual.processVisualRegions>[1],
        { captioner, includeImages: images }
      )
      createAttachment = pdfVisual.createVisualAttachment
    } else {
      const detector = await import('../pdf-visual/detector.js')
      const regions = detector.detectVisualRegions(
        pages.map((page) => ({ pageNum: page.pageNum, stextJson: page.stextJson })),
        doc as Parameters<typeof detector.detectVisualRegions>[1]
      )
      const imageOnly = await processImageOnlyRegions(regions, doc)
      processed = imageOnly.processed
      createAttachment = imageOnly.createAttachment
    }

    const ordered = buildOrderedVisualDocument(pages, processed)
    const { chunks, embeddings } = await buildChunksAndEmbeddings(
      ordered.text,
      chunker,
      embedder,
      ordered.atomicRanges
    )
    const attachments: VisualAttachment[] = []
    if (images) {
      for (const orderedRegion of ordered.regions) {
        if (!orderedRegion.rendition) continue
        try {
          attachments.push(
            createAttachment(orderedRegion, orderedRegion.visualIndex, orderedRegion.rendition)
          )
        } catch {
          console.warn(
            `PDF rendition validation failed for page ${orderedRegion.pageNum}, visual ${orderedRegion.visualIndex}; proceeding without image`
          )
        }
      }
    }
    const visualAttachments = assignVisualAttachments(ordered, chunks, attachments)
    const titleResult = extractPdfTitle(
      metadataTitle,
      chunks[0]?.text,
      basename(filePath),
      pages[0]?.page1FontHint
    )

    return {
      chunks,
      embeddings,
      title: titleResult.title || null,
      text: ordered.text,
      atomicRanges: ordered.atomicRanges,
      visualAttachments,
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
