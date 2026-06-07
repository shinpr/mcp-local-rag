// T2.5 — `parsePdfPages` shape test.
//
// Asserts the public contract of `DocumentParser.parsePdfPages` documented in
// docs/design/vlm-pdf-enrichment-design.md §Component `parser.parsePdfPages`
// and §Field Propagation Map:
//
//   { doc, metadataTitle, pages: Array<{ pageNum, text, stextJson,
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
            { text: 'Synthetic Heading', x: 72, y: 100, font: { size: 24 } },
            { text: 'page 1 body', x: 72, y: 140, font: { size: 12 } },
          ],
        },
      ],
    }
    const page2Stext = {
      blocks: [
        {
          type: 'text',
          lines: [{ text: 'page 2 body', x: 72, y: 100, font: { size: 12 } }],
        },
      ],
    }

    const makePage = (json: unknown) => ({
      getBounds: vi.fn().mockReturnValue([0, 0, 612, 792]),
      toStructuredText: vi.fn().mockReturnValue({
        asJSON: vi.fn().mockReturnValue(JSON.stringify(json)),
      }),
    })
    const mockPages = [makePage(page1Stext), makePage(page2Stext)]

    const mockDoc = {
      countPages: vi.fn().mockReturnValue(2),
      loadPage: vi.fn().mockImplementation((i: number) => mockPages[i]),
      getMetaData: vi
        .fn()
        .mockImplementation((key: string) => (key === 'info:Title' ? 'Synthetic Title' : '')),
      destroy: vi.fn(),
    }
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

    // Negative assertion: `page1FontHint` is a page-1-only field per
    // DD §Field Propagation Map. Verify the KEY itself is absent on pages[1]
    // (not merely undefined-via-typeof) so a future regression that always
    // sets the field would be caught.
    expect(Object.hasOwn(result.pages[1] as object, 'page1FontHint')).toBe(false)
  })
})
