// VLM PDF Enrichment - Default-Mode Invariance Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-001 (default-mode unchanged + NFR-1 sentinel)
// Test Type: Integration Test (in-process cli ingest dispatch + server handler)
// Implementation Timing: Phase 4 (alongside dispatch-site wiring)
//
// Lane: integration. Justification: AC-001 default-mode invariance + NFR-1
// Proxy sentinel witness — must run end-to-end through both dispatch sites.
//
// vi.hoisted note: This file MUST use vi.hoisted for the pdf-visual Proxy
// sentinel because vitest is configured with isolate: false
// (vitest.config.mjs:16-18) for onnxruntime-node compatibility. Without
// vi.hoisted the sentinel state may leak across files. The Proxy sentinel
// installed here MUST NOT leak to ingest-visual.test.ts — that file installs
// its own real-shaped mock; see DD §Testing Strategy → NFR-1 probe.
//
// Test structure: both dispatch sites (server `handleIngestFile` and CLI
// `ingestSingleFile`) must satisfy NFR-1. Two variants per site:
//   (a) generic fixture PDF (default content shape)
//   (b) figure-heavy PDF (adversarial — the mocked parser returns content
//       that mentions figures/tables/captions, making it the worst case for
//       accidental dynamic import of pdf-visual on the default path).
// Both variants assert the same NFR-1 invariant: `accessed.touched === false`.
// Chunk-row output is asserted against literal expected values produced by
// the deterministically-mocked chunker + embedder.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================
//
// NFR-1 negative sentinel: any property access on src/pdf-visual/index.js
// flips `accessed.touched` to true. The default-mode path must never reach
// this object. See DD §Integration Points → "src/pdf-visual/* import
// discipline (normative)" — dispatch sites use dynamic import only when
// args.visual === true && filePath.endsWith('.pdf').

const accessed = vi.hoisted(() => ({
  touched: false,
  prop: undefined as string | symbol | undefined,
}))

const mocks = vi.hoisted(() => {
  return {
    // ---------------- Parser ----------------
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
    embedBatch: vi.fn(),

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
  }
})

// NOTE: vi.mock factories used to live at module top-level. Under
// `isolate: false` they were hoisted into the *shared* module registry and
// leaked to unrelated test files (e.g. `src/__tests__/server/ingest-data.test.ts`)
// that import real parser/chunker/embedder/vectordb. We now install the same
// factories with `vi.doMock` inside `beforeAll` so they are scoped to the
// dynamic import below, and we `vi.doUnmock` them in `afterAll` to clear the
// registry before sibling files load.
//
// Factory definitions are kept as functions so they can be passed to both
// `vi.doMock` (in beforeAll) and to local tests if needed.

const pdfVisualFactory = () =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        accessed.touched = true
        accessed.prop = prop
        return undefined
      },
    }
  )

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

const MOCKED_PATHS = [
  '../../pdf-visual/index.js',
  '../../parser/index.js',
  '../../chunker/index.js',
  '../../embedder/index.js',
  '../../vectordb/index.js',
] as const

// ============================================
// Imports (after mocks)
// ============================================
//
// RAGServer + ingestSingleFile are loaded dynamically inside beforeAll AFTER
// vi.resetModules() so this file's vi.mock factories are applied when
// server/index.js and cli/ingest.js (and their transitive dependencies) are
// re-evaluated.

type RAGServerCtor = typeof import('../../server/index.js').RAGServer
type IngestSingleFile = typeof import('../../cli/ingest.js').ingestSingleFile
type DocumentParserCtor = typeof import('../../parser/index.js').DocumentParser
type SemanticChunkerCtor = typeof import('../../chunker/index.js').SemanticChunker
type EmbedderCtor = typeof import('../../embedder/index.js').Embedder
type VectorStoreCtor = typeof import('../../vectordb/index.js').VectorStore

let RAGServer: RAGServerCtor
let ingestSingleFile: IngestSingleFile
let DocumentParser: DocumentParserCtor
let SemanticChunker: SemanticChunkerCtor
let Embedder: EmbedderCtor
let VectorStore: VectorStoreCtor

// ============================================
// Fixtures
// ============================================

const GENERIC_PDF_PATH = '/tmp/test/default-mode-generic.pdf'
const FIGURE_HEAVY_PDF_PATH = '/tmp/test/default-mode-figure-heavy.pdf'

// Variant (a): generic content — no figure references.
const GENERIC_PDF_CONTENT = 'plain pdf content for default-mode test'
const GENERIC_PDF_TITLE = 'Generic Test Document'

