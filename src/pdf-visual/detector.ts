// Visual candidate detector for the visual ingest path.
//
// Pure function over the per-page records returned by `parsePdfPages` plus the
// still-open mupdf document. For each page, decides whether the downstream
// renderer + captioner should run on it.
//
// Rule: a page is a candidate when it has meaningful image area OR enough
// vector stroke paths to indicate a diagram/chart:
//   - largest effective image block >= 10% of the page, OR
//   - total effective image area >= 15% of the page, OR
//   - effective vector stroke path count >= 5.
//
// The image rule avoids firing on tiny logos/decorative assets while keeping
// smaller but important figures such as the Transformer architecture diagram.
// The vector rule covers PDF-native charts and diagrams that do not appear as
// `block.type === 'image'` in structured text.
//
// Vector branch cost: `page.run(...)` replays the entire content stream, which
// is significantly slower than reading stext JSON. Pages that already have an
// image candidate skip the vector scan because the per-page decision is the
// same either way and adding stroke rects only ever shrinks crop quality (a
// chart's strokes are typically already covered by surrounding image rects).
//
import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

const MIN_IMAGE_BLOCK_WIDTH = 80
const MIN_IMAGE_BLOCK_HEIGHT = 80
const MIN_IMAGE_BLOCK_AREA_RATIO = 0.01
const MAX_EFFECTIVE_AREA_RATIO = 0.85
const IMAGE_MAX_AREA_RATIO_THRESHOLD = 0.1
const IMAGE_TOTAL_AREA_RATIO_THRESHOLD = 0.15
const MAX_CORNER_LOGO_AREA_RATIO = 0.03
const CORNER_LOGO_EDGE_BAND_RATIO = 0.15
const CROP_PADDING_RATIO = 0.08
const MIN_CROP_PADDING = 12
/**
 * Crop rect threshold relative to page area. When the padded union of visual
 * rects covers more than this fraction of the page, the renderer falls back
 * to a full-page render (cheaper than constructing an almost-page-sized
 * cropped pixmap that yields the same image).
 */
const MAX_CROP_PAGE_RATIO = 0.85

const MIN_VECTOR_WIDTH = 20
const MIN_VECTOR_HEIGHT = 20
const MIN_VECTOR_AREA_RATIO = 0.0005
const VECTOR_STROKE_COUNT_THRESHOLD = 5

/**
 * Input page record consumed by the detector. `stextJson` is typed `unknown`
 * because mupdf's `StructuredText.asJSON()` shape is not statically declared
 * by `mupdf.d.ts`. The implementation narrows it locally.
 */
interface DetectorPage {
  pageNum: number
  stextJson: unknown
}

/**
 * Output record. Separate from the input page record (not joined back) so
 * the detector stays dispatch-agnostic; the orchestrator joins via `pageNum`.
 */
interface DetectorResult {
  pageNum: number
  isCandidate: boolean
  cropRect?: Rect
}

/**
 * Rectangle tuple in mupdf page coordinates: [x0, y0, x1, y1].
 */
type Rect = [number, number, number, number]

function areaOf(rect: Rect): number {
  const [x0, y0, x1, y1] = rect
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
}

function clampRect(rect: Rect, bounds: Rect): Rect {
  const [x0, y0, x1, y1] = rect
  const [bx0, by0, bx1, by1] = bounds
  return [
    Math.max(bx0, Math.min(bx1, x0)),
    Math.max(by0, Math.min(by1, y0)),
    Math.max(bx0, Math.min(bx1, x1)),
    Math.max(by0, Math.min(by1, y1)),
  ]
}

function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  let [x0, y0, x1, y1] = rects[0] as Rect
  for (const rect of rects.slice(1)) {
    x0 = Math.min(x0, rect[0])
    y0 = Math.min(y0, rect[1])
    x1 = Math.max(x1, rect[2])
    y1 = Math.max(y1, rect[3])
  }
  return [x0, y0, x1, y1]
}

