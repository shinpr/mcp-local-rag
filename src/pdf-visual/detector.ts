import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

import type { DetectedVisualRegion, VisualBBox, VisualEvidence } from './types.js'

const MIN_IMAGE_BLOCK_WIDTH = 80
const MIN_IMAGE_BLOCK_HEIGHT = 80
const MIN_IMAGE_BLOCK_AREA_RATIO = 0.01
const IMAGE_MAX_AREA_RATIO_THRESHOLD = 0.1
const IMAGE_TOTAL_AREA_RATIO_THRESHOLD = 0.15
const MAX_CORNER_LOGO_AREA_RATIO = 0.03
const CORNER_LOGO_EDGE_BAND_RATIO = 0.15
const MAX_BACKGROUND_AREA_RATIO = 0.85
const MIN_VECTOR_DIMENSION = 20
const MIN_VECTOR_AREA_RATIO = 0.0005
const MIN_FILL_AREA_RATIO = 0.01
const VECTOR_SEGMENT_THRESHOLD = 5
const MIN_SEGMENT_SPAN = 20
const MIN_ALPHA = 0.1
const CROP_PADDING_RATIO = 0.08
const MIN_CROP_PADDING = 12

interface DetectorPage {
  pageNum: number
  stextJson: unknown
}

type EvidenceKind = 'raster' | 'stroke' | 'fill' | 'shade'
type Point = [number, number]

interface LineSegment {
  start: Point
  end: Point
}

interface RegionEvidence {
  kind: EvidenceKind
  rect: VisualBBox
  order: number
  segment?: LineSegment
}

interface PendingRegion {
  pageNum: number
  bbox: VisualBBox
  normalizedBbox: VisualBBox
  evidence: VisualEvidence
  evidenceOrder: number
}

function areaOf(rect: VisualBBox): number {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])
}

function dimensionsQualify(rect: VisualBBox, pageArea: number, minAreaRatio: number): boolean {
  return (
    rect[2] - rect[0] >= MIN_VECTOR_DIMENSION &&
    rect[3] - rect[1] >= MIN_VECTOR_DIMENSION &&
    areaOf(rect) / pageArea >= minAreaRatio
  )
}

function normalizeRect(rect: readonly number[], pageBounds: VisualBBox): VisualBBox | null {
  if (rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) return null
  const x0 = Math.min(rect[0] as number, rect[2] as number)
  const y0 = Math.min(rect[1] as number, rect[3] as number)
  const x1 = Math.max(rect[0] as number, rect[2] as number)
  const y1 = Math.max(rect[1] as number, rect[3] as number)
  const clamped: VisualBBox = [
    Math.max(pageBounds[0], Math.min(pageBounds[2], x0)),
    Math.max(pageBounds[1], Math.min(pageBounds[3], y0)),
    Math.max(pageBounds[0], Math.min(pageBounds[2], x1)),
    Math.max(pageBounds[1], Math.min(pageBounds[3], y1)),
  ]
  if (clamped[2] < clamped[0] || clamped[3] < clamped[1]) return null
  return clamped
}

function unionRects(rects: VisualBBox[]): VisualBBox | null {
  if (rects.length === 0) return null
  const first = rects[0] as VisualBBox
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
  return normalizeRect(
    [rect[0] - xPad, rect[1] - yPad, rect[2] + xPad, rect[3] + yPad],
    pageBounds
  ) as VisualBBox
}

function transformPoint([x, y]: Point, [a, b, c, d, e, f]: mupdf.Matrix): Point {
  return [a * x + c * y + e, b * x + d * y + f]
}

function rectFromPoints(points: Point[]): VisualBBox | null {
  if (points.length === 0) return null
  return [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
  ]
}

