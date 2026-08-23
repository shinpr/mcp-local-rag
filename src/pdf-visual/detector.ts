import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

import type { DetectedVisualRegion, VisualBBox, VisualEvidence } from './types.js'

const MIN_IMAGE_BLOCK_WIDTH = 80
const MIN_IMAGE_BLOCK_HEIGHT = 80
const MIN_IMAGE_BLOCK_AREA_RATIO = 0.01
const MAX_EFFECTIVE_AREA_RATIO = 0.85
const IMAGE_MAX_AREA_RATIO_THRESHOLD = 0.1
const IMAGE_TOTAL_AREA_RATIO_THRESHOLD = 0.15
const MAX_CORNER_LOGO_AREA_RATIO = 0.03
const CORNER_LOGO_EDGE_BAND_RATIO = 0.15
const MIN_VECTOR_WIDTH = 20
const MIN_VECTOR_HEIGHT = 20
const MIN_VECTOR_AREA_RATIO = 0.0005
const VECTOR_STROKE_COUNT_THRESHOLD = 5
const CROP_PADDING_RATIO = 0.08
const MIN_CROP_PADDING = 12
const GROUP_GAP = 6
const GROUP_GAP_PAGE_RATIO = 0.01

interface DetectorPage {
  pageNum: number
  stextJson: unknown
}

interface PendingRegion {
  pageNum: number
  bbox: VisualBBox
  evidence: VisualEvidence
}

function areaOf(rect: VisualBBox): number {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])
}

function clampRect(rect: VisualBBox, bounds: VisualBBox): VisualBBox {
  return [
    Math.max(bounds[0], Math.min(bounds[2], rect[0])),
    Math.max(bounds[1], Math.min(bounds[3], rect[1])),
    Math.max(bounds[0], Math.min(bounds[2], rect[2])),
    Math.max(bounds[1], Math.min(bounds[3], rect[3])),
  ]
}

function unionRects(rects: readonly VisualBBox[]): VisualBBox | null {
  const first = rects[0]
  if (!first) return null
  let [x0, y0, x1, y1] = first
  for (const rect of rects.slice(1)) {
    x0 = Math.min(x0, rect[0])
    y0 = Math.min(y0, rect[1])
    x1 = Math.max(x1, rect[2])
    y1 = Math.max(y1, rect[3])
  }
  return [x0, y0, x1, y1]
}

function padRect(rect: VisualBBox, pageBounds: VisualBBox): VisualBBox {
  const xPad = Math.max(MIN_CROP_PADDING, (rect[2] - rect[0]) * CROP_PADDING_RATIO)
  const yPad = Math.max(MIN_CROP_PADDING, (rect[3] - rect[1]) * CROP_PADDING_RATIO)
  return clampRect([rect[0] - xPad, rect[1] - yPad, rect[2] + xPad, rect[3] + yPad], pageBounds)
}

function blockRect(block: unknown): VisualBBox | null {
  if (typeof block !== 'object' || block === null) return null
  const bbox = (block as { bbox?: unknown }).bbox
  if (typeof bbox !== 'object' || bbox === null) return null
  const { x, y, w, h } = bbox as Record<'x' | 'y' | 'w' | 'h', unknown>
  if (![x, y, w, h].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null
  }
  return [x as number, y as number, (x as number) + (w as number), (y as number) + (h as number)]
}

function getBlocks(stextJson: unknown): unknown[] {
  if (typeof stextJson !== 'object' || stextJson === null) return []
  const blocks = (stextJson as { blocks?: unknown }).blocks
  return Array.isArray(blocks) ? blocks : []
}

function isLikelyCornerLogo(rect: VisualBBox, pageBounds: VisualBBox, areaRatio: number): boolean {
  if (areaRatio > MAX_CORNER_LOGO_AREA_RATIO) return false
  const pageWidth = pageBounds[2] - pageBounds[0]
  const pageHeight = pageBounds[3] - pageBounds[1]
  const xBand = pageWidth * CORNER_LOGO_EDGE_BAND_RATIO
  const yBand = pageHeight * CORNER_LOGO_EDGE_BAND_RATIO
  const nearHorizontalEdge = rect[0] <= pageBounds[0] + xBand || rect[2] >= pageBounds[2] - xBand
  const nearVerticalEdge = rect[1] <= pageBounds[1] + yBand || rect[3] >= pageBounds[3] - yBand
  return nearHorizontalEdge && nearVerticalEdge
}

function collectRasterRects(stextJson: unknown, pageBounds: VisualBBox): VisualBBox[] {
  const pageArea = areaOf(pageBounds)
  if (pageArea <= 0) return []
  const rects: VisualBBox[] = []
  for (const block of getBlocks(stextJson)) {
    if (typeof block !== 'object' || block === null) continue
    if ((block as { type?: unknown }).type !== 'image') continue
    const rawRect = blockRect(block)
    if (!rawRect) continue
    const rect = clampRect(rawRect, pageBounds)
    const width = rect[2] - rect[0]
    const height = rect[3] - rect[1]
    const ratio = areaOf(rect) / pageArea
    if (
      width >= MIN_IMAGE_BLOCK_WIDTH &&
      height >= MIN_IMAGE_BLOCK_HEIGHT &&
      ratio >= MIN_IMAGE_BLOCK_AREA_RATIO &&
      ratio <= MAX_EFFECTIVE_AREA_RATIO &&
      !isLikelyCornerLogo(rect, pageBounds, ratio)
    ) {
      rects.push(rect)
    }
  }
  return rects
}

