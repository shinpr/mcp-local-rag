// `parsePdfPages` keeps title resolution in the parser before visual captions
// can change the searchable document text.

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
    for (const p of MOCKED_PATHS) {
      vi.doUnmock(p)
    }
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

  it('returns the parser-resolved title with page text and layout', async () => {
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

    expect(result.doc).toBe(mockDoc)
    expect(result.title).toBe('Synthetic Title')

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

    for (const handles of mockPageHandles) {
      expect(handles.stextDestroy).toHaveBeenCalledTimes(1)
      expect(handles.pageDestroy).toHaveBeenCalledTimes(1)
    }
  })
})
