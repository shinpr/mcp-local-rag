import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

import { BOUNDED_IMAGE_MAX_BYTES, parseBoundedImageStructure } from '../utils/image-structure.js'
import type {
  DetectedVisualRegion,
  ImageRendition,
  VisualAttachment,
  VisualBBox,
  VisualEvidence,
  VisualImageMimeType,
} from './types.js'
import { VlmError } from './types.js'

export { VlmError }

const RENDER_DPI = 200
const BASE_SCALE = RENDER_DPI / 72
const CAPTION_LONG_EDGE_MAX = 4096
const CAPTION_PIXEL_MAX = 16_777_216
const RENDITION_LONG_EDGE_MAX = 1024
const RENDITION_TARGET_BYTES = 256 * 1024
const RENDITION_MAX_BYTES = BOUNDED_IMAGE_MAX_BYTES
const RENDITION_MAX_BASE64_LENGTH = Math.ceil(RENDITION_MAX_BYTES / 3) * 4
const JPEG_QUALITIES = [82, 72, 62, 52] as const
const RENDITION_EDGES = [1024, 896, 768, 640, 512] as const

function cropDimensions(cropRect: VisualBBox): { width: number; height: number } {
  const width = cropRect[2] - cropRect[0]
  const height = cropRect[3] - cropRect[1]
  if (![...cropRect, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('Invalid crop rectangle')
  }
  return { width, height }
}

function captionScale(cropRect: VisualBBox): number {
  const { width, height } = cropDimensions(cropRect)
  return Math.min(
    BASE_SCALE,
    CAPTION_LONG_EDGE_MAX / Math.max(width, height),
    Math.sqrt(CAPTION_PIXEL_MAX / (width * height))
  )
}

function scaleForLongEdge(cropRect: VisualBBox, longEdge: number): number {
  const { width, height } = cropDimensions(cropRect)
  return Math.min(BASE_SCALE, longEdge / Math.max(width, height))
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
    pixelWidth: pixmap.getWidth(),
    pixelHeight: pixmap.getHeight(),
  }
}

export async function renderPdfPage(
  doc: MupdfDocument,
  pageNum: number,
  cropRect?: VisualBBox
): Promise<Uint8Array> {
  let page: mupdf.Page | null = null
  let fullPagePixmap: mupdf.Pixmap | null = null
  try {
    page = doc.loadPage(pageNum - 1)
    if (cropRect) {
      return renderCrop(page, cropRect, captionScale(cropRect), (pixmap) => pixmap.asPNG())
    }
    fullPagePixmap = page.toPixmap(
      [BASE_SCALE, 0, 0, BASE_SCALE, 0, 0],
      mupdf.ColorSpace.DeviceRGB,
      false,
      true
    )
    return fullPagePixmap.asPNG()
  } catch (error) {
    if (error instanceof VlmError) throw error
    const cause = error instanceof Error ? error : new Error(String(error))
    throw new VlmError('Failed to render PDF page', { cause, pageNum })
  } finally {
    fullPagePixmap?.destroy?.()
    page?.destroy?.()
  }
}

function preferredMime(evidence: VisualEvidence): VisualImageMimeType {
  return evidence === 'raster' ? 'image/jpeg' : 'image/png'
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
    const initialLongEdge = Math.min(RENDITION_LONG_EDGE_MAX, nativeLongEdge)
    const edges = [
      ...new Set(RENDITION_EDGES.map((edge) => Math.min(edge, initialLongEdge))),
    ].filter((edge) => edge >= 1)
    const mimeType = preferredMime(evidence)
    let firstWithinHardLimit: ImageRendition | null = null

    for (const edge of edges) {
      const qualities = mimeType === 'image/jpeg' ? JPEG_QUALITIES : [82]
      for (const quality of qualities) {
        const rendition = renderCrop(page, cropRect, scaleForLongEdge(cropRect, edge), (pixmap) =>
          encodePixmap(pixmap, mimeType, quality)
        )
        if (rendition.bytes.byteLength <= RENDITION_MAX_BYTES && !firstWithinHardLimit) {
          firstWithinHardLimit = rendition
        }
        if (rendition.bytes.byteLength <= RENDITION_TARGET_BYTES) return rendition
      }
    }
    if (firstWithinHardLimit) return firstWithinHardLimit

    for (let edge = Math.min(RENDITION_LONG_EDGE_MAX, initialLongEdge); edge >= 256; edge -= 128) {
      const rendition = renderCrop(page, cropRect, scaleForLongEdge(cropRect, edge), (pixmap) =>
        encodePixmap(pixmap, 'image/jpeg', 52)
      )
      if (rendition.bytes.byteLength <= RENDITION_MAX_BYTES) return rendition
    }
    throw new Error('Rendition exceeds the encoded-size limit')
  } catch (error) {
    if (error instanceof VlmError) throw error
    const cause = error instanceof Error ? error : new Error(String(error))
    throw new VlmError('Failed to render PDF rendition', { cause, pageNum })
  } finally {
    page?.destroy?.()
  }
}