// Variant (b): figure-heavy content — names figures, tables, captions so the
// adversarial intent is visible in the fixture. The dispatch site MUST still
// stay on the default branch because `visual` is omitted.
const FIGURE_HEAVY_PDF_CONTENT =
  'Figure 1: Architecture diagram. Table 2: Benchmark results. ' +
  'See caption below the inset image for details.'
const FIGURE_HEAVY_PDF_TITLE = 'Figure-Heavy Test Document'

// Deterministic chunker output — exactly 2 chunks regardless of input text.
// Mirrors the shape used by `src/__tests__/cli/ingest.test.ts:163-167`.
const EXPECTED_CHUNKS = [
  { text: 'chunk 1', index: 0 },
  { text: 'chunk 2', index: 1 },
]
const EXPECTED_EMBEDDINGS = [
  [0.1, 0.2],
  [0.3, 0.4],
]

function buildServer(): InstanceType<RAGServerCtor> {
  return new RAGServer({
    dbPath: '/tmp/test/default-mode-db',
    modelName: 'mock-model',
    cacheDir: '/tmp/test/default-mode-cache',
    baseDir: '/tmp/test',
    maxFileSize: 1024 * 1024,
    device: 'cpu',
  })
}

// ============================================
// Tests
// ============================================

describe('VLM PDF Enrichment - Default Mode (no --visual)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../pdf-visual/index.js', pdfVisualFactory)
    vi.doMock('../../parser/index.js', parserFactory)
    vi.doMock('../../chunker/index.js', chunkerFactory)
    vi.doMock('../../embedder/index.js', embedderFactory)
    vi.doMock('../../vectordb/index.js', vectordbFactory)
    const serverMod = await import('../../server/index.js')
    RAGServer = serverMod.RAGServer
    const cliMod = await import('../../cli/ingest.js')
    ingestSingleFile = cliMod.ingestSingleFile
    const parserMod = await import('../../parser/index.js')
    DocumentParser = parserMod.DocumentParser
    const chunkerMod = await import('../../chunker/index.js')
    SemanticChunker = chunkerMod.SemanticChunker
    const embedderMod = await import('../../embedder/index.js')
    Embedder = embedderMod.Embedder
    const vectordbMod = await import('../../vectordb/index.js')
    VectorStore = vectordbMod.VectorStore
  })

  beforeEach(() => {
    // Reset sentinel — load-bearing for NFR-1 invariance per variant.
    accessed.touched = false
    accessed.prop = undefined

    vi.clearAllMocks()
    // Restore safe defaults after vi.clearAllMocks() wipes them.
    mocks.initialize.mockResolvedValue(undefined)
    mocks.deleteChunks.mockResolvedValue(undefined)
    mocks.optimize.mockResolvedValue(undefined)
    mocks.listFiles.mockResolvedValue([])
    mocks.search.mockResolvedValue([])
    mocks.embedInitialize.mockResolvedValue(undefined)
    mocks.embed.mockResolvedValue([0.1, 0.2])
    mocks.embedBatch.mockResolvedValue(EXPECTED_EMBEDDINGS)
    mocks.insertChunks.mockResolvedValue(undefined)
    mocks.validateFilePath.mockResolvedValue(undefined)
    mocks.chunkText.mockResolvedValue(EXPECTED_CHUNKS)
  })

  afterAll(() => {
    accessed.touched = false
    accessed.prop = undefined
    // Unregister the mocks installed in beforeAll so they cannot leak to
    // sibling files via the shared module registry under `isolate: false`.
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  // AC-001: "With no --visual flag and no `visual` argument, ingesting a PDF
  //         produces chunks identical to the pre-change baseline (same chunk
  //         count, same chunk text rows in order). No VLM model is downloaded.
  //         A vi.mock-installed sentinel for src/pdf-visual/index.ts records
  //         that no export of that module is accessed during the default-mode
  //         ingest call."
  // ROI: 109 (BV:10 × Freq:10 + Legal:0 + Defect:9)
  // Behavior: Ingest PDF without visual flag → chunks match golden +
  //           pdf-visual module is never touched
  // Verification items:
  //   - Resulting chunk text rows equal EXPECTED_CHUNKS (literal fixture)
  //   - Chunk count matches the deterministic mocked chunker output
  //   - `accessed.touched` is false after the ingest call
  //   - parser.parsePdf was invoked (default PDF path), parsePdfPages was NOT
  //   - Insertion received the literal expected chunk rows
  // @category: core-functionality
  // @lane: integration
  // @dependency: ingestSingleFile, RAGServer.handleIngestFile, parser, chunker, embedder, vectorStore (all mocked) + pdf-visual (Proxy sentinel)
  // @complexity: medium
  describe('AC-001: default-mode ingest produces golden chunks and never touches pdf-visual', () => {
    it('handleIngestFile: generic PDF default path keeps pdf-visual untouched', async () => {
      // Arrange
      mocks.parsePdf.mockResolvedValue({
        content: GENERIC_PDF_CONTENT,
        title: GENERIC_PDF_TITLE,
      })
      const server = buildServer()

      // Act
      await server.handleIngestFile({ filePath: GENERIC_PDF_PATH })

      // Assert: NFR-1 sentinel — pdf-visual NEVER touched on default path
      expect(accessed.touched).toBe(false)
      expect(accessed.prop).toBeUndefined()

      // Assert: default PDF parser reached; visual parser NOT reached
      expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
      expect(mocks.parsePdf).toHaveBeenCalledWith(GENERIC_PDF_PATH, expect.anything())
      expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)

      // Assert: literal expected chunk rows persisted
      expect(mocks.insertChunks).toHaveBeenCalledTimes(1)
      const insertedChunks = mocks.insertChunks.mock.calls[0]?.[0] as Array<{
        text: string
        chunkIndex: number
        filePath: string
        vector: number[]
      }>
      expect(insertedChunks).toHaveLength(2)
      expect(insertedChunks[0]?.text).toBe('chunk 1')
      expect(insertedChunks[0]?.chunkIndex).toBe(0)
      expect(insertedChunks[0]?.filePath).toBe(GENERIC_PDF_PATH)
      expect(insertedChunks[0]?.vector).toEqual([0.1, 0.2])
      expect(insertedChunks[1]?.text).toBe('chunk 2')
      expect(insertedChunks[1]?.chunkIndex).toBe(1)
      expect(insertedChunks[1]?.vector).toEqual([0.3, 0.4])
    })

    it('ingestSingleFile: generic PDF default path keeps pdf-visual untouched', async () => {
      // Arrange
      mocks.parsePdf.mockResolvedValue({
        content: GENERIC_PDF_CONTENT,
        title: GENERIC_PDF_TITLE,
      })
      const parser = new DocumentParser({ baseDir: '/tmp/test', maxFileSize: 1024 * 1024 })
      const chunker = new SemanticChunker({})
      const embedder = new Embedder({
        modelPath: 'mock-model',
        batchSize: 16,
        cacheDir: '/tmp/test/cache',
      })
      const vectorStore = new VectorStore({ dbPath: '/tmp/test/db', tableName: 'chunks' })

      // Act — omit `visual` entirely (default mode). `ingestSingleFile`'s
      // dispatch branch requires `options.visual === true && isPdf` to load
      // pdf-visual; omitting the options bag exercises the strict default.
      const chunkCount = await ingestSingleFile(
        GENERIC_PDF_PATH,
        parser,
        chunker,
        embedder,
        vectorStore
      )

      // Assert: NFR-1 sentinel
      expect(accessed.touched).toBe(false)
      expect(accessed.prop).toBeUndefined()

      // Assert: default PDF parser reached; visual parser NOT reached
      expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
      expect(mocks.parsePdf).toHaveBeenCalledWith(GENERIC_PDF_PATH, expect.anything())
      expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)

      // Assert: chunk count matches deterministic mocked output
      expect(chunkCount).toBe(2)

      // Assert: literal expected chunk rows persisted
      expect(mocks.insertChunks).toHaveBeenCalledTimes(1)
      const insertedChunks = mocks.insertChunks.mock.calls[0]?.[0] as Array<{
        text: string
        chunkIndex: number
        filePath: string
        vector: number[]
      }>
      expect(insertedChunks).toHaveLength(2)
      expect(insertedChunks[0]?.text).toBe('chunk 1')
      expect(insertedChunks[0]?.chunkIndex).toBe(0)
      expect(insertedChunks[0]?.filePath).toBe(GENERIC_PDF_PATH)
      expect(insertedChunks[0]?.vector).toEqual([0.1, 0.2])
      expect(insertedChunks[1]?.text).toBe('chunk 2')
      expect(insertedChunks[1]?.chunkIndex).toBe(1)
      expect(insertedChunks[1]?.vector).toEqual([0.3, 0.4])
    })

    it('ingestSingleFile: explicit visual: false on PDF keeps pdf-visual untouched', async () => {
      // Arrange — verify the dispatch branch's truthy check, not just absence.
      // `options.visual === true` is the gate; `false` must take the default
      // branch identically to `undefined`.
      mocks.parsePdf.mockResolvedValue({
        content: GENERIC_PDF_CONTENT,
        title: GENERIC_PDF_TITLE,
      })
      const parser = new DocumentParser({ baseDir: '/tmp/test', maxFileSize: 1024 * 1024 })
      const chunker = new SemanticChunker({})
      const embedder = new Embedder({
        modelPath: 'mock-model',
        batchSize: 16,
        cacheDir: '/tmp/test/cache',
      })
      const vectorStore = new VectorStore({ dbPath: '/tmp/test/db', tableName: 'chunks' })

      // Act
      await ingestSingleFile(GENERIC_PDF_PATH, parser, chunker, embedder, vectorStore, {
        visual: false,
      })

      // Assert: NFR-1 sentinel — false is equivalent to undefined on the
      // default path
      expect(accessed.touched).toBe(false)
      expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
      expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    })
  })

  // AC-001 (NFR-1 strict): even if the file is a PDF that WOULD have visual
  // candidates, the default path must not reach into pdf-visual. This is the
  // adversarial form of the sentinel assertion — a fixture chosen to be the
  // worst case for accidental dynamic import.
  // ROI: 88 (BV:9 × Freq:8 + Legal:0 + Defect:8) — variant of AC-001
  // Behavior: Ingest figure-heavy PDF without visual flag → sentinel stays false
  // @category: core-functionality
  // @lane: integration
  // @dependency: ingestSingleFile, RAGServer.handleIngestFile, pdf-visual (Proxy sentinel)
  // @complexity: medium
  describe('AC-001 (NFR-1 strict): figure-heavy PDF in default mode does not trigger pdf-visual dynamic import', () => {
    it('handleIngestFile: figure-heavy PDF default path keeps pdf-visual untouched', async () => {
      // Arrange — parser is mocked, so the "figure-heavy" nature lives in the
      // content string. The dispatch decision is purely based on `visual`
      // (omitted) and file extension (.pdf), so this is the adversarial case:
      // a reader inspecting the fixture sees content that screams "VLM-ready",
      // yet the default branch must not reach pdf-visual.
      mocks.parsePdf.mockResolvedValue({
        content: FIGURE_HEAVY_PDF_CONTENT,
        title: FIGURE_HEAVY_PDF_TITLE,
      })
      const server = buildServer()

      // Act
      await server.handleIngestFile({ filePath: FIGURE_HEAVY_PDF_PATH })

      // Assert: NFR-1 strict — sentinel untouched even on adversarial fixture
      expect(accessed.touched).toBe(false)
      expect(accessed.prop).toBeUndefined()

      // Assert: default PDF parser reached; visual parser NOT reached
      expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
      expect(mocks.parsePdf).toHaveBeenCalledWith(FIGURE_HEAVY_PDF_PATH, expect.anything())
      expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)

      // Assert: chunks produced (count > 0 per task)
      expect(mocks.insertChunks).toHaveBeenCalledTimes(1)
      const insertedChunks = mocks.insertChunks.mock.calls[0]?.[0] as Array<unknown>
      expect(insertedChunks.length).toBeGreaterThan(0)
      expect(insertedChunks).toHaveLength(2)
    })

    it('ingestSingleFile: figure-heavy PDF default path keeps pdf-visual untouched', async () => {
      // Arrange
      mocks.parsePdf.mockResolvedValue({
        content: FIGURE_HEAVY_PDF_CONTENT,
        title: FIGURE_HEAVY_PDF_TITLE,
      })
      const parser = new DocumentParser({ baseDir: '/tmp/test', maxFileSize: 1024 * 1024 })
      const chunker = new SemanticChunker({})
      const embedder = new Embedder({
        modelPath: 'mock-model',
        batchSize: 16,
        cacheDir: '/tmp/test/cache',
      })
      const vectorStore = new VectorStore({ dbPath: '/tmp/test/db', tableName: 'chunks' })

      // Act — omit visual entirely
      const chunkCount = await ingestSingleFile(
        FIGURE_HEAVY_PDF_PATH,
        parser,
        chunker,
        embedder,
        vectorStore
      )

      // Assert: NFR-1 strict — sentinel untouched
      expect(accessed.touched).toBe(false)
      expect(accessed.prop).toBeUndefined()

      // Assert: default PDF parser reached; visual parser NOT reached
      expect(mocks.parsePdf).toHaveBeenCalledTimes(1)
      expect(mocks.parsePdf).toHaveBeenCalledWith(FIGURE_HEAVY_PDF_PATH, expect.anything())
      expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)

      // Assert: chunks produced (count > 0 per task)
      expect(chunkCount).toBe(2)
      expect(mocks.insertChunks).toHaveBeenCalledTimes(1)
    })
  })
})
