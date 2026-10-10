// `readPageStext` asserts MuPDF's `asJSON()` output against `StextJson`
// instead of validating it, and every other PDF test mocks MuPDF. This one
// runs the real library, so an upgrade that changes the output fails here.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { describe, expect, it } from 'vitest'
import { buildPdfWithImageBytes } from '../../__tests__/pdf-image-fixture.js'
import { buildPdfReadingOrderFixture } from '../../__tests__/pdf-reading-order-fixture.js'
import { expectArray, expectDefined, expectRecord } from '../../__tests__/test-doubles.js'
import { DocumentParser } from '../index.js'
import { extractPdfPages } from '../pdf-extract.js'
import type { EmbedderInterface } from '../pdf-filter.js'

/** A single page never reaches sentence-pattern detection. */
const unusedEmbedder: EmbedderInterface = {
  embedBatch: async () => {
    throw new Error('single-page extraction must not embed')
  },
}

const STEXT_OPTIONS = 'preserve-whitespace,preserve-images'

async function extractFixture(): Promise<Awaited<ReturnType<typeof extractPdfPages>>> {
  const doc = mupdf.Document.openDocument(buildPdfWithImageBytes(), 'application/pdf')
  try {
    return await extractPdfPages(doc, unusedEmbedder, STEXT_OPTIONS)
  } finally {
    doc.destroy()
  }
}

