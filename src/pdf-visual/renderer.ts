import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

import { MAX_VISUAL_RENDITION_BYTES } from '../utils/limits.js'
import type { ImageRendition, VisualBBox, VisualEvidence, VisualImageMimeType } from './types.js'
import { VlmError } from './types.js'

export { VlmError }

const RENDER_DPI = 200
const BASE_SCALE = RENDER_DPI / 72
const CAPTION_LONG_EDGE_MAX = 4096
const CAPTION_PIXEL_MAX = 16_777_216
const RENDITION_LONG_EDGE_MAX = 1024
const RENDITION_TARGET_BYTES = 256 * 1024
const JPEG_QUALITIES = [82, 72, 62, 52] as const
const RENDITION_EDGES = [1024, 896, 768, 640, 512, 384, 256] as const

function cropDimensions(cropRect: VisualBBox): { width: number; height: number } {
  const width = cropRect[2] - cropRect[0]
  const height = cropRect[3] - cropRect[1]
  if (![...cropRect, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('Invalid crop rectangle')
  }
  return { width, height }
}

function scaleForLongEdge(cropRect: VisualBBox, longEdge: number): number {
  const { width, height } = cropDimensions(cropRect)
  return Math.min(BASE_SCALE, longEdge / Math.max(width, height))
}

function captionScale(cropRect: VisualBBox): number {
  const { width, height } = cropDimensions(cropRect)
  return Math.min(
    BASE_SCALE,
    CAPTION_LONG_EDGE_MAX / Math.max(width, height),
    Math.sqrt(CAPTION_PIXEL_MAX / (width * height))
  )
}

function renderCrop<T>(
  page: mupdf.Page,
  cropRect: VisualBBox,
  scale: number,
  consume: (pixmap: mupdf.Pixmap) => T
): T {
  const { width: sourceWidth, height: sourceHeight } = cropDimensions(cropRect)
  const width = Math.max(1, Math.floor(sourceWidth * scale))
  const height = Math.max(1, Math.floor(sourceHeight * scale))
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)
  let device: mupdf.DrawDevice | null = null
  try {
    const matrix: mupdf.Matrix = [scale, 0, 0, scale, -cropRect[0] * scale, -cropRect[1] * scale]
    device = new mupdf.DrawDevice(matrix, pixmap)
    pixmap.clear(255)
    page.run(device, mupdf.Matrix.identity)
    return consume(pixmap)
  } finally {
    try {
      device?.close()
    } finally {
      pixmap.destroy?.()
    }
  }
}

function encodePixmap(
  pixmap: mupdf.Pixmap,
  mimeType: VisualImageMimeType,
  quality = 82
): ImageRendition {
  const bytes = mimeType === 'image/png' ? pixmap.asPNG() : pixmap.asJPEG(quality)
  return {
    bytes,
    mimeType,
  }
}

function encodePixmapCandidates(
  pixmap: mupdf.Pixmap,
  mimeType: VisualImageMimeType
): ImageRendition[] {
  const renditions: ImageRendition[] = []
  const qualities = mimeType === 'image/jpeg' ? JPEG_QUALITIES : [82]
  for (const quality of qualities) {
    const rendition = encodePixmap(pixmap, mimeType, quality)
    renditions.push(rendition)
    if (rendition.bytes.byteLength <= RENDITION_TARGET_BYTES) break
  }
  return renditions
}

export async function renderPdfPage(
  doc: MupdfDocument,
  pageNum: number,
  cropRect: VisualBBox
): Promise<Uint8Array> {
  let page: mupdf.Page | null = null
  try {
    page = doc.loadPage(pageNum - 1)
    return renderCrop(page, cropRect, captionScale(cropRect), (pixmap) => pixmap.asPNG())
  } catch (error) {
    if (error instanceof VlmError) throw error
    const cause = error instanceof Error ? error : new Error(String(error))
    throw new VlmError('Failed to render PDF page', { cause, pageNum })
  } finally {
    page?.destroy?.()
  }
}

function preferredMime(evidence: VisualEvidence): VisualImageMimeType {
  return evidence === 'raster' ? 'image/jpeg' : 'image/png'
}

type RenderAtEdge = (edge: number, mimeType: VisualImageMimeType) => ImageRendition[]

