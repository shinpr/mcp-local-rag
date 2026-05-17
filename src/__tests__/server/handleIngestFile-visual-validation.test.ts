// VLM PDF Enrichment - handleIngestFile `visual` Runtime Validation Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-012 (`visual` runtime validation in MCP handler)
// Test Type: Integration Test (server handler input validation)
// Implementation Timing: Phase 4 (alongside MCP schema field addition)
//
// Lane: integration
//
// vi.hoisted note: Required by isolate: false (vitest.config.mjs:16-18).
// For the negative cases this test only exercises early input validation —
// no PDF parse, chunker, embedder, or vectorStore call is expected to fire,
// and the McpError must be thrown before any of those are touched. The mocks
// here are real-shaped so a leaked replacement still satisfies callers in
// other test files. The positive case for `visual: true` uses real-shaped
// mocks of `src/pdf-visual/index.js` so the dispatch branch can actually run.

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // ---------------- Parser ----------------
    // Real DocumentParser methods: validateFilePath, validateFileSize,
    // parseFile, parsePdf, parsePdfPages.
    parseFile: vi.fn(),
    parsePdf: vi.fn(),
    parsePdfPages: vi.fn(),
    validateFilePath: vi.fn().mockResolvedValue(undefined),
    validateFileSize: vi.fn(),

    // ---------------- Chunker ----------------
    chunkText: vi.fn(),

    // ---------------- Embedder ----------------
    embedInitialize: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    embedBatch: vi.fn().mockResolvedValue([]),

    // ---------------- VectorStore ----------------
    initialize: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
    insertChunks: vi.fn().mockResolvedValue(undefined),
    optimize: vi.fn().mockResolvedValue(undefined),
    getChunksByRange: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({
      documentCount: 0,
      chunkCount: 0,
      memoryUsage: 0,
      uptime: 0,
      ftsIndexEnabled: false,
      searchMode: 'vector-only' as const,
    }),

    // ---------------- pdf-visual (real-shaped) ----------------
    // The visual positive case (`visual: true` on a `.pdf`) needs these to
    // be callable so the dispatch branch can actually run. The AC-012 test
    // only verifies validation, not the visual algorithm — these mocks are
    // stand-ins that return minimal real-shaped values.
    createCaptioner: vi.fn().mockReturnValue({ caption: vi.fn().mockResolvedValue(null) }),
    detectVisualCandidates: vi.fn().mockReturnValue([]),
    enrichPagesWithCaptions: vi.fn(),
  }
})

// NOTE: factories are installed via `vi.doMock` in `beforeAll` and removed
// via `vi.doUnmock` in `afterAll`, so they cannot leak to sibling test files
// through the shared module registry under `isolate: false`.

const parserFactory = () => ({
  DocumentParser: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.parseFile = mocks.parseFile
    this.parsePdf = mocks.parsePdf
    this.parsePdfPages = mocks.parsePdfPages
    this.validateFilePath = mocks.validateFilePath
    this.validateFileSize = mocks.validateFileSize
  }),
  SUPPORTED_EXTENSIONS: new Set(['.pdf', '.docx', '.txt', '.md']),
})

const chunkerFactory = async (
  importOriginal: () => Promise<typeof import('../../chunker/index.js')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    SemanticChunker: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.chunkText = mocks.chunkText
    }),
  }
}

const embedderFactory = () => ({
  Embedder: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = mocks.embedInitialize
    this.embed = mocks.embed
    this.embedBatch = mocks.embedBatch
    this.dispose = vi.fn()
  }),
})

const vectordbFactory = async (
  importOriginal: () => Promise<typeof import('../../vectordb/index.js')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    VectorStore: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.initialize = mocks.initialize
      this.close = vi.fn()
      this.listFiles = mocks.listFiles
      this.search = mocks.search
      this.deleteChunks = mocks.deleteChunks
      this.deleteFiles = vi.fn()
      this.insertChunks = mocks.insertChunks
      this.optimize = mocks.optimize
      this.getChunksByRange = mocks.getChunksByRange
      this.getStatus = mocks.getStatus
    }),
  }
}

