// PDF page renderer for the visual ingest path.
//
// Given an already-open mupdf `Document` and a 1-based page number, renders
// either the full page or a crop rectangle to a PNG byte array at the
// renderer-internal DPI. The renderer does NOT own the document lifecycle —
// the caller opens and destroys the document.
//
// Contract:
//   1. `page = doc.loadPage(pageNum - 1)`              (1-based → 0-based)
//   2. `matrix = [RENDER_DPI/72, 0, 0, RENDER_DPI/72, 0, 0]`
//   3. Full page: `page.toPixmap(matrix, ColorSpace.DeviceRGB, false, true)`
//      Crop: render via `DrawDevice` into a pixmap sized to the crop rect.
//   4. return `pixmap.asPNG()`                          (Uint8Array, not Buffer)
//   5. on mupdf error → throw `VlmError('Failed to render PDF page',
//                                       { cause: err, pageNum })`

import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

import { VlmError } from './types.js'

export { VlmError }

// Module-private. Single consumer (this file). Not exported, not surfaced.
// 200 DPI keeps small in-figure text (axis labels, legends, table cells)
// legible after the VLM processor's internal downscale to ~512 px. 150 DPI
// loses sub-10pt label glyphs on dense scientific PDFs; 300 DPI doubles
// pixmap bytes for no measured retrieval-quality gain.
const RENDER_DPI = 200

type Rect = [number, number, number, number]

function renderCrop(page: mupdf.Page, cropRect: Rect, scale: number): Uint8Array {
  const [x0, y0, x1, y1] = cropRect
  const width = Math.max(1, Math.ceil((x1 - x0) * scale))
  const height = Math.max(1, Math.ceil((y1 - y0) * scale))
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)
  const matrix: mupdf.Matrix = [scale, 0, 0, scale, -x0 * scale, -y0 * scale]
  const device = new mupdf.DrawDevice(matrix, pixmap)

  try {
    // Paint a white background (255 = max channel value on DeviceRGB) so any
    // transparent / unpainted regions show as white to the VLM rather than the
    // pixmap's default black.
    pixmap.clear(255)
    page.run(device, mupdf.Matrix.identity)
    return pixmap.asPNG()
  } finally {
    device.close()
    pixmap.destroy?.()
  }
}

/**
 * Render a single PDF page to a PNG byte array.
 *
 * @param doc - An already-open mupdf `Document`. The renderer does NOT own the
 *              document lifecycle.
 * @param pageNum - 1-based page index. Translated to 0-based for mupdf.
 * @returns PNG bytes (`Uint8Array`, NOT `Buffer`).
 * @throws {VlmError} When mupdf rejects the page (out-of-range, render
 *                    failure, etc.). `cause` carries the original mupdf error;
 *                    `pageNum` carries the requested 1-based page.
 */
export async function renderPdfPage(
  doc: MupdfDocument,
  pageNum: number,
  cropRect?: Rect
): Promise<Uint8Array> {
  let page: mupdf.Page | null = null
  let fullPagePixmap: mupdf.Pixmap | null = null
  try {
    page = doc.loadPage(pageNum - 1)
    const scale = RENDER_DPI / 72
    if (cropRect) return renderCrop(page, cropRect, scale)

    const matrix: mupdf.Matrix = [scale, 0, 0, scale, 0, 0]
    fullPagePixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    return fullPagePixmap.asPNG()
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err))
    throw new VlmError('Failed to render PDF page', { cause, pageNum })
  } finally {
    fullPagePixmap?.destroy?.()
    page?.destroy?.()
  }
}
