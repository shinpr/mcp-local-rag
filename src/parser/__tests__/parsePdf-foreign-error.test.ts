// AC-002 / AC-003 — parser PDF path must rethrow a FOREIGN `AppError`
// (e.g. `EmbeddingError` raised while the parser uses the embedder) UNCHANGED,
// instead of relabeling it as `FileOperationError("Failed to parse PDF...")`.
//
// Boundaries exercised here:
//   - parsePdf: foreign `EmbeddingError` from the embedder (surfaced via the
//     mocked `filterPageBoundaryLayouts` inside `extractPdfPages`) propagates
//     as-is; a genuine non-`AppError` mupdf/IO failure still wraps as
//     `FileOperationError` with `.cause` identity preserved.
//   - parsePdfPages: same foreign-vs-genuine split; on the foreign path the
//     mupdf `doc` handle is still destroyed exactly once before the rethrow.
//   - title extraction: a foreign `AppError` thrown during page-1 chunking
//     propagates (no filename fallback); a non-`AppError` title-local failure
//     still falls back to the filename-derived title.
//
// Mocking strategy mirrors `parsePdf-destroy.test.ts`: `vi.hoisted` + `vi.doMock`
// of `mupdf`, `../pdf-filter.js`, `../title-extractor.js`, `../../chunker/index.js`
// installed in `beforeAll` and removed in `afterAll`. Foreign-error injection
// points: `mockFilterPageBoundaryLayouts` (reaches the outer catch via
// `extractPdfPages`) and `mockChunkText` (reaches the title inner catch).

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectInstanceOf } from '../../__tests__/test-doubles.js'
import type { EmbedderInterface } from '../pdf-filter.js'

// ============================================
// Mocks
// ============================================

