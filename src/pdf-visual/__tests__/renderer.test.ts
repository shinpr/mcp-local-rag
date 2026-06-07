// T3.1 — `renderPdfPage` unit test.
//
// Asserts the public contract of `renderPdfPage` documented in
// docs/design/vlm-pdf-enrichment-design.md §Component `pdf-visual/renderer.ts`:
//
//   renderPdfPage(doc: MupdfDocument, pageNum: number): Promise<Uint8Array>
//
// Verification points (DD §Testing matrix, row `renderer.test.ts`):
//   - Result is a `Uint8Array` starting with PNG magic bytes (0x89 0x50 0x4E 0x47).
//   - Out-of-range `pageNum` throws `VlmError` carrying `.pageNum` matching the
//     requested 1-based page.
//
// This test runs against real mupdf (no `vi.mock('mupdf', ...)`). The PDF is
// synthesized in-memory via `mupdf.PDFDocument` so the test is portable across
// clean checkouts and CI — no external fixture file is required. A single
// blank page is sufficient: page 1 exercises the happy path, page 999
// exercises the out-of-range path.

import * as mupdf from 'mupdf'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderPdfPage, VlmError } from '../renderer.js'

// PNG magic bytes per RFC 2083 §3.1.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

/**
 * Build a minimal single-page PDF in memory and return its bytes. The page
 * has empty content (no drawn text or graphics), which is sufficient for the
 * renderer contract — `renderPdfPage` only needs a loadable page to produce
 * PNG bytes. `addPage` returns the new page object, and `insertPage(-1, …)`
 * appends it to the page tree; without `insertPage` mupdf would refuse to
 * load the page after re-opening the saved bytes.
 */
function buildMinimalPdfBytes(): Uint8Array {
  const pdf = new mupdf.PDFDocument()
  try {
    const resources = pdf.newDictionary()
    const contents = new mupdf.Buffer()
    const pageObj = pdf.addPage([0, 0, 100, 100], 0, resources, contents)
    pdf.insertPage(-1, pageObj)
    return pdf.saveToBuffer().asUint8Array()
  } finally {
    pdf.destroy()
  }
}

describe('renderPdfPage', () => {
  let doc: mupdf.Document | undefined

  beforeAll(() => {
    const bytes = buildMinimalPdfBytes()
    doc = mupdf.Document.openDocument(bytes, 'application/pdf')
  })

  afterAll(() => {
    doc?.destroy()
    doc = undefined
  })

  it('returns a Uint8Array starting with PNG magic bytes for a valid page', async () => {
    // Arrange — fixture already opened in beforeAll.

    // Act
    const png = await renderPdfPage(doc as mupdf.Document, 1)

    // Assert: shape + PNG signature (first 4 bytes).
    expect(png).toBeInstanceOf(Uint8Array)
    expect(png.length).toBeGreaterThan(PNG_MAGIC.length)
    expect(png[0]).toBe(PNG_MAGIC[0])
    expect(png[1]).toBe(PNG_MAGIC[1])
    expect(png[2]).toBe(PNG_MAGIC[2])
    expect(png[3]).toBe(PNG_MAGIC[3])
  })

  it('returns a PNG when rendering a crop rectangle', async () => {
    // Arrange — crop a small region from the already-open fixture page.
    const cropRect: [number, number, number, number] = [10, 10, 60, 60]

    // Act
    const png = await renderPdfPage(doc as mupdf.Document, 1, cropRect)

    // Assert: crop rendering still returns valid PNG bytes.
    expect(png).toBeInstanceOf(Uint8Array)
    expect(png.length).toBeGreaterThan(PNG_MAGIC.length)
    expect(png[0]).toBe(PNG_MAGIC[0])
    expect(png[1]).toBe(PNG_MAGIC[1])
    expect(png[2]).toBe(PNG_MAGIC[2])
    expect(png[3]).toBe(PNG_MAGIC[3])
  })

  it('throws VlmError carrying the requested pageNum when page is out of range', async () => {
    // Arrange — fixture already opened; pick an obviously out-of-range page.
    const requestedPage = 999

    // Act + Assert
    let captured: unknown
    try {
      await renderPdfPage(doc as mupdf.Document, requestedPage)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(VlmError)
    expect((captured as VlmError).pageNum).toBe(requestedPage)
    expect((captured as VlmError).name).toBe('VlmError')
    expect((captured as VlmError).message).toBe('Failed to render PDF page')
    expect((captured as VlmError).cause).toBeDefined()
  })
})