describe('extractPdfPages against real MuPDF output', () => {
  it('reads the text, position and font size the layout filters consume', async () => {
    const { pages } = await extractFixture()
    const page = expectDefined(pages[0])

    expect(page.pageNum).toBe(1)
    expect(page.text).toContain('PDF Image Persistence Fixture Document')

    const heading = expectDefined(
      page.textFragments.find((fragment) =>
        fragment.text.includes('PDF Image Persistence Fixture Document')
      )
    )
    expect(heading.pageNum).toBe(1)
    expect(Number.isInteger(heading.blockOrdinal)).toBe(true)
    expect(Number.isInteger(heading.lineOrdinal)).toBe(true)
    expect(heading.bbox).toHaveLength(4)
    for (const value of heading.bbox) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('keeps every text line MuPDF reported, at its source ordinals', async () => {
    const { pages } = await extractFixture()
    const page = expectDefined(pages[0])

    // The fixture writes five `Tj` strings in one text object.
    expect(page.textFragments.length).toBeGreaterThanOrEqual(5)

    // Ordinals must index back into the raw structured text, not a filtered copy.
    const blocks = expectArray(expectRecord(page.stextJson)['blocks'])
    for (const fragment of page.textFragments) {
      const block = expectRecord(expectDefined(blocks[fragment.blockOrdinal]))
      expect(block['type']).toBe('text')
      const lines = expectArray(block['lines'])
      const line = expectRecord(expectDefined(lines[fragment.lineOrdinal]))
      expect(typeof line['text']).toBe('string')
      expect(typeof line['x']).toBe('number')
      expect(typeof line['y']).toBe('number')
      expect(typeof expectRecord(line['font'])['size']).toBe('number')
    }
  })

  it('surfaces the image block with the bbox the visual detector reads', async () => {
    const { pages } = await extractFixture()
    const page = expectDefined(pages[0])

    const imageBlocks = expectArray(expectRecord(page.stextJson)['blocks'])
      .map((block) => expectRecord(block))
      .filter((block) => block['type'] === 'image')
    expect(imageBlocks.length).toBeGreaterThan(0)

    const bbox = expectRecord(expectDefined(imageBlocks[0])['bbox'])
    for (const key of ['x', 'y', 'w', 'h']) {
      expect(typeof bbox[key]).toBe('number')
    }
  })

  it('reports the largest-font line as the title hint', async () => {
    const { page1FontHint } = await extractFixture()
    const hint = expectDefined(page1FontHint)
    expect(hint.text).toContain('PDF Image Persistence Fixture Document')
    expect(hint.fontSize).toBeGreaterThan(0)
  })

  it('preserves native column order, wrapped text, and source context through both PDF entry points', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-reading-order-'))
    const filePath = join(dir, 'two-columns.pdf')
    await writeFile(filePath, buildPdfReadingOrderFixture())
    const parser = new DocumentParser({ baseDir: dir, maxFileSize: 1_000_000 })
    const embedder: EmbedderInterface = {
      embedBatch: async (texts) => texts.map(() => [1, 0]),
    }
    let visualResult: Awaited<ReturnType<typeof parser.parsePdfPages>> | undefined

    try {
      const parsed = await parser.parsePdf(filePath, embedder)
      visualResult = await parser.parsePdfPages(filePath, embedder)

      expect(visualResult.pages).toHaveLength(3)
      expect(parsed.content).toBe(visualResult.pages.map((page) => page.text).join('\n\n'))
      for (const [index, page] of visualResult.pages.entries()) {
        const pageNum = index + 1
        expect(page.text).not.toContain('Shared Reading Order Header')
        expect(page.text).not.toContain(`Printed Page ${pageNum} of 3`)
        expect(page.text.indexOf(`Left page ${pageNum}`)).toBeLessThan(
          page.text.indexOf(`Right page ${pageNum}`)
        )
        expect(page.text.replace(/\s+/g, ' ')).toContain(
          `Left page ${pageNum} begins with a wrapped statement that continues in the same native block to its complete ending.`
        )
        expect(page.text.replace(/\s+/g, ' ')).toContain(
          `Right page ${pageNum} begins with a separate wrapped statement that continues in the right native block to its complete ending.`
        )

        const heading = expectDefined(
          page.headings?.find((item) => item.text === `Section ${pageNum} Reading Order`)
        )
        expect(page.text.slice(heading.offset, heading.offset + heading.text.length)).toBe(
          heading.text
        )
        const absoluteHeading = expectDefined(
          parsed.sourceMap?.headings.find((item) => item.text === heading.text)
        )
        expect(
          parsed.content.slice(absoluteHeading.offset, absoluteHeading.offset + heading.text.length)
        ).toBe(heading.text)
        const pageRange = expectDefined(
          parsed.sourceMap?.pages?.find((item) => item.page === pageNum)
        )
        expect(parsed.content.slice(pageRange.start, pageRange.end)).toBe(page.text)

        const blocks = expectArray(expectRecord(page.stextJson)['blocks'])
        expect(page.textFragments.length).toBeGreaterThan(0)
        for (const fragment of page.textFragments) {
          expect(page.text.slice(fragment.pageTextStart, fragment.pageTextEnd)).toBe(fragment.text)
          const block = expectRecord(expectDefined(blocks[fragment.blockOrdinal]))
          const lines = expectArray(block['lines'])
          const rawLine = expectRecord(expectDefined(lines[fragment.lineOrdinal]))
          expect(rawLine['text']).toContain(fragment.text)
          const rawBbox = expectRecord(expectDefined(rawLine['bbox']))
          expect(fragment.bbox).toEqual([
            rawBbox['x'],
            rawBbox['y'],
            Number(rawBbox['x']) + Number(rawBbox['w']),
            Number(rawBbox['y']) + Number(rawBbox['h']),
          ])
        }
      }
    } finally {
      visualResult?.doc.destroy()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the complete single-column passage and full-width heading in source order', async () => {
    const doc = mupdf.Document.openDocument(
      buildPdfReadingOrderFixture({
        pageCount: 1,
        layout: 'single-column',
        repeatedBoundaries: false,
      }),
      'application/pdf'
    )
    try {
      const { pages } = await extractPdfPages(doc, unusedEmbedder, 'preserve-whitespace')
      const page = expectDefined(pages[0])
      expect(page.text.replace(/\s+/g, ' ')).toContain(
        'Single-column reading stays in stream order with a wrapped clause continued in the following visual line to its complete ending.'
      )
      const heading = expectDefined(
        page.headings.find((item) => item.text === 'Section 1 Reading Order')
      )
      expect(page.text.slice(heading.offset, heading.offset + heading.text.length)).toBe(
        heading.text
      )
    } finally {
      doc.destroy()
    }
  })
})