function padRect(rect: Rect, pageBounds: Rect): Rect {
  const width = Math.max(0, rect[2] - rect[0])
  const height = Math.max(0, rect[3] - rect[1])
  const xPad = Math.max(MIN_CROP_PADDING, width * CROP_PADDING_RATIO)
  const yPad = Math.max(MIN_CROP_PADDING, height * CROP_PADDING_RATIO)
  return clampRect([rect[0] - xPad, rect[1] - yPad, rect[2] + xPad, rect[3] + yPad], pageBounds)
}

function isLikelyCornerLogo(rect: Rect, pageBounds: Rect, areaRatio: number): boolean {
  if (areaRatio > MAX_CORNER_LOGO_AREA_RATIO) return false

  const [x0, y0, x1, y1] = rect
  const [px0, py0, px1, py1] = pageBounds
  const pageWidth = Math.max(0, px1 - px0)
  const pageHeight = Math.max(0, py1 - py0)
  if (pageWidth <= 0 || pageHeight <= 0) return false

  const edgeBandX = pageWidth * CORNER_LOGO_EDGE_BAND_RATIO
  const edgeBandY = pageHeight * CORNER_LOGO_EDGE_BAND_RATIO
  const nearHorizontalEdge = x0 <= px0 + edgeBandX || x1 >= px1 - edgeBandX
  const nearVerticalEdge = y0 <= py0 + edgeBandY || y1 >= py1 - edgeBandY

  return nearHorizontalEdge && nearVerticalEdge
}

/**
 * mupdf StructuredText emits `bbox: { x, y, w, h }` (probe-verified — see
 * `tmp/probe/probe-results/probe-stext-blocks.log`). Other shapes are
 * silently skipped rather than guessed — the binary decision tolerates
 * the loss because the per-page heuristic still has the vector signal.
 */
function blockRect(block: unknown): Rect | null {
  if (typeof block !== 'object' || block === null) return null
  const bbox = (block as { bbox?: unknown }).bbox
  if (typeof bbox !== 'object' || bbox === null) return null
  const { x, y, w, h } = bbox as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
  if (![x, y, w, h].every((v) => typeof v === 'number')) return null
  return [x as number, y as number, (x as number) + (w as number), (y as number) + (h as number)]
}

function getBlocks(stextJson: unknown): unknown[] {
  if (typeof stextJson !== 'object' || stextJson === null) {
    return []
  }
  const blocks = (stextJson as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) {
    return []
  }
  return blocks
}

function getMeaningfulImageRects(
  stextJson: unknown,
  pageBounds: Rect
): {
  isCandidate: boolean
  rects: Rect[]
} {
  const pageArea = areaOf(pageBounds)
  if (pageArea <= 0) return { isCandidate: false, rects: [] }

  let maxAreaRatio = 0
  let totalAreaRatio = 0
  const rects: Rect[] = []

  for (const block of getBlocks(stextJson)) {
    if (typeof block !== 'object' || block === null) continue
    if ((block as { type?: unknown }).type !== 'image') continue

    const rect = blockRect(block)
    if (!rect) continue

    const clamped = clampRect(rect, pageBounds)
    const [x0, y0, x1, y1] = clamped
    const width = Math.max(0, x1 - x0)
    const height = Math.max(0, y1 - y0)
    const ratio = areaOf(clamped) / pageArea
    if (isLikelyCornerLogo(clamped, pageBounds, ratio)) continue

    const effective =
      width >= MIN_IMAGE_BLOCK_WIDTH &&
      height >= MIN_IMAGE_BLOCK_HEIGHT &&
      ratio >= MIN_IMAGE_BLOCK_AREA_RATIO &&
      ratio <= MAX_EFFECTIVE_AREA_RATIO

    if (!effective) continue
    maxAreaRatio = Math.max(maxAreaRatio, ratio)
    totalAreaRatio += ratio
    rects.push(clamped)
  }

  return {
    isCandidate:
      maxAreaRatio >= IMAGE_MAX_AREA_RATIO_THRESHOLD ||
      totalAreaRatio >= IMAGE_TOTAL_AREA_RATIO_THRESHOLD,
    rects,
  }
}

