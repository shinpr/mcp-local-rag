// Contract test: what real MuPDF's `toStructuredText().asJSON()` actually
// yields, read through `extractPdfPages`.
//
// `asJSON()` is typed `string`, so `readPageStext` asserts the parsed shape
// against `StextJson` rather than validating it. That assertion is only sound
// while MuPDF really emits the fields this module reads, and every other PDF
// test mocks MuPDF. This one runs the real library end to end so a MuPDF
// upgrade that changes the output surfaces here instead of downstream.

import * as mupdf from 'mupdf'
import { describe, expect, it } from 'vitest'
import { buildPdfWithImageBytes } from '../../__tests__/pdf-image-fixture.js'
import { expectArray, expectDefined, expectRecord } from '../../__tests__/test-doubles.js'
import { extractPdfPages } from '../pdf-extract.js'
import type { EmbedderInterface } from '../pdf-filter.js'

/** A single page never reaches sentence-pattern detection, so no vectors are needed. */
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
    // Every field `collectLineItems` builds an item from must be present.
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

    // Ordinals identify the source position, so they must index back into the
    // raw structured text rather than into a filtered copy.
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
})