const { mockOpenDocument, mockFilterPageBoundaryLayouts, mockExtractPdfTitle, mockChunkText } =
  vi.hoisted(() => ({
    mockOpenDocument: vi.fn(),
    mockFilterPageBoundaryLayouts: vi.fn(),
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
    filterPageBoundaryLayouts: mockFilterPageBoundaryLayouts,
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
// Imported from the SAME post-`resetModules` module graph as the parser, so
// `EmbeddingError` shares the `AppError` base identity that the parser's
// `isAppError` checks against. A top-level import would bind to a different
// `AppError` class once `vi.resetModules()` rebuilds the graph, making
// `instanceof AppError` spuriously false.
let EmbeddingError: typeof import('../../embedder/index.js').EmbeddingError

// ============================================
// Test suite
// ============================================

describe('parser PDF foreign-error reclassification (AC-002 / AC-003)', () => {
  const testDir = join(process.cwd(), 'tmp', 'test-parsePdf-foreign-error')
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
    ;({ EmbeddingError } = await import('../../embedder/index.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) {
      vi.doUnmock(p)
    }
    vi.resetModules()
  })

  /**
   * Build a mupdf mock document. `destroyFn` is exposed so each test can
   * assert disposal directly. The page bodies are minimal — the foreign /
   * genuine error is injected via `mockFilterPageBoundaryLayouts`, not the
   * page loop itself.
   */
  function setupMupdfMock(options?: { metadataTitle?: string }): {
    destroyFn: ReturnType<typeof vi.fn>
  } {
    const destroyFn = vi.fn()
    const mockPage = {
      getBounds: vi.fn().mockReturnValue([0, 0, 612, 792]),
      toStructuredText: vi.fn().mockReturnValue({
        asJSON: vi.fn().mockReturnValue(
          JSON.stringify({
            blocks: [
              {
                type: 'text',
                lines: [{ text: 'Hello world', x: 72, y: 100, font: { size: 12 } }],
              },
            ],
          })
        ),
        destroy: vi.fn(),
      }),
      destroy: vi.fn(),
    }
    const mockDoc = {
      countPages: vi.fn().mockReturnValue(1),
      loadPage: vi.fn().mockReturnValue(mockPage),
      getMetaData: vi.fn().mockReturnValue(options?.metadataTitle ?? ''),
      destroy: destroyFn,
    }
    mockOpenDocument.mockReturnValue(mockDoc)
    return { destroyFn }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(testDir, { recursive: true })

    parser = new DocumentParser({ baseDir: testDir, maxFileSize })

    // Default happy-path behavior for the filter and title extractor; each
    // test overrides the relevant mock to inject its failure class.
    mockFilterPageBoundaryLayouts.mockImplementation(
      async (pageDataArr: Array<{ items: Array<{ text: string }> }>) =>
        pageDataArr.map((p) => ({
          text: p.items.map((item) => item.text).join('\n'),
          textFragments: [],
        }))
    )
    mockExtractPdfTitle.mockImplementation(
      (
        _metadata: string | undefined,
        _chunk: string | undefined,
        fileName: string,
        _fontHint?: { text: string; fontSize: number }
      ) => ({ title: fileName.replace(/\.pdf$/, ''), source: 'filename' as const })
    )
    mockChunkText.mockImplementation(async (text: string) => [{ text, index: 0 }])

    await writeFile(join(testDir, 'test.pdf'), 'dummy-pdf-content')
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  // ------------------------------------------------------------------
  // parsePdf
  // ------------------------------------------------------------------

  it('parsePdf rethrows a foreign EmbeddingError unchanged (not relabeled as FileOperationError)', async () => {
    const filePath = join(testDir, 'test.pdf')
    setupMupdfMock()
    const foreign = new EmbeddingError('Embedding failed for dtype int8')
    mockFilterPageBoundaryLayouts.mockRejectedValue(foreign)

    let thrown: unknown
    try {
      await parser.parsePdf(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(foreign)
    expect(thrown).toBeInstanceOf(EmbeddingError)
    expect(thrown).not.toBeInstanceOf(FileOperationError)
    expect(expectInstanceOf(thrown, EmbeddingError).message).toBe('Embedding failed for dtype int8')
  })

  it('parsePdf still wraps a genuine non-AppError IO/mupdf failure as FileOperationError with cause', async () => {
    const filePath = join(testDir, 'test.pdf')
    setupMupdfMock()
    const genuine = new Error('Simulated mupdf decode failure')
    mockFilterPageBoundaryLayouts.mockRejectedValue(genuine)

    let thrown: unknown
    try {
      await parser.parsePdf(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileOperationError)
    expect(expectInstanceOf(thrown, FileOperationError).message).toBe(
      `Failed to parse PDF: ${filePath}`
    )
    expect(expectInstanceOf(thrown, FileOperationError).cause).toBe(genuine)
  })

  it('parsePdf still disposes doc on the foreign-error rethrow path (finally runs)', async () => {
    const filePath = join(testDir, 'test.pdf')
    const { destroyFn } = setupMupdfMock()
    mockFilterPageBoundaryLayouts.mockRejectedValue(new EmbeddingError('boom'))

    await expect(parser.parsePdf(filePath, mockEmbedder)).rejects.toBeInstanceOf(EmbeddingError)
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // parsePdfPages
  // ------------------------------------------------------------------

  it('parsePdfPages rethrows a foreign EmbeddingError unchanged', async () => {
    const filePath = join(testDir, 'test.pdf')
    setupMupdfMock()
    const foreign = new EmbeddingError('Embedding failed during page extraction')
    mockFilterPageBoundaryLayouts.mockRejectedValue(foreign)

    let thrown: unknown
    try {
      await parser.parsePdfPages(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(foreign)
    expect(thrown).toBeInstanceOf(EmbeddingError)
    expect(thrown).not.toBeInstanceOf(FileOperationError)
  })

  it('parsePdfPages still wraps a genuine non-AppError failure as FileOperationError with cause', async () => {
    const filePath = join(testDir, 'test.pdf')
    setupMupdfMock()
    const genuine = new Error('Simulated mupdf page failure')
    mockFilterPageBoundaryLayouts.mockRejectedValue(genuine)

    let thrown: unknown
    try {
      await parser.parsePdfPages(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(FileOperationError)
    expect(expectInstanceOf(thrown, FileOperationError).message).toBe(
      `Failed to parse PDF pages: ${filePath}`
    )
    expect(expectInstanceOf(thrown, FileOperationError).cause).toBe(genuine)
  })

  it('parsePdfPages disposes doc exactly once before rethrowing a foreign EmbeddingError', async () => {
    const filePath = join(testDir, 'test.pdf')
    const { destroyFn } = setupMupdfMock()
    mockFilterPageBoundaryLayouts.mockRejectedValue(new EmbeddingError('boom'))

    await expect(parser.parsePdfPages(filePath, mockEmbedder)).rejects.toBeInstanceOf(
      EmbeddingError
    )
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })

  // ------------------------------------------------------------------
  // title extraction inner catch
  // ------------------------------------------------------------------

  it('title extraction propagates a foreign AppError from page-1 chunking (no filename fallback)', async () => {
    const filePath = join(testDir, 'test.pdf')
    setupMupdfMock()
    const foreign = new EmbeddingError('Embedding failed during title chunking')
    mockChunkText.mockRejectedValue(foreign)

    let thrown: unknown
    try {
      await parser.parsePdf(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(foreign)
    expect(thrown).toBeInstanceOf(EmbeddingError)
    expect(thrown).not.toBeInstanceOf(FileOperationError)
    // The title extractor must NOT have been consulted — the foreign error
    // short-circuits before the filename fallback.
    expect(mockExtractPdfTitle).not.toHaveBeenCalled()
  })

  it('title extraction falls back to the filename for a non-AppError title-local failure', async () => {
    const filePath = join(testDir, 'test.pdf')
    setupMupdfMock()
    mockChunkText.mockRejectedValue(new Error('Title-local chunking glitch'))

    const result = await parser.parsePdf(filePath, mockEmbedder)

    // The non-AppError title-local failure is swallowed; the filename-derived
    // title is used (mockExtractPdfTitle returns the basename without .pdf).
    expect(result.title).toBe('test')
    expect(mockExtractPdfTitle).toHaveBeenCalledTimes(1)
  })
})