const pdfVisualFactory = () => ({
  createCaptioner: mocks.createCaptioner,
  detectVisualCandidates: mocks.detectVisualCandidates,
  enrichPagesWithCaptions: mocks.enrichPagesWithCaptions,
})

const MOCKED_PATHS = [
  '../../parser/index.js',
  '../../chunker/index.js',
  '../../embedder/index.js',
  '../../vectordb/index.js',
  '../../pdf-visual/index.js',
] as const

// ============================================
// Imports (after mocks)
// ============================================
//
// RAGServer is loaded dynamically inside beforeAll AFTER vi.resetModules()
// so this file's vi.mock factories are applied when server/index.js (and
// its transitive dependencies) are re-evaluated.

type RAGServerCtor = typeof import('../../server/index.js').RAGServer
let RAGServer: RAGServerCtor

// ============================================
// Fixture
// ============================================

const FIXTURE_PDF_PATH = '/tmp/test/handleingestfile-visual.pdf'
const FIXTURE_NON_PDF_PATH = '/tmp/test/handleingestfile-visual.md'
const INVALID_PARAMS_MESSAGE = "'visual' must be a boolean if provided"

function buildServer(): InstanceType<RAGServerCtor> {
  return new RAGServer({
    dbPath: '/tmp/test/visual-validation-db',
    modelName: 'mock-model',
    cacheDir: '/tmp/test/visual-validation-cache',
    baseDir: '/tmp/test',
    maxFileSize: 1024 * 1024,
    device: 'cpu',
  })
}

// ============================================
// Tests
// ============================================