function blockRect(block: unknown): VisualBBox | null {
  if (typeof block !== 'object' || block === null) return null
  const value = (block as { bbox?: unknown }).bbox
  if (typeof value !== 'object' || value === null) return null
  const { x, y, w, h } = value as Record<'x' | 'y' | 'w' | 'h', unknown>
  if (![x, y, w, h].every((item) => typeof item === 'number' && Number.isFinite(item))) {
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

function collectRasterEvidence(
  stextJson: unknown,
  pageBounds: VisualBBox,
  nextOrder: () => number
): RegionEvidence[] {
  const pageArea = areaOf(pageBounds)
  const evidence: RegionEvidence[] = []
  for (const block of getBlocks(stextJson)) {
    if (
      typeof block !== 'object' ||
      block === null ||
      (block as { type?: unknown }).type !== 'image'
    ) {
      continue
    }
    const rawRect = blockRect(block)
    const rect = rawRect ? normalizeRect(rawRect, pageBounds) : null
    if (!rect) continue
    const width = rect[2] - rect[0]
    const height = rect[3] - rect[1]
    const ratio = areaOf(rect) / pageArea
    if (
      width < MIN_IMAGE_BLOCK_WIDTH ||
      height < MIN_IMAGE_BLOCK_HEIGHT ||
      ratio < MIN_IMAGE_BLOCK_AREA_RATIO ||
      ratio > MAX_BACKGROUND_AREA_RATIO ||
      isLikelyCornerLogo(rect, pageBounds, ratio)
    ) {
      continue
    }
    evidence.push({ kind: 'raster', rect, order: nextOrder() })
  }
  return evidence
}

function collectPathEvidence(
  path: mupdf.Path,
  strokeState: mupdf.StrokeState | null,
  ctm: mupdf.Matrix,
  kind: 'stroke' | 'fill',
  pageBounds: VisualBBox,
  pageArea: number,
  nextOrder: () => number
): RegionEvidence[] {
  const evidence: RegionEvidence[] = []
  let start: Point | null = null
  let current: Point | null = null
  let points: Point[] = []

  const emitSegment = (from: Point, to: Point) => {
    if (kind !== 'stroke') return
    const rect = normalizeRect(
      [
        Math.min(from[0], to[0]),
        Math.min(from[1], to[1]),
        Math.max(from[0], to[0]),
        Math.max(from[1], to[1]),
      ],
      pageBounds
    )
    if (!rect) return
    const span = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]))
    if (span < MIN_SEGMENT_SPAN) return
    evidence.push({ kind, rect, order: nextOrder(), segment: { start: from, end: to } })
  }

  const finishSubpath = () => {
    const rawRect = rectFromPoints(points)
    const rect = rawRect ? normalizeRect(rawRect, pageBounds) : null
    if (
      rect &&
      (areaOf(rect) > 0 || Math.max(rect[2] - rect[0], rect[3] - rect[1]) >= MIN_SEGMENT_SPAN)
    ) {
      if (kind !== 'fill' || areaOf(rect) / pageArea < MAX_BACKGROUND_AREA_RATIO) {
        evidence.push({ kind, rect, order: nextOrder() })
      }
    }
    start = null
    current = null
    points = []
  }

  let walkFailed = false
  try {
    path.walk({
      moveTo(x, y) {
        if (points.length > 0) finishSubpath()
        const point = transformPoint([x, y], ctm)
        start = point
        current = point
        points = [point]
      },
      lineTo(x, y) {
        const point = transformPoint([x, y], ctm)
        if (current) emitSegment(current, point)
        if (!start) start = point
        current = point
        points.push(point)
      },
      curveTo(x1, y1, x2, y2, x3, y3) {
        const transformed = [
          transformPoint([x1, y1], ctm),
          transformPoint([x2, y2], ctm),
          transformPoint([x3, y3], ctm),
        ]
        if (!start) start = transformed[0] as Point
        current = transformed[2] as Point
        points.push(...transformed)
      },
      closePath() {
        if (current && start) emitSegment(current, start)
        finishSubpath()
      },
    })
  } catch {
    walkFailed = true
  }

  if (!walkFailed && points.length > 0) finishSubpath()
  if (evidence.length > 0) return evidence

  try {
    const getBounds = path.getBounds as unknown as (
      stroke: mupdf.StrokeState | null,
      matrix: mupdf.Matrix
    ) => mupdf.Rect
    const fallback = normalizeRect(getBounds(strokeState, ctm), pageBounds)
    if (!fallback) return []
    const ratio = areaOf(fallback) / pageArea
    const qualifies =
      kind === 'fill'
        ? dimensionsQualify(fallback, pageArea, MIN_FILL_AREA_RATIO) &&
          ratio < MAX_BACKGROUND_AREA_RATIO
        : dimensionsQualify(fallback, pageArea, MIN_VECTOR_AREA_RATIO) &&
          ratio < MAX_BACKGROUND_AREA_RATIO
    return qualifies ? [{ kind, rect: fallback, order: nextOrder() }] : []
  } catch {
    return []
  }
}