function renditionEdges(sourceLongEdge: number): number[] {
  const initialLongEdge = Math.min(RENDITION_LONG_EDGE_MAX, sourceLongEdge)
  return [...new Set(RENDITION_EDGES.map((edge) => Math.min(edge, initialLongEdge)))].filter(
    (edge) => edge >= 1
  )
}

function selectForMime(
  edges: readonly number[],
  mimeType: VisualImageMimeType,
  renderAtEdge: RenderAtEdge
): ImageRendition | null {
  let withinHardLimit: ImageRendition | null = null
  for (const edge of edges) {
    for (const rendition of renderAtEdge(edge, mimeType)) {
      if (rendition.bytes.byteLength <= MAX_VISUAL_RENDITION_BYTES && withinHardLimit === null) {
        withinHardLimit = rendition
      }
      if (rendition.bytes.byteLength <= RENDITION_TARGET_BYTES) return rendition
    }
  }
  return withinHardLimit
}

function selectBoundedRendition(
  sourceLongEdge: number,
  preferred: VisualImageMimeType,
  renderAtEdge: RenderAtEdge
): ImageRendition {
  const edges = renditionEdges(sourceLongEdge)
  const rendition = selectForMime(edges, preferred, renderAtEdge)
  if (rendition) return rendition
  if (preferred === 'image/png') {
    const jpeg = selectForMime(edges, 'image/jpeg', renderAtEdge)
    if (jpeg) return jpeg
  }
  throw new Error('Rendition exceeds the encoded-size limit')
}

export async function renderPdfRendition(
  doc: MupdfDocument,
  pageNum: number,
  cropRect: VisualBBox,
  evidence: VisualEvidence
): Promise<ImageRendition> {
  let page: mupdf.Page | null = null
  try {
    page = doc.loadPage(pageNum - 1)
    const { width, height } = cropDimensions(cropRect)
    const nativeLongEdge = Math.max(1, Math.floor(Math.max(width, height) * BASE_SCALE))
    return selectBoundedRendition(nativeLongEdge, preferredMime(evidence), (edge, mimeType) =>
      renderCrop(page as mupdf.Page, cropRect, scaleForLongEdge(cropRect, edge), (pixmap) =>
        encodePixmapCandidates(pixmap, mimeType)
      )
    )
  } catch (error) {
    if (error instanceof VlmError) throw error
    const cause = error instanceof Error ? error : new Error(String(error))
    throw new VlmError('Failed to render PDF rendition', { cause, pageNum })
  } finally {
    page?.destroy?.()
  }
}

function renderImageAtSize<T>(
  image: mupdf.Image,
  width: number,
  height: number,
  preserveAlpha: boolean,
  consume: (pixmap: mupdf.Pixmap) => T
): T {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], preserveAlpha)
  let device: mupdf.DrawDevice | null = null
  try {
    pixmap.clear(preserveAlpha ? 0 : 255)
    device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
    device.fillImage(image, [width, 0, 0, height, 0, 0], 1)
    device.close()
    device = null
    return consume(pixmap)
  } finally {
    try {
      device?.close()
    } finally {
      pixmap.destroy?.()
    }
  }
}

/** Bound a Mammoth-extracted PNG/JPEG using the same query payload limits as PDF crops. */
export function renderImageRendition(
  bytes: Uint8Array,
  sourceMimeType: VisualImageMimeType
): ImageRendition {
  let image: mupdf.Image | null = null
  try {
    const loadedImage = new mupdf.Image(bytes)
    image = loadedImage
    const sourceWidth = loadedImage.getWidth()
    const sourceHeight = loadedImage.getHeight()
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('Image has invalid dimensions')

    const sourceLongEdge = Math.max(sourceWidth, sourceHeight)
    return selectBoundedRendition(sourceLongEdge, sourceMimeType, (edge, mimeType) => {
      const scale = edge / sourceLongEdge
      const width = Math.max(1, Math.round(sourceWidth * scale))
      const height = Math.max(1, Math.round(sourceHeight * scale))
      return renderImageAtSize(loadedImage, width, height, mimeType === 'image/png', (pixmap) =>
        encodePixmapCandidates(pixmap, mimeType)
      )
    })
  } finally {
    image?.destroy?.()
  }
}