describe('handleIngestFile - `visual` Runtime Validation (AC-012)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../parser/index.js', parserFactory)
    vi.doMock('../../chunker/index.js', chunkerFactory)
    vi.doMock('../../embedder/index.js', embedderFactory)
    vi.doMock('../../vectordb/index.js', vectordbFactory)
    vi.doMock('../../pdf-visual/index.js', pdfVisualFactory)
    const mod = await import('../../server/index.js')
    RAGServer = mod.RAGServer
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Restore safe defaults after vi.clearAllMocks() wipes them.
    mocks.initialize.mockResolvedValue(undefined)
    mocks.deleteChunks.mockResolvedValue(undefined)
    mocks.optimize.mockResolvedValue(undefined)
    mocks.listFiles.mockResolvedValue([])
    mocks.search.mockResolvedValue([])
    mocks.embedInitialize.mockResolvedValue(undefined)
    mocks.embed.mockResolvedValue([0.1, 0.2])
    mocks.embedBatch.mockResolvedValue([])
    mocks.validateFilePath.mockResolvedValue(undefined)
    // Default-path stubs: return a parse result so the positive `undefined`/
    // `false` cases reach `buildChunksAndEmbeddings` without crashing first.
    mocks.parseFile.mockResolvedValue({ content: 'plain content', title: 'plain title' })
    mocks.parsePdf.mockResolvedValue({ content: 'pdf content', title: 'pdf title' })
    // Visual-path stubs: `parsePdfPages` returns a doc with a `destroy()` spy
    // so the `finally` block can call it; `enrichPagesWithCaptions` returns
    // the pages unchanged.
    mocks.parsePdfPages.mockResolvedValue({
      doc: { destroy: vi.fn() },
      metadataTitle: undefined,
      pages: [{ pageNum: 1, text: 'page 1 text', stextJson: { blocks: [] } }],
    })
    mocks.enrichPagesWithCaptions.mockImplementation(async (pages: unknown) => ({
      pages,
      captions: [],
    }))
    mocks.detectVisualCandidates.mockReturnValue([])
    mocks.createCaptioner.mockReturnValue({ caption: vi.fn().mockResolvedValue(null) })
    // Default chunker behavior — return a single chunk so the handler does NOT
    // fail-fast on zero chunks. The positive cases reach persistence stubs.
    mocks.chunkText.mockResolvedValue([{ text: 'chunk 0 text', index: 0 }])
    mocks.embedBatch.mockResolvedValue([[0.1, 0.2]])
  })

  // AC-012: "handleIngestFile rejects args.visual values that are neither
  //         undefined nor a boolean with McpError(ErrorCode.InvalidParams,
  //         \"'visual' must be a boolean if provided\"). Tested with
  //         visual: 'true' (string), visual: 1 (number), visual: null."
  // ROI: 49 (BV:7 × Freq:3 + Legal:0 + Defect:7)
  // Behavior: Non-boolean `visual` → McpError(InvalidParams) before any I/O
  // Verification items (one parametrized case per invalid value):
  //   - Error thrown is McpError
  //   - ErrorCode === InvalidParams
  //   - Message includes "'visual' must be a boolean if provided"
  //   - No parser/chunker/embedder/vectorStore method was reached
  // @category: edge-case
  // @lane: integration
  // @dependency: handleIngestFile, defensive stubs (must NOT be called)
  // @complexity: low
  it("AC-012: handleIngestFile throws McpError(InvalidParams) when visual === 'true' (string)", async () => {
    // Arrange
    const server = buildServer()

    // Act
    let caught: unknown
    try {
      await server.handleIngestFile({
        filePath: FIXTURE_PDF_PATH,
        visual: 'true',
      } as unknown as { filePath: string })
    } catch (error) {
      caught = error
    }

    // Assert: error shape
    expect(caught).toBeInstanceOf(McpError)
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams)
    expect((caught as McpError).message).toContain(INVALID_PARAMS_MESSAGE)

    // Assert: no downstream side effect (validation short-circuited)
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    expect(mocks.parseFile).toHaveBeenCalledTimes(0)
    expect(mocks.chunkText).toHaveBeenCalledTimes(0)
    expect(mocks.embedBatch).toHaveBeenCalledTimes(0)
    expect(mocks.deleteChunks).toHaveBeenCalledTimes(0)
    expect(mocks.insertChunks).toHaveBeenCalledTimes(0)
  })

  it('AC-012: handleIngestFile throws McpError(InvalidParams) when visual === 1 (number)', async () => {
    // Arrange
    const server = buildServer()

    // Act
    let caught: unknown
    try {
      await server.handleIngestFile({
        filePath: FIXTURE_PDF_PATH,
        visual: 1,
      } as unknown as { filePath: string })
    } catch (error) {
      caught = error
    }

    // Assert: error shape
    expect(caught).toBeInstanceOf(McpError)
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams)
    expect((caught as McpError).message).toContain(INVALID_PARAMS_MESSAGE)

    // Assert: no downstream side effect
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    expect(mocks.parseFile).toHaveBeenCalledTimes(0)
    expect(mocks.chunkText).toHaveBeenCalledTimes(0)
    expect(mocks.embedBatch).toHaveBeenCalledTimes(0)
    expect(mocks.deleteChunks).toHaveBeenCalledTimes(0)
    expect(mocks.insertChunks).toHaveBeenCalledTimes(0)
  })

  it('AC-012: handleIngestFile throws McpError(InvalidParams) when visual === null', async () => {
    // Arrange
    const server = buildServer()

    // Act
    let caught: unknown
    try {
      await server.handleIngestFile({
        filePath: FIXTURE_PDF_PATH,
        visual: null,
      } as unknown as { filePath: string })
    } catch (error) {
      caught = error
    }

    // Assert: error shape
    expect(caught).toBeInstanceOf(McpError)
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams)
    expect((caught as McpError).message).toContain(INVALID_PARAMS_MESSAGE)

    // Assert: no downstream side effect
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    expect(mocks.parseFile).toHaveBeenCalledTimes(0)
    expect(mocks.chunkText).toHaveBeenCalledTimes(0)
    expect(mocks.embedBatch).toHaveBeenCalledTimes(0)
    expect(mocks.deleteChunks).toHaveBeenCalledTimes(0)
    expect(mocks.insertChunks).toHaveBeenCalledTimes(0)
  })

  // AC-012 (positive — validation does NOT fire for valid values):
  // ROI: 28 (BV:7 × Freq:4 + Legal:0 + Defect:0)
  // Behavior: undefined / true / false → no validation error; the call proceeds
  //           into the dispatch (parser etc.).
  // Verification items:
  //   - No McpError(InvalidParams) thrown specifically for `visual` shape
  //   - For visual === undefined and visual === false, the default-path parser
  //     (parser.parsePdf for PDFs, parser.parseFile for non-PDFs) is reached
  //   - For visual === true on a `.pdf`, the visual-path parser
  //     (parser.parsePdfPages) is reached
  // @category: edge-case
  // @lane: integration
  // @dependency: handleIngestFile
  // @complexity: low
  it('AC-012 (positive): handleIngestFile dispatches to the default PDF path when visual is undefined', async () => {
    // Arrange
    const server = buildServer()

    // Act: omit `visual` from args (undefined) — must NOT throw InvalidParams
    await server.handleIngestFile({ filePath: FIXTURE_PDF_PATH })

    // Assert: default PDF parser reached; visual parser NOT reached
    expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
    expect(mocks.parsePdf).toHaveBeenCalledWith(FIXTURE_PDF_PATH, expect.anything())
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
  })

  it('AC-012 (positive): handleIngestFile dispatches to the default PDF path when visual === false', async () => {
    // Arrange
    const server = buildServer()

    // Act
    await server.handleIngestFile({
      filePath: FIXTURE_PDF_PATH,
      visual: false,
    } as unknown as { filePath: string })

    // Assert: default PDF parser reached; visual parser NOT reached
    expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
    expect(mocks.parsePdf).toHaveBeenCalledWith(FIXTURE_PDF_PATH, expect.anything())
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
  })

  it('AC-012 (positive): handleIngestFile dispatches to the non-PDF default path when visual === false on a .md file', async () => {
    // Arrange
    const server = buildServer()

    // Act
    await server.handleIngestFile({
      filePath: FIXTURE_NON_PDF_PATH,
      visual: false,
    } as unknown as { filePath: string })

    // Assert: non-PDF parser reached
    expect(mocks.parseFile).toHaveBeenCalledTimes(1)
    expect(mocks.parseFile).toHaveBeenCalledWith(FIXTURE_NON_PDF_PATH)
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
  })

  it('AC-012 (positive): handleIngestFile dispatches to the visual path when visual === true on a .pdf', async () => {
    // Arrange
    const server = buildServer()

    // Act
    await server.handleIngestFile({
      filePath: FIXTURE_PDF_PATH,
      visual: true,
    } as unknown as { filePath: string })

    // Assert: visual parser reached; default PDF parser NOT reached
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(1)
    expect(mocks.parsePdfPages).toHaveBeenCalledWith(FIXTURE_PDF_PATH, expect.anything())
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
    // pdf-visual barrel exports were invoked
    expect(mocks.createCaptioner).toHaveBeenCalledTimes(1)
    expect(mocks.detectVisualCandidates).toHaveBeenCalledTimes(1)
    expect(mocks.enrichPagesWithCaptions).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// `visualQuality` boundary validation + normalization
// =============================================================================
//
// The MCP boundary receives `unknown`, so the JSON Schema enum is necessary
// but not sufficient. Accepted inputs at the boundary: undefined, "", "fast",
// "quality" (with undefined and "" normalized to "fast"); any other value
// fails fast with McpError(InvalidParams) before reaching the captioner.
const QUALITY_INVALID_MESSAGE = "'visualQuality' must be 'fast' or 'quality' if provided"

describe('handleIngestFile - `visualQuality` Runtime Validation', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../parser/index.js', parserFactory)
    vi.doMock('../../chunker/index.js', chunkerFactory)
    vi.doMock('../../embedder/index.js', embedderFactory)
    vi.doMock('../../vectordb/index.js', vectordbFactory)
    vi.doMock('../../pdf-visual/index.js', pdfVisualFactory)
    const mod = await import('../../server/index.js')
    RAGServer = mod.RAGServer as RAGServerCtor
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initialize.mockResolvedValue(undefined)
    mocks.deleteChunks.mockResolvedValue(undefined)
    mocks.optimize.mockResolvedValue(undefined)
    mocks.listFiles.mockResolvedValue([])
    mocks.search.mockResolvedValue([])
    mocks.embedInitialize.mockResolvedValue(undefined)
    mocks.embed.mockResolvedValue([0.1, 0.2])
    mocks.embedBatch.mockResolvedValue([[0.1, 0.2]])
    mocks.validateFilePath.mockResolvedValue(undefined)
    mocks.parseFile.mockResolvedValue({ content: 'plain content', title: 'plain title' })
    mocks.parsePdf.mockResolvedValue({ content: 'pdf content', title: 'pdf title' })
    mocks.parsePdfPages.mockResolvedValue({
      doc: { destroy: vi.fn() },
      metadataTitle: undefined,
      pages: [{ pageNum: 1, text: 'page 1 text', stextJson: { blocks: [] } }],
    })
    mocks.enrichPagesWithCaptions.mockImplementation(async (pages: unknown) => ({
      pages,
      captions: [],
    }))
    mocks.detectVisualCandidates.mockReturnValue([])
    mocks.createCaptioner.mockReturnValue({ caption: vi.fn().mockResolvedValue(null) })
    mocks.chunkText.mockResolvedValue([{ text: 'chunk 0 text', index: 0 }])
  })

  it("rejects visualQuality === 'high' with McpError(InvalidParams)", async () => {
    const server = buildServer()
    let caught: unknown
    try {
      await server.handleIngestFile({
        filePath: FIXTURE_PDF_PATH,
        visual: true,
        visualQuality: 'high',
      } as unknown as { filePath: string })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpError)
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams)
    expect((caught as McpError).message).toContain(QUALITY_INVALID_MESSAGE)
    // Validation short-circuited before any downstream work.
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    expect(mocks.createCaptioner).toHaveBeenCalledTimes(0)
  })

  it('rejects non-string visualQuality (number) with McpError(InvalidParams)', async () => {
    const server = buildServer()
    let caught: unknown
    try {
      await server.handleIngestFile({
        filePath: FIXTURE_PDF_PATH,
        visual: true,
        visualQuality: 1,
      } as unknown as { filePath: string })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpError)
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams)
  })

  it('normalizes visualQuality === "" to "fast" without throwing (empty-string MCP convention)', async () => {
    const server = buildServer()
    await server.handleIngestFile({
      filePath: FIXTURE_PDF_PATH,
      visual: true,
      visualQuality: '',
    } as unknown as { filePath: string })
    // Reached the visual dispatch path → captioner constructed with the
    // normalized 'fast' profile (empty string did NOT propagate).
    expect(mocks.createCaptioner).toHaveBeenCalledTimes(1)
    const captionerConfig = mocks.createCaptioner.mock.calls[0]?.[0] as { profile?: unknown }
    expect(captionerConfig?.profile).toBe('fast')
  })

  it("forwards visualQuality === 'quality' to createCaptioner", async () => {
    const server = buildServer()
    await server.handleIngestFile({
      filePath: FIXTURE_PDF_PATH,
      visual: true,
      visualQuality: 'quality',
    } as unknown as { filePath: string })
    expect(mocks.createCaptioner).toHaveBeenCalledTimes(1)
    const captionerConfig = mocks.createCaptioner.mock.calls[0]?.[0] as { profile?: unknown }
    expect(captionerConfig?.profile).toBe('quality')
  })

  it("defaults to 'fast' when visualQuality is absent (undefined)", async () => {
    const server = buildServer()
    await server.handleIngestFile({
      filePath: FIXTURE_PDF_PATH,
      visual: true,
    } as unknown as { filePath: string })
    expect(mocks.createCaptioner).toHaveBeenCalledTimes(1)
    const captionerConfig = mocks.createCaptioner.mock.calls[0]?.[0] as { profile?: unknown }
    expect(captionerConfig?.profile).toBe('fast')
  })
})
