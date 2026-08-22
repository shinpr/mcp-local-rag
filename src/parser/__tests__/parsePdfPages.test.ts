// T2.5 — `parsePdfPages` shape test.
//
// Asserts the public contract of `DocumentParser.parsePdfPages` documented in
// docs/design/vlm-pdf-enrichment-design.md §Component `parser.parsePdfPages`
// and §Field Propagation Map:
//
//   { doc, metadataTitle, pages: Array<{ pageNum, text, textFragments, stextJson,
//                                        page1FontHint?: { text, fontSize } }> }
//
// Specifically:
//   - `metadataTitle` mirrors the PDF `info:Title`.
//   - `pages[0].page1FontHint` is the largest-font line on page 1.
//   - `pages[1]` does NOT carry a `page1FontHint` field (page-1-only).
//
// Mocking strategy mirrors `parsePdf-destroy.test.ts` (the only other
// `parsePdfPages` test file): `vi.hoisted` mocks of `mupdf` and
// `../pdf-filter.js` so the helper's per-page loop runs against synthetic
// stext JSON without touching the real WASM module. `vitest.config.mjs` runs
// with `isolate: false`, so `vi.hoisted` is required for the `mupdf` mock to
// be defined before module evaluation.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedderInterface } from '../pdf-filter.js'

// ============================================
// Mocks
// ============================================
// Installed via `vi.doMock` in `beforeAll` and removed via `vi.doUnmock` in
// `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const { mockOpenDocument, mockFilterPageBoundarySentences } = vi.hoisted(() => ({
  mockOpenDocument: vi.fn(),
  mockFilterPageBoundarySentences: vi.fn(),
}))

const mupdfFactory = () => ({
  Document: { openDocument: mockOpenDocument },
})

const pdfFilterFactory = async (
  importOriginal: () => Promise<typeof import('../pdf-filter.js')>
) => {
  const original = await importOriginal()
  return {
    ...original,
    filterPageBoundarySentences: mockFilterPageBoundarySentences,
  }
}

const MOCKED_PATHS = ['mupdf', '../pdf-filter.js'] as const

let DocumentParser: typeof import('../index.js').DocumentParser

function makePageHandles(json: unknown, bounds = [0, 0, 612, 792]) {
  const pageDestroy = vi.fn()
  const stextDestroy = vi.fn()
  const page = {
    getBounds: vi.fn().mockReturnValue(bounds),
    toStructuredText: vi.fn().mockReturnValue({
      destroy: stextDestroy,
      asJSON: vi.fn().mockReturnValue(JSON.stringify(json)),
    }),
    destroy: pageDestroy,
  }
  return { page, pageDestroy, stextDestroy }
}

function mockDocument(pages: unknown[]) {
  return {
    countPages: vi.fn().mockReturnValue(pages.length),
    loadPage: vi.fn().mockImplementation((index: number) => pages[index]),
    getMetaData: vi
      .fn()
      .mockImplementation((key: string) => (key === 'info:Title' ? 'Synthetic Title' : '')),
    destroy: vi.fn(),
  }
}

// ============================================
// Test suite
// ============================================

