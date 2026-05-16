// PDF page renderer for the visual ingest path.
//
// Given an already-open mupdf `Document` and a 1-based page number, renders
// the page to a PNG byte array at the renderer-internal DPI. The renderer does
// NOT own the document lifecycle — the caller (orchestrator) opens and
// destroys the document; see DD §pdf-visual/renderer.ts and §AC-013.
//
// Contract (DD §Component → renderer.ts):
//   1. `page = doc.loadPage(pageNum - 1)`              (1-based → 0-based)
//   2. `matrix = [RENDER_DPI/72, 0, 0, RENDER_DPI/72, 0, 0]`
//   3. `pixmap = page.toPixmap(matrix, ColorSpace.DeviceRGB, false, true)`
//   4. return `pixmap.asPNG()`                          (Uint8Array, not Buffer)
//   5. on mupdf error → throw `VlmError('Failed to render PDF page',
//                                       { cause: err, pageNum })`
//
// `VlmError` was staged here at T3.1 and promoted to `./types.ts` at T3.3 —
// renderer re-exports it from the canonical location so existing importers
// keep working.

import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

import { VlmError } from './types.js'

export { VlmError }

// Module-private. Single consumer (this file). Not exported, not surfaced.
const RENDER_DPI = 150

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
export async function renderPdfPage(doc: MupdfDocument, pageNum: number): Promise<Uint8Array> {
  try {
    const page = doc.loadPage(pageNum - 1)
    const matrix: mupdf.Matrix = [RENDER_DPI / 72, 0, 0, RENDER_DPI / 72, 0, 0]
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    return pixmap.asPNG()
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err))
    throw new VlmError('Failed to render PDF page', { cause, pageNum })
  }
}
