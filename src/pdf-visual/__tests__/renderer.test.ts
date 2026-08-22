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
import {
  createVisualAttachment,
  renderPdfPage,
  renderPdfRendition,
  VlmError,
  validateVisualAttachment,
} from '../renderer.js'

// PNG magic bytes per RFC 2083 §3.1.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='
const JPEG_1X1_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

/**
 * Build a minimal single-page PDF in memory and return its bytes. The page
 * has empty content (no drawn text or graphics), which is sufficient for the
 * renderer contract — `renderPdfPage` only needs a loadable page to produce
 * PNG bytes. `addPage` returns the new page object, and `insertPage(-1, …)`
 * appends it to the page tree; without `insertPage` mupdf would refuse to
 * load the page after re-opening the saved bytes.
 */
function buildMinimalPdfBytes(width = 100, height = 100): Uint8Array {
  const pdf = new mupdf.PDFDocument()
  try {
    const resources = pdf.newDictionary()
    const contents = new mupdf.Buffer()
    const pageObj = pdf.addPage([0, 0, width, height], 0, resources, contents)
    pdf.insertPage(-1, pageObj)
    return pdf.saveToBuffer().asUint8Array()
  } finally {
    pdf.destroy()
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
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

  it('bounds a non-square caption crop without changing its aspect ratio', async () => {
    const bytes = buildMinimalPdfBytes(1800, 600)
    const wideDoc = mupdf.Document.openDocument(bytes, 'application/pdf')
    try {
      const png = await renderPdfPage(wideDoc, 1, [0, 0, 1800, 600])
      const dimensions = pngDimensions(png)

      expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(4096)
      expect(dimensions.width * dimensions.height).toBeLessThanOrEqual(16_777_216)
      expect(dimensions.width / dimensions.height).toBeCloseTo(3, 2)
    } finally {
      wideDoc.destroy()
    }
  })

  it('creates bounded PNG and JPEG renditions with validated attachment metadata', async () => {
    const bytes = buildMinimalPdfBytes(1800, 600)
    const wideDoc = mupdf.Document.openDocument(bytes, 'application/pdf')
    try {
      const pngRendition = await renderPdfRendition(wideDoc, 1, [0, 0, 1800, 600], 'vector')
      const jpegRendition = await renderPdfRendition(wideDoc, 1, [0, 0, 1800, 600], 'raster')

      expect(pngRendition.mimeType).toBe('image/png')
      expect(jpegRendition.mimeType).toBe('image/jpeg')
      for (const rendition of [pngRendition, jpegRendition]) {
        expect(Math.max(rendition.pixelWidth, rendition.pixelHeight)).toBeLessThanOrEqual(1024)
        expect(rendition.pixelWidth / rendition.pixelHeight).toBeCloseTo(3, 2)
        expect(rendition.bytes.byteLength).toBeLessThanOrEqual(512 * 1024)
      }

      const attachment = createVisualAttachment(
        {
          pageNum: 1,
          detectionIndex: 0,
          bbox: [0, 0, 1800, 600],
          normalizedBbox: [0, 0, 1, 1],
          evidence: 'vector',
        },
        4,
        pngRendition
      )
      expect(attachment.visualIndex).toBe(4)
      expect(attachment.data).not.toMatch(/^data:/)
      expect(validateVisualAttachment(attachment)).toBe(true)
    } finally {
      wideDoc.destroy()
    }
  })

  it('rejects malformed base64, signature mismatches, dimension mismatches, and invalid bbox values', async () => {
    const rendition = await renderPdfRendition(doc as mupdf.Document, 1, [0, 0, 100, 100], 'vector')
    const valid = createVisualAttachment(
      {
        pageNum: 1,
        detectionIndex: 0,
        bbox: [0, 0, 100, 100],
        normalizedBbox: [0, 0, 1, 1],
        evidence: 'vector',
      },
      0,
      rendition
    )

    expect(validateVisualAttachment({ ...valid, data: `${valid.data.slice(0, -1)}-` })).toBe(false)
    expect(validateVisualAttachment({ ...valid, mimeType: 'image/jpeg' })).toBe(false)
    expect(validateVisualAttachment({ ...valid, pixelWidth: valid.pixelWidth + 1 })).toBe(false)
    expect(validateVisualAttachment({ ...valid, bbox: [0, 0.8, 1, 0.2] })).toBe(false)
  })

  it('rejects header-only and truncated PNG/JPEG renditions before persistence', () => {
    const region = {
      pageNum: 1,
      detectionIndex: 0,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      normalizedBbox: [0, 0, 1, 1] as [number, number, number, number],
      evidence: 'vector' as const,
    }
    const png = Buffer.from(PNG_1X1_BASE64, 'base64')
    const jpeg = Buffer.from(JPEG_1X1_BASE64, 'base64')
    const jpegSosOffset = jpeg.findIndex(
      (value, index) => value === 0xff && jpeg[index + 1] === 0xda
    )
    expect(jpegSosOffset).toBeGreaterThan(0)

    const malformedRenditions = [
      { bytes: png.subarray(0, 33), mimeType: 'image/png' as const },
      { bytes: png.subarray(0, -12), mimeType: 'image/png' as const },
      { bytes: jpeg.subarray(0, jpegSosOffset), mimeType: 'image/jpeg' as const },
      { bytes: jpeg.subarray(0, -2), mimeType: 'image/jpeg' as const },
    ]

    for (const [visualIndex, rendition] of malformedRenditions.entries()) {
      expect(() =>
        createVisualAttachment(region, visualIndex, {
          ...rendition,
          pixelWidth: 1,
          pixelHeight: 1,
        })
      ).toThrow(VlmError)
    }
  })

  it('accepts bounded JPEG scan stuffing and restart markers', () => {
    const data = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff, 0x00, 0x34, 0xff,
      0xd0, 0x56, 0xff, 0xd9,
    ]).toString('base64')

    expect(
      validateVisualAttachment({
        pageNum: 1,
        visualIndex: 0,
        bbox: [0, 0, 1, 1],
        mimeType: 'image/jpeg',
        pixelWidth: 1,
        pixelHeight: 1,
        data,
      })
    ).toBe(true)
  })
})
