// AC-013 — `parsePdf` calls `doc.destroy()` exactly once on both the success
// path and the error path.
//
// `parsePdfPages` has an asymmetric disposal contract per DD §
// `parser.parsePdfPages` contract: on the SUCCESS path it does NOT call
// `destroy` (caller-owned disposal); on the ERROR path it destroys `doc`
// internally before re-throwing so the caller never receives a leaked handle.
// The third test in this file is the success-path negative assertion.
//
// Witness: a `vi.fn()` attached as the `destroy` method of the mock document
// returned by `mupdf.Document.openDocument`. The mock is built per-test so
// each scenario observes its own spy.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedderInterface } from '../pdf-filter.js'

// ============================================
// Mocks
// ============================================
// Installed via `vi.doMock` in `beforeAll` and removed via `vi.doUnmock` in
// `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const { mockOpenDocument, mockFilterPageBoundarySentences, mockExtractPdfTitle, mockChunkText } =
  vi.hoisted(() => ({
    mockOpenDocument: vi.fn(),
    mockFilterPageBoundarySentences: vi.fn(),
    mockExtractPdfTitle: vi.fn(),
    mockChunkText: vi.fn(),
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

const titleExtractorFactory = async (
  importOriginal: () => Promise<typeof import('../title-extractor.js')>
) => {
  const original = await importOriginal()
  return {
    ...original,
    extractPdfTitle: mockExtractPdfTitle,
  }
}

const chunkerFactory = () => ({
  SemanticChunker: class {
    chunkText = mockChunkText
  },
})

const MOCKED_PATHS = [
  'mupdf',
  '../pdf-filter.js',
  '../title-extractor.js',
  '../../chunker/index.js',
] as const

let DocumentParser: typeof import('../index.js').DocumentParser
let FileOperationError: typeof import('../index.js').FileOperationError

// ============================================
// Test suite
// ============================================

describe('parsePdf destroy lifecycle (AC-013)', () => {
  const testDir = join(process.cwd(), 'tmp', 'test-parsePdf-destroy')
  const maxFileSize = 100 * 1024 * 1024 // 100MB
  const mockEmbedder: EmbedderInterface = { embedBatch: vi.fn() }
  let parser: InstanceType<typeof DocumentParser>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('mupdf', mupdfFactory)
    vi.doMock('../pdf-filter.js', pdfFilterFactory)
    vi.doMock('../title-extractor.js', titleExtractorFactory)
    vi.doMock('../../chunker/index.js', chunkerFactory)
    ;({ DocumentParser, FileOperationError } = await import('../index.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  /**
   * Build a mupdf mock document. `destroyFn` is exposed so each test can
   * assert the spy directly. When `pageLoadError` is provided, `loadPage`
   * throws it on the first call — this drives the error path through
   * `extractPdfPages` so the `finally` in `parsePdf` must still run.
   */
  function setupMupdfMock(options: {
    pages: Array<{
      bounds: [number, number, number, number]
      blocks: Array<{
        type: string
        lines?: Array<{ text: string; x: number; y: number; font: { size: number } }>
      }>
    }>
    metadataTitle?: string
    pageLoadError?: Error
  }): { destroyFn: ReturnType<typeof vi.fn> } {
    const destroyFn = vi.fn()
    const mockPages = options.pages.map((pageDef) => {
      const mockStext = {
        asJSON: vi.fn().mockReturnValue(JSON.stringify({ blocks: pageDef.blocks })),
      }
      return {
        getBounds: vi.fn().mockReturnValue(pageDef.bounds),
        toStructuredText: vi.fn().mockReturnValue(mockStext),
      }
    })

    const mockDoc = {
      countPages: vi.fn().mockReturnValue(options.pages.length),
      loadPage: options.pageLoadError
        ? vi.fn().mockImplementation(() => {
            throw options.pageLoadError
          })
        : vi.fn().mockImplementation((i: number) => mockPages[i]),
      getMetaData: vi.fn().mockReturnValue(options.metadataTitle ?? ''),
      destroy: destroyFn,
    }

    mockOpenDocument.mockReturnValue(mockDoc)
    return { destroyFn }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(testDir, { recursive: true })

    parser = new DocumentParser({
      baseDir: testDir,
      maxFileSize,
    })

    // filterPageBoundarySentences: pass through (joins per-page item texts)
    mockFilterPageBoundarySentences.mockImplementation(
      async (pageDataArr: Array<{ items: Array<{ text: string }> }>) =>
        pageDataArr.map((p) => p.items.map((item) => item.text).join('\n'))
    )

    // extractPdfTitle: minimal — return filename-based title (sufficient for AC-013)
    mockExtractPdfTitle.mockImplementation(
      (
        _metadata: string | undefined,
        _chunk: string | undefined,
        fileName: string,
        _fontHint?: { text: string; fontSize: number }
      ) => ({ title: fileName.replace(/\.pdf$/, ''), source: 'filename' as const })
    )

    // SemanticChunker.chunkText: return first text as single chunk
    mockChunkText.mockImplementation(async (text: string) => [{ text, index: 0 }])

    // Dummy PDF file to satisfy validateFilePath + validateFileSize
    await writeFile(join(testDir, 'test.pdf'), 'dummy-pdf-content')
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should call destroy exactly once on the success path', async () => {
    const filePath = join(testDir, 'test.pdf')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Hello world', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
    })

    const result = await parser.parsePdf(filePath, mockEmbedder)

    // Sanity check: success path actually ran (content was extracted)
    expect(result.content).toBe('Hello world')
    // AC-013 witness: destroy called exactly once
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })

  it('should call destroy exactly once on the error path', async () => {
    const filePath = join(testDir, 'test.pdf')
    const pageLoadError = new Error('Simulated per-page extraction failure')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'unused', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
      pageLoadError,
    })

    // Capture the thrown error so we can assert both the surfaced error
    // AND the destroy call count without aborting the test.
    let thrown: unknown
    try {
      await parser.parsePdf(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    // The error is wrapped in FileOperationError per parsePdf's catch block;
    // assert the wrapped error preserves the original via `cause`.
    expect(thrown).toBeInstanceOf(FileOperationError)
    expect((thrown as InstanceType<typeof FileOperationError>).cause).toBe(pageLoadError)
    // AC-013 witness: destroy still called exactly once even when the per-page
    // loop threw. This is the test that would fail if T2.3's `finally` block
    // were removed.
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })

  it('should NOT call destroy from parsePdfPages on the success path (caller-owned disposal)', async () => {
    // SUCCESS-path half of the asymmetric `parsePdfPages` contract:
    // when extraction succeeds, the open `doc` handle is returned to the
    // caller and disposal is the caller's responsibility per DD §
    // parser.parsePdfPages. The ERROR path is covered by the next test.
    const filePath = join(testDir, 'test.pdf')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Page content', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
    })

    const result = await parser.parsePdfPages(filePath, mockEmbedder)

    // Sanity check: parsePdfPages returned the doc handle to the caller
    expect(result.doc).toBeDefined()
    // AC-013 success-path negative assertion: parsePdfPages does NOT call
    // destroy on success — disposal is the caller's responsibility per DD §
    // parser.parsePdfPages.
    expect(destroyFn).toHaveBeenCalledTimes(0)
  })

  it('parsePdfPages should call destroy exactly once on the error path before re-throwing', async () => {
    // ERROR-path half of the asymmetric `parsePdfPages` contract: when the
    // per-page loop throws after `openDocument` succeeded, parsePdfPages
    // destroys `doc` internally before re-throwing so the caller — which
    // never received the handle — does not leak the WASM resource. This is
    // the witness that would fail if the internal catch were removed.
    const filePath = join(testDir, 'test.pdf')
    const pageLoadError = new Error('Simulated per-page extraction failure')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'unused', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
      pageLoadError,
    })

    let thrown: unknown
    try {
      await parser.parsePdfPages(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileOperationError)
    expect((thrown as InstanceType<typeof FileOperationError>).cause).toBe(pageLoadError)
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })
})