function collectVectorEvidence(
  page: mupdf.Page,
  pageNum: number,
  pageBounds: VisualBBox,
  nextOrder: () => number
): RegionEvidence[] {
  const pageArea = areaOf(pageBounds)
  const evidence: RegionEvidence[] = []
  const device = new mupdf.Device({
    strokePath(path, strokeState, ctm, _colorSpace, _color, alpha) {
      if (!Number.isFinite(alpha) || alpha < MIN_ALPHA) return
      evidence.push(
        ...collectPathEvidence(path, strokeState, ctm, 'stroke', pageBounds, pageArea, nextOrder)
      )
    },
    fillPath(path, _evenOdd, ctm, _colorSpace, _color, alpha) {
      if (!Number.isFinite(alpha) || alpha < MIN_ALPHA) return
      evidence.push(
        ...collectPathEvidence(path, null, ctm, 'fill', pageBounds, pageArea, nextOrder)
      )
    },
    fillShade(shade, ctm, alpha) {
      if (!Number.isFinite(alpha) || alpha < MIN_ALPHA) return
      try {
        const rect = normalizeRect(mupdf.Rect.transform(shade.getBounds(), ctm), pageBounds)
        if (!rect) return
        const ratio = areaOf(rect) / pageArea
        if (ratio >= MAX_BACKGROUND_AREA_RATIO) return
        evidence.push({ kind: 'shade', rect, order: nextOrder() })
      } catch {
        console.warn(`detector: shade bounds failed on page ${pageNum}`)
      }
    },
  })

  try {
    page.run(device, mupdf.Matrix.identity)
  } catch {
    console.warn(`detector: vector scan failed on page ${pageNum}`)
  } finally {
    device.close()
  }
  return evidence
}

function expanded(rect: VisualBBox, pageBounds: VisualBBox): VisualBBox {
  const xGap = Math.max(6, (pageBounds[2] - pageBounds[0]) * 0.01)
  const yGap = Math.max(6, (pageBounds[3] - pageBounds[1]) * 0.01)
  return [rect[0] - xGap, rect[1] - yGap, rect[2] + xGap, rect[3] + yGap]
}

function intersects(a: VisualBBox, b: VisualBBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

function connectedComponents(
  evidence: RegionEvidence[],
  pageBounds: VisualBBox
): RegionEvidence[][] {
  const parents = evidence.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parents[root] !== root) root = parents[root] as number
    while (parents[index] !== index) {
      const next = parents[index] as number
      parents[index] = root
      index = next
    }
    return root
  }
  const join = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
  }

  const expandedRects = evidence.map((item) => expanded(item.rect, pageBounds))
  for (let left = 0; left < evidence.length; left += 1) {
    for (let right = left + 1; right < evidence.length; right += 1) {
      if (intersects(expandedRects[left] as VisualBBox, expandedRects[right] as VisualBBox)) {
        join(left, right)
      }
    }
  }

  const groups = new Map<number, RegionEvidence[]>()
  for (let index = 0; index < evidence.length; index += 1) {
    const root = find(index)
    const group = groups.get(root) ?? []
    group.push(evidence[index] as RegionEvidence)
    groups.set(root, group)
  }
  return [...groups.values()]
}

function rasterQualifies(items: RegionEvidence[], pageArea: number): boolean {
  const rasters = items.filter((item) => item.kind === 'raster')
  const ratios = rasters.map((item) => areaOf(item.rect) / pageArea)
  return (
    Math.max(0, ...ratios) >= IMAGE_MAX_AREA_RATIO_THRESHOLD ||
    ratios.reduce((sum, ratio) => sum + ratio, 0) >= IMAGE_TOTAL_AREA_RATIO_THRESHOLD
  )
}

function isHorizontal(segment: LineSegment): boolean {
  const dx = Math.abs(segment.end[0] - segment.start[0])
  const dy = Math.abs(segment.end[1] - segment.start[1])
  return dx >= MIN_SEGMENT_SPAN && dy <= Math.max(2, dx * 0.1)
}

function isVertical(segment: LineSegment): boolean {
  const dx = Math.abs(segment.end[0] - segment.start[0])
  const dy = Math.abs(segment.end[1] - segment.start[1])
  return dy >= MIN_SEGMENT_SPAN && dx <= Math.max(2, dy * 0.1)
}

function segmentsCross(horizontal: LineSegment, vertical: LineSegment): boolean {
  const hx0 = Math.min(horizontal.start[0], horizontal.end[0])
  const hx1 = Math.max(horizontal.start[0], horizontal.end[0])
  const hy = (horizontal.start[1] + horizontal.end[1]) / 2
  const vx = (vertical.start[0] + vertical.end[0]) / 2
  const vy0 = Math.min(vertical.start[1], vertical.end[1])
  const vy1 = Math.max(vertical.start[1], vertical.end[1])
  return vx >= hx0 - 2 && vx <= hx1 + 2 && hy >= vy0 - 2 && hy <= vy1 + 2
}

function tableLike(segments: LineSegment[]): boolean {
  const horizontal = segments.filter(isHorizontal)
  const vertical = segments.filter(isVertical)
  if (horizontal.length < 2 || vertical.length < 2) return false
  return (
    horizontal.filter((line) => vertical.some((column) => segmentsCross(line, column))).length >=
      2 &&
    vertical.filter((column) => horizontal.some((line) => segmentsCross(line, column))).length >= 2
  )
}