function validNormalizedBbox(value: unknown): value is VisualBBox {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return false
  const [x0, y0, x1, y1] = value as VisualBBox
  return x0 >= 0 && y0 >= 0 && x0 < x1 && y0 < y1 && x1 <= 1 && y1 <= 1
}

function decodeStrictBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > RENDITION_MAX_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : null
}

export function validateVisualAttachment(value: unknown): value is VisualAttachment {
  if (typeof value !== 'object' || value === null) return false
  const attachment = value as Partial<VisualAttachment>
  if (
    !Number.isInteger(attachment.pageNum) ||
    (attachment.pageNum as number) < 1 ||
    !Number.isInteger(attachment.visualIndex) ||
    (attachment.visualIndex as number) < 0 ||
    !validNormalizedBbox(attachment.bbox) ||
    (attachment.mimeType !== 'image/png' && attachment.mimeType !== 'image/jpeg') ||
    !Number.isInteger(attachment.pixelWidth) ||
    !Number.isInteger(attachment.pixelHeight) ||
    (attachment.pixelWidth as number) <= 0 ||
    (attachment.pixelHeight as number) <= 0 ||
    Math.max(attachment.pixelWidth as number, attachment.pixelHeight as number) >
      RENDITION_LONG_EDGE_MAX
  ) {
    return false
  }
  const bytes = decodeStrictBase64(attachment.data)
  if (!bytes || bytes.byteLength > RENDITION_MAX_BYTES) return false
  const header = parseBoundedImageStructure(bytes, attachment.mimeType)
  return (
    header !== null &&
    header.width === attachment.pixelWidth &&
    header.height === attachment.pixelHeight
  )
}

export function createVisualAttachment(
  region: DetectedVisualRegion,
  visualIndex: number,
  rendition: ImageRendition
): VisualAttachment {
  const header = parseBoundedImageStructure(rendition.bytes, rendition.mimeType)
  const source = cropDimensions(region.bbox)
  const sourceRatio = source.width / source.height
  const pixelRatio = rendition.pixelWidth / rendition.pixelHeight
  const roundingTolerance = Math.max(1 / rendition.pixelWidth, 1 / rendition.pixelHeight) * 2
  if (
    !header ||
    header.width !== rendition.pixelWidth ||
    header.height !== rendition.pixelHeight ||
    Math.abs(sourceRatio - pixelRatio) / sourceRatio > roundingTolerance ||
    rendition.bytes.byteLength > RENDITION_MAX_BYTES
  ) {
    throw new VlmError('Invalid PDF rendition', { pageNum: region.pageNum })
  }

  const attachment: VisualAttachment = {
    pageNum: region.pageNum,
    visualIndex,
    bbox: region.normalizedBbox,
    mimeType: rendition.mimeType,
    pixelWidth: rendition.pixelWidth,
    pixelHeight: rendition.pixelHeight,
    data: Buffer.from(rendition.bytes).toString('base64'),
  }
  if (!validateVisualAttachment(attachment)) {
    throw new VlmError('Invalid PDF rendition', { pageNum: region.pageNum })
  }
  return attachment
}