describe('parsePdfPages return shape', () => {
  const testDir = join(process.cwd(), 'tmp', 'test-parsePdfPages-shape')
  const maxFileSize = 100 * 1024 * 1024 // 100MB
  const mockEmbedder: EmbedderInterface = { embedBatch: vi.fn() }
  let parser: InstanceType<typeof DocumentParser>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('mupdf', mupdfFactory)
    vi.doMock('../pdf-filter.js', pdfFilterFactory)
    ;({ DocumentParser } = await import('../index.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(testDir, { recursive: true })

    parser = new DocumentParser({
      baseDir: testDir,
      maxFileSize,
    })

    // Pass-through filter: join each page's item texts so per-page `text`
    // becomes deterministic without exercising the real semantic filter.
    mockFilterPageBoundarySentences.mockImplementation(
      async (pageDataArr: Array<{ items: Array<{ text: string }> }>) =>
        pageDataArr.map((p) => p.items.map((item) => item.text).join('\n'))
    )

    // Dummy PDF file to satisfy validateFilePath + validateFileSize.
    await writeFile(join(testDir, 'test.pdf'), 'dummy-pdf-content')
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('returns { doc, metadataTitle, pages } with page1FontHint only on pages[0]', async () => {
    const filePath = join(testDir, 'test.pdf')

    // Synthetic stext blocks:
    //   Page 1: a 24pt line ("Synthetic Heading") that is the largest font on
    //           the page, plus a 12pt body line. The hint extractor joins all
    //           consecutive lines sharing the max font size, so the body line
    //           must NOT match the max size.
    //   Page 2: a single 12pt body line. No "page1" hint should appear here.
    const page1Stext = {
      blocks: [
        {
          type: 'text',
          lines: [
            {
              text: 'Synthetic Heading',
              x: 72,
              y: 100,
              bbox: { x: 72, y: 82, w: 250, h: 24 },
              font: { size: 24 },
            },
            {
              text: 'page 1 body',
              x: 72,
              y: 140,
              bbox: { x: 72, y: 128, w: 180, h: 14 },
              font: { size: 12 },
            },
          ],
        },
      ],
    }
    const page2Stext = {
      blocks: [
        {
          type: 'text',
          lines: [
            {
              text: 'page 2 body',
              x: 72,
              y: 100,
              bbox: { x: 72, y: 88, w: 180, h: 14 },
              font: { size: 12 },
            },
          ],
        },
      ],
    }

    const mockPageHandles = [makePageHandles(page1Stext), makePageHandles(page2Stext)]

    const mockDoc = mockDocument(mockPageHandles.map(({ page }) => page))
    mockOpenDocument.mockReturnValue(mockDoc)

    const result = await parser.parsePdfPages(filePath, mockEmbedder)

    // Top-level shape: keys present.
    expect(result).toHaveProperty('doc')
    expect(result).toHaveProperty('metadataTitle')
    expect(result).toHaveProperty('pages')

    // `doc` is the same handle the mock returned (caller-owned disposal —
    // see parsePdf-destroy.test.ts for the no-destroy assertion).
    expect(result.doc).toBe(mockDoc)

    // `metadataTitle` mirrors `info:Title`.
    expect(result.metadataTitle).toBe('Synthetic Title')

    // `pages` is a length-2 array with the expected per-page shape.
    expect(Array.isArray(result.pages)).toBe(true)
    expect(result.pages).toHaveLength(2)

    // pages[0]: pageNum=1, text/stextJson present, page1FontHint = largest-font line.
    expect(result.pages[0]?.pageNum).toBe(1)
    expect(typeof result.pages[0]?.text).toBe('string')
    expect(result.pages[0]?.text).toBe('Synthetic Heading\npage 1 body')
    expect(typeof result.pages[0]?.stextJson).toBe('object')
    expect(result.pages[0]?.stextJson).not.toBeNull()
    expect(result.pages[0]?.textFragments).toEqual([
      {
        pageNum: 1,
        blockOrdinal: 0,
        lineOrdinal: 0,
        fragmentOrdinal: 0,
        bbox: [72, 82, 322, 106],
        text: 'Synthetic Heading',
        pageTextStart: 0,
        pageTextEnd: 17,
      },
      {
        pageNum: 1,
        blockOrdinal: 0,
        lineOrdinal: 1,
        fragmentOrdinal: 0,
        bbox: [72, 128, 252, 142],
        text: 'page 1 body',
        pageTextStart: 18,
        pageTextEnd: 29,
      },
    ])
    expect(result.pages[0]?.page1FontHint).toEqual({
      text: 'Synthetic Heading',
      fontSize: 24,
    })

    // pages[1]: pageNum=2, text/stextJson present.
    expect(result.pages[1]?.pageNum).toBe(2)
    expect(typeof result.pages[1]?.text).toBe('string')
    expect(result.pages[1]?.text).toBe('page 2 body')
    expect(typeof result.pages[1]?.stextJson).toBe('object')
    expect(result.pages[1]?.stextJson).not.toBeNull()
    expect(result.pages[1]?.textFragments).toEqual([
      {
        pageNum: 2,
        blockOrdinal: 0,
        lineOrdinal: 0,
        fragmentOrdinal: 0,
        bbox: [72, 88, 252, 102],
        text: 'page 2 body',
        pageTextStart: 0,
        pageTextEnd: 11,
      },
    ])

    // Negative assertion: `page1FontHint` is a page-1-only field per
    // DD §Field Propagation Map. Verify the KEY itself is absent on pages[1]
    // (not merely undefined-via-typeof) so a future regression that always
    // sets the field would be caught.
    expect(Object.hasOwn(result.pages[1] as object, 'page1FontHint')).toBe(false)

    for (const handles of mockPageHandles) {
      expect(handles.stextDestroy).toHaveBeenCalledTimes(1)
      expect(handles.pageDestroy).toHaveBeenCalledTimes(1)
    }
  })

  it('reorders complete column bands and preserves native provenance within each band', async () => {
    const heading = {
      text: 'Spanning heading',
      x: 50,
      y: 80,
      bbox: { x: 50, y: 60, w: 800, h: 24 },
      font: { size: 24 },
    }
    const bodyLines = [
      ['Left one', 100, 150],
      ['Right one', 600, 150],
      ['Left two', 100, 200],
      ['Right two', 600, 200],
      ['Left three', 100, 250],
      ['Right three', 600, 250],
    ].map(([text, x, y]) => ({
      text: text as string,
      x: x as number,
      y: y as number,
      bbox: { x: x as number, y: y as number, w: 200, h: 20 },
      font: { size: 12 },
    }))
    const handles = makePageHandles(
      {
        blocks: [
          { type: 'text', lines: [heading] },
          { type: 'text', lines: bodyLines },
        ],
      },
      [0, 0, 1000, 1000]
    )
    mockOpenDocument.mockReturnValue(mockDocument([handles.page]))

    const result = await parser.parsePdfPages(join(testDir, 'test.pdf'), mockEmbedder)

    expect(result.pages[0]?.text.split('\n')).toEqual([
      'Spanning heading',
      'Left one',
      'Left two',
      'Left three',
      'Right one',
      'Right two',
      'Right three',
    ])
    expect(
      result.pages[0]?.textFragments.map(({ blockOrdinal, lineOrdinal, text }) => ({
        blockOrdinal,
        lineOrdinal,
        text,
      }))
    ).toEqual([
      { blockOrdinal: 0, lineOrdinal: 0, text: 'Spanning heading' },
      { blockOrdinal: 1, lineOrdinal: 0, text: 'Left one' },
      { blockOrdinal: 1, lineOrdinal: 2, text: 'Left two' },
      { blockOrdinal: 1, lineOrdinal: 4, text: 'Left three' },
      { blockOrdinal: 1, lineOrdinal: 1, text: 'Right one' },
      { blockOrdinal: 1, lineOrdinal: 3, text: 'Right two' },
      { blockOrdinal: 1, lineOrdinal: 5, text: 'Right three' },
    ])
    const fragments = result.pages[0]?.textFragments ?? []
    expect(fragments[0]).not.toHaveProperty('columnBand')
    expect(fragments.slice(1, 4).map((fragment) => fragment.columnBand)).toEqual([
      { sectionIndex: 1, bandIndex: 0, bbox: [100, 150, 300, 270], pageWidth: 1000 },
      { sectionIndex: 1, bandIndex: 0, bbox: [100, 150, 300, 270], pageWidth: 1000 },
      { sectionIndex: 1, bandIndex: 0, bbox: [100, 150, 300, 270], pageWidth: 1000 },
    ])
    expect(fragments.slice(4).map((fragment) => fragment.columnBand)).toEqual([
      { sectionIndex: 1, bandIndex: 1, bbox: [600, 150, 800, 270], pageWidth: 1000 },
      { sectionIndex: 1, bandIndex: 1, bbox: [600, 150, 800, 270], pageWidth: 1000 },
      { sectionIndex: 1, bandIndex: 1, bbox: [600, 150, 800, 270], pageWidth: 1000 },
    ])
    result.doc.destroy()
  })

  it('preserves native order when a section has fewer than two complete column bands', async () => {
    const lines = [
      ['Spanning heading', 50, 60, 800],
      ['Left one', 100, 150, 200],
      ['Right singleton', 600, 150, 200],
      ['Left two', 100, 200, 200],
    ].map(([text, x, y, width], lineOrdinal) => ({
      text: text as string,
      x: x as number,
      y: y as number,
      bbox: { x: x as number, y: y as number, w: width as number, h: 20 },
      font: { size: lineOrdinal === 0 ? 24 : 12 },
    }))
    const handles = makePageHandles({ blocks: [{ type: 'text', lines }] }, [0, 0, 1000, 1000])
    mockOpenDocument.mockReturnValue(mockDocument([handles.page]))

    const result = await parser.parsePdfPages(join(testDir, 'test.pdf'), mockEmbedder)

    expect(result.pages[0]?.text.split('\n')).toEqual([
      'Spanning heading',
      'Left one',
      'Right singleton',
      'Left two',
    ])
    expect(result.pages[0]?.textFragments.every((fragment) => !fragment.columnBand)).toBe(true)
    result.doc.destroy()
  })
})