function strokeQualifies(items: RegionEvidence[], pageArea: number): boolean {
  const strokes = items.filter((item) => item.kind === 'stroke')
  const union = unionRects(strokes.map((item) => item.rect))
  if (!union || !dimensionsQualify(union, pageArea, MIN_VECTOR_AREA_RATIO)) return false
  const segments = strokes.flatMap((item) => (item.segment ? [item.segment] : []))
  return segments.length >= VECTOR_SEGMENT_THRESHOLD || tableLike(segments)
}

function fillQualifies(items: RegionEvidence[], pageArea: number): boolean {
  const fills = items.filter((item) => item.kind === 'fill' || item.kind === 'shade')
  if (fills.some((item) => dimensionsQualify(item.rect, pageArea, MIN_FILL_AREA_RATIO))) {
    return true
  }
  const union = unionRects(fills.map((item) => item.rect))
  return (
    fills.length >= 3 && union !== null && dimensionsQualify(union, pageArea, MIN_VECTOR_AREA_RATIO)
  )
}

function evidenceType(items: RegionEvidence[]): VisualEvidence {
  const hasRaster = items.some((item) => item.kind === 'raster')
  const hasVector = items.some((item) => item.kind !== 'raster')
  if (hasRaster && hasVector) return 'mixed'
  return hasRaster ? 'raster' : 'vector'
}

function normalizeBbox(rect: VisualBBox, pageBounds: VisualBBox): VisualBBox {
  const width = pageBounds[2] - pageBounds[0]
  const height = pageBounds[3] - pageBounds[1]
  const rounded = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000
  return [
    rounded((rect[0] - pageBounds[0]) / width),
    rounded((rect[1] - pageBounds[1]) / height),
    rounded((rect[2] - pageBounds[0]) / width),
    rounded((rect[3] - pageBounds[1]) / height),
  ]
}

function detectPageRegions(
  pageRecord: DetectorPage,
  page: mupdf.Page,
  pageBounds: VisualBBox
): PendingRegion[] {
  const pageArea = areaOf(pageBounds)
  if (pageArea <= 0) return []
  let evidenceOrder = 0
  const nextOrder = () => evidenceOrder++
  const evidence = [
    ...collectRasterEvidence(pageRecord.stextJson, pageBounds, nextOrder),
    ...collectVectorEvidence(page, pageRecord.pageNum, pageBounds, nextOrder),
  ]

  const regions: PendingRegion[] = []
  for (const component of connectedComponents(evidence, pageBounds)) {
    const componentRect = unionRects(component.map((item) => item.rect))
    if (!componentRect) continue
    const rasterAccepted = rasterQualifies(component, pageArea)
    const strokeAccepted = strokeQualifies(component, pageArea)
    const coverage = areaOf(componentRect) / pageArea
    if (coverage >= MAX_BACKGROUND_AREA_RATIO && !rasterAccepted && !strokeAccepted) continue
    if (!rasterAccepted && !strokeAccepted && !fillQualifies(component, pageArea)) continue

    const bbox = padRect(componentRect, pageBounds)
    regions.push({
      pageNum: pageRecord.pageNum,
      bbox,
      normalizedBbox: normalizeBbox(bbox, pageBounds),
      evidence: evidenceType(component),
      evidenceOrder: Math.min(...component.map((item) => item.order)),
    })
  }
  return regions
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
      const rawBounds = page.getBounds() as VisualBBox
      const bounds = normalizeRect(rawBounds, rawBounds)
      if (!bounds || areaOf(bounds) <= 0) continue
      pending.push(...detectPageRegions(pageRecord, page, bounds))
    } catch {
      console.warn(`detector: page scan failed on page ${pageRecord.pageNum}`)
    } finally {
      page?.destroy?.()
    }
  }

  pending.sort(
    (left, right) =>
      left.pageNum - right.pageNum ||
      left.bbox[1] - right.bbox[1] ||
      left.bbox[0] - right.bbox[0] ||
      left.bbox[3] - right.bbox[3] ||
      left.bbox[2] - right.bbox[2] ||
      left.evidenceOrder - right.evidenceOrder
  )

  let pageNum = -1
  let detectionIndex = -1
  return pending.map((region) => {
    if (region.pageNum !== pageNum) {
      pageNum = region.pageNum
      detectionIndex = 0
    } else {
      detectionIndex += 1
    }
    return {
      pageNum: region.pageNum,
      detectionIndex,
      bbox: region.bbox,
      normalizedBbox: region.normalizedBbox,
      evidence: region.evidence,
    }
  })
}

export function detectVisualCandidates(pages: DetectorPage[], doc: MupdfDocument) {
  return detectVisualRegions(pages, doc).map((region) => ({
    ...region,
    isCandidate: true as const,
    cropRect: region.bbox,
  }))
}