function getEffectiveVectorStrokeRects(
  page: mupdf.Page,
  pageNum: number,
  pageBounds: Rect
): Rect[] {
  const pageArea = areaOf(pageBounds)
  if (pageArea <= 0) return []

  const rects: Rect[] = []
  const device = new mupdf.Device({
    strokePath(pathObj: mupdf.Path, stroke: mupdf.StrokeState, ctm: mupdf.Matrix) {
      try {
        const rawRect = pathObj.getBounds(stroke, ctm)
        const [x0, y0, x1, y1] = rawRect
        if (![x0, y0, x1, y1].every((v) => typeof v === 'number')) return

        const rect = clampRect([x0, y0, x1, y1], pageBounds)
        const [rx0, ry0, rx1, ry1] = rect
        const width = Math.max(0, rx1 - rx0)
        const height = Math.max(0, ry1 - ry0)
        const ratio = areaOf(rect) / pageArea
        const effective =
          width >= MIN_VECTOR_WIDTH &&
          height >= MIN_VECTOR_HEIGHT &&
          ratio >= MIN_VECTOR_AREA_RATIO &&
          ratio <= MAX_EFFECTIVE_AREA_RATIO

        if (effective) rects.push(rect)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`detector: stroke getBounds failed on page ${pageNum}: ${message}`)
      }
    },
  })

  try {
    page.run(device, mupdf.Matrix.identity)
  } catch (err) {
    // A per-page mupdf failure here would otherwise propagate out of
    // `detectVisualCandidates` and abort the entire visual ingest before the
    // orchestrator's per-page fallback can swallow it. Degrading the vector
    // signal to "no rects" matches the orchestrator's per-page tolerance
    // contract: this page just doesn't get a vector candidate.
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`detector: vector scan failed on page ${pageNum}: ${message}`)
    return []
  } finally {
    device.close()
  }

  return rects
}

/**
 * Decide which pages are visual candidates.
 *
 * @param pages - Per-page records from `parsePdfPages`, each carrying the
 *                raw mupdf StructuredText JSON.
 * @returns Per-page `{ pageNum, isCandidate }` records in the same order as
 *          the input.
 */
export function detectVisualCandidates(
  pages: DetectorPage[],
  doc: MupdfDocument
): DetectorResult[] {
  return pages.map((p) => {
    const page = doc.loadPage(p.pageNum - 1)
    let imageSignal: { isCandidate: boolean; rects: Rect[] }
    let vectorRects: Rect[] = []
    let vectorIsCandidate = false
    try {
      const bounds = page.getBounds()
      const pageBounds: Rect = [bounds[0], bounds[1], bounds[2], bounds[3]]
      imageSignal = getMeaningfulImageRects(p.stextJson, pageBounds)

      // The vector scan is expensive (it replays the page's content stream).
      // Skip it when the image signal already flips the page to a candidate —
      // any vector rects would only nudge the crop rect outward inside the
      // 85% page-ratio cap, which is below the precision floor that drives
      // VLM quality.
      if (!imageSignal.isCandidate) {
        vectorRects = getEffectiveVectorStrokeRects(page, p.pageNum, pageBounds)
        vectorIsCandidate = vectorRects.length >= VECTOR_STROKE_COUNT_THRESHOLD
      }

      const isCandidate = imageSignal.isCandidate || vectorIsCandidate
      if (!isCandidate) {
        return { pageNum: p.pageNum, isCandidate: false }
      }

      const visualRects = [...imageSignal.rects, ...vectorRects]
      const padded = padRect(unionRect(visualRects) ?? pageBounds, pageBounds)
      const pageRatio = areaOf(padded) / areaOf(pageBounds)
      // When the padded crop covers most of the page, the renderer's
      // full-page path produces the same image at lower cost than building a
      // page-sized clipped pixmap.
      const cropRect = pageRatio > MAX_CROP_PAGE_RATIO ? undefined : padded

      return {
        pageNum: p.pageNum,
        isCandidate: true,
        ...(cropRect ? { cropRect } : {}),
      }
    } finally {
      page.destroy?.()
    }
  })
}