function rasterQualifies(rects: readonly VisualBBox[], pageBounds: VisualBBox): boolean {
  const pageArea = areaOf(pageBounds)
  const ratios = rects.map((rect) => areaOf(rect) / pageArea)
  return (
    Math.max(0, ...ratios) >= IMAGE_MAX_AREA_RATIO_THRESHOLD ||
    ratios.reduce((sum, ratio) => sum + ratio, 0) >= IMAGE_TOTAL_AREA_RATIO_THRESHOLD
  )
}

function collectVectorStrokeRects(
  page: mupdf.Page,
  pageNum: number,
  pageBounds: VisualBBox
): VisualBBox[] {
  const pageArea = areaOf(pageBounds)
  const rects: VisualBBox[] = []
  const device = new mupdf.Device({
    strokePath(path: mupdf.Path, stroke: mupdf.StrokeState, ctm: mupdf.Matrix) {
      try {
        const raw = path.getBounds(stroke, ctm)
        if (!raw.every(Number.isFinite)) return
        const rect = clampRect([raw[0], raw[1], raw[2], raw[3]], pageBounds)
        const width = rect[2] - rect[0]
        const height = rect[3] - rect[1]
        const ratio = areaOf(rect) / pageArea
        if (
          width >= MIN_VECTOR_WIDTH &&
          height >= MIN_VECTOR_HEIGHT &&
          ratio >= MIN_VECTOR_AREA_RATIO &&
          ratio <= MAX_EFFECTIVE_AREA_RATIO
        ) {
          rects.push(rect)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`detector: stroke bounds failed on page ${pageNum}: ${message}`)
      }
    },
  })
  try {
    page.run(device, mupdf.Matrix.identity)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`detector: vector scan failed on page ${pageNum}: ${message}`)
    return []
  } finally {
    device.close()
  }
  return rects
}

function axisGap(a0: number, a1: number, b0: number, b1: number): number {
  if (a1 < b0) return b0 - a1
  if (b1 < a0) return a0 - b1
  return 0
}

function groupRects(rects: readonly VisualBBox[], pageBounds: VisualBBox): VisualBBox[][] {
  const gap = Math.max(
    GROUP_GAP,
    Math.min(pageBounds[2] - pageBounds[0], pageBounds[3] - pageBounds[1]) * GROUP_GAP_PAGE_RATIO
  )
  const remaining = new Set(rects.map((_, index) => index))
  const groups: VisualBBox[][] = []
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as number
    remaining.delete(seed)
    const indices = [seed]
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const current = rects[indices[cursor] as number] as VisualBBox
      for (const candidateIndex of remaining) {
        const candidate = rects[candidateIndex] as VisualBBox
        if (
          axisGap(current[0], current[2], candidate[0], candidate[2]) <= gap &&
          axisGap(current[1], current[3], candidate[1], candidate[3]) <= gap
        ) {
          remaining.delete(candidateIndex)
          indices.push(candidateIndex)
        }
      }
    }
    groups.push(indices.map((index) => rects[index] as VisualBBox))
  }
  return groups
}

function pageRegions(
  pageRecord: DetectorPage,
  page: mupdf.Page,
  pageBounds: VisualBBox
): PendingRegion[] {
  const rasterRects = collectRasterRects(pageRecord.stextJson, pageBounds)
  let groups: VisualBBox[][]
  let evidence: VisualEvidence
  if (rasterQualifies(rasterRects, pageBounds)) {
    groups = groupRects(rasterRects, pageBounds)
    evidence = 'raster'
  } else {
    const vectorRects = collectVectorStrokeRects(page, pageRecord.pageNum, pageBounds)
    if (vectorRects.length < VECTOR_STROKE_COUNT_THRESHOLD) return []
    groups = groupRects(vectorRects, pageBounds)
    evidence = 'vector'
  }

  return groups.flatMap((group) => {
    const union = unionRects(group)
    if (!union) return []
    const bbox = padRect(union, pageBounds)
    return [
      {
        pageNum: pageRecord.pageNum,
        bbox,
        evidence,
      },
    ]
  })
}

export function detectVisualRegions(
  pages: DetectorPage[],
  doc: MupdfDocument
): DetectedVisualRegion[] {
  const pending: PendingRegion[] = []
  for (const pageRecord of pages) {
    let page: mupdf.Page | null = null
    try {
      page = doc.loadPage(pageRecord.pageNum - 1)
      const raw = page.getBounds()
      const bounds: VisualBBox = [raw[0], raw[1], raw[2], raw[3]]
      if (areaOf(bounds) > 0) pending.push(...pageRegions(pageRecord, page, bounds))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`detector: page scan failed on page ${pageRecord.pageNum}: ${message}`)
    } finally {
      page?.destroy?.()
    }
  }
  pending.sort(
    (left, right) =>
      left.pageNum - right.pageNum || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]
  )
  const nextIndex = new Map<number, number>()
  return pending.map((region) => {
    const detectionIndex = nextIndex.get(region.pageNum) ?? 0
    nextIndex.set(region.pageNum, detectionIndex + 1)
    return { ...region, detectionIndex }
  })
}
