// VLM PDF Enrichment - handleIngestFile Side Effects Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-008a (Phase 0 — server wrapper side effects preserved:
//                  McpError on zero chunks, backup/rollback on insert failure,
//                  vectorStore.optimize() invocation on success)
// Test Type: Integration Test (in-process server handler)
// Implementation Timing: Phase 0 (must pass before Phase 4 wiring)
//
// Lane: integration. Justification: AC-008a witness for the server wrapper's
// side effects — separate from the cross-path equivalence concern covered by
// ingest-cross-path-equivalence.test.ts. Both files are named explicitly by the
// DD §Existing Codebase Analysis → Implementation Path Mapping.
//
// Mocking strategy (must read before changing this file):
//   Required by `isolate: false` (vitest.config.mjs:18): module mocks can
//   leak across files in the shared pool, so each replacement must be
//   STRUCTURALLY COMPLETE — every public method of the real class is
//   present as a `vi.fn()` with a sensible default. If a mock leaks to
//   `rag-server.search.integration.test.ts` or similar, that file's calls
//   receive behaviorally-correct stubs.
//
//   RAGServer is loaded dynamically inside `beforeAll` AFTER
//   `vi.resetModules()` so this file's `vi.mock` factories are applied
//   when `server/index.js` (and its transitive dependencies) are
//   re-evaluated. Without this, an earlier test file in the same pool
//   (e.g., `ingest-data.test.ts`) that loaded `server/index.js` with
//   real dependencies would leave a cached version that ignores our
//   mocks.

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // ---------------- Parser ----------------
    // Real DocumentParser methods: validateFilePath, validateFileSize,
    // parseFile, parsePdf. Every method is present on the mock so a
    // leaked replacement still satisfies callers.
    parseFile: vi.fn(),
    parsePdf: vi.fn(),
    validateFilePath: vi.fn().mockResolvedValue(undefined),
    validateFileSize: vi.fn(),

    // ---------------- Chunker ----------------
    chunkText: vi.fn(),

    // ---------------- Embedder ----------------
    // Real Embedder methods: initialize, embed, embedBatch. All present.
    embedInitialize: vi.fn().mockResolvedValue(undefined),
    embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    embedBatch: vi.fn().mockResolvedValue([]),

    // ---------------- VectorStore ----------------
    // Real VectorStore methods: initialize, deleteChunks, getChunksByRange,
    // getChunksByFilePath, insertChunks, optimize, search, listFiles,
    // getStatus. All present.
    initialize: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn(),
    search: vi.fn(),
    getChunksByFilePath: vi.fn().mockResolvedValue([]),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
    insertChunks: vi.fn(),
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

// NOTE: factories are installed via `vi.doMock` in `beforeAll` and removed
// via `vi.doUnmock` in `afterAll`, so they cannot leak to sibling test files
// through the shared module registry under `isolate: false`.

const parserFactory = async (
  importOriginal: () => Promise<typeof import('../../parser/index.js')>
) => {
  const actual = await importOriginal()
  return {
    // Spread the real module so error classes (ValidationError,
    // FileOperationError) remain exported — server/index.js imports
    // ValidationError from this module and uses it in `instanceof` checks.
    ...actual,
    DocumentParser: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.parseFile = mocks.parseFile
      this.parsePdf = mocks.parsePdf
      this.validateFilePath = mocks.validateFilePath
      this.validateFileSize = mocks.validateFileSize
    }),
    SUPPORTED_EXTENSIONS: new Set(['.pdf', '.docx', '.txt', '.md']),
  }
}

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
      this.getChunksByFilePath = mocks.getChunksByFilePath
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
  '../../parser/index.js',
  '../../chunker/index.js',
  '../../embedder/index.js',
  '../../vectordb/index.js',
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

const FIXTURE_FILE_PATH = '/tmp/test/handleingestfile-side-effects.md'
const FIXTURE_TEXT = 'Fixture content for handleIngestFile side-effects test.'
const FIXTURE_TITLE = 'Side Effects Fixture'
const FIXTURE_EMBEDDINGS = [
  [0.5, 0.6],
  [0.7, 0.8],
]

function buildServer(): InstanceType<RAGServerCtor> {
  return new RAGServer({
    dbPath: '/tmp/test/side-effects-db',
    modelName: 'mock-model',
    cacheDir: '/tmp/test/side-effects-cache',
    baseDir: '/tmp/test',
    maxFileSize: 1024 * 1024,
    device: 'cpu',
  })
}

// ============================================
// Tests
// ============================================

describe('handleIngestFile - Phase 0 Wrapper Side Effects (AC-008a)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../parser/index.js', parserFactory)
    vi.doMock('../../chunker/index.js', chunkerFactory)
    vi.doMock('../../embedder/index.js', embedderFactory)
    vi.doMock('../../vectordb/index.js', vectordbFactory)
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
    mocks.parseFile.mockResolvedValue({ content: FIXTURE_TEXT, title: FIXTURE_TITLE })
    mocks.listFiles.mockResolvedValue([])
    mocks.search.mockResolvedValue([])
    mocks.getChunksByFilePath.mockResolvedValue([])
    mocks.getChunksByRange.mockResolvedValue([])
    mocks.getStatus.mockResolvedValue({
      documentCount: 0,
      chunkCount: 0,
      memoryUsage: 0,
      uptime: 0,
      ftsIndexEnabled: false,
      searchMode: 'vector-only' as const,
    })
    mocks.embedInitialize.mockResolvedValue(undefined)
    mocks.embed.mockResolvedValue([0.1, 0.2])
    mocks.validateFilePath.mockResolvedValue(undefined)
  })

  // AC-008a (a): "handleIngestFile continues to throw McpError when the
  //              produced chunk count is 0."
  it('AC-008a (a): handleIngestFile throws McpError when chunker produces zero chunks', async () => {
    // Arrange: chunker returns empty array → fail-fast path
    mocks.chunkText.mockResolvedValue([])
    mocks.embedBatch.mockResolvedValue([])
    const server = buildServer()

    // Act + Assert: McpError thrown
    let caught: unknown
    try {
      await server.handleIngestFile({ filePath: FIXTURE_FILE_PATH })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpError)
    expect((caught as McpError).code).toBe(ErrorCode.InvalidParams)

    // Assert: no persistence side effect fired (fail-fast happened BEFORE delete)
    expect(mocks.deleteChunks).toHaveBeenCalledTimes(0)
    expect(mocks.insertChunks).toHaveBeenCalledTimes(0)
    expect(mocks.optimize).toHaveBeenCalledTimes(0)
  })

  // AC-008a (b): "handleIngestFile backs up existing chunks (via
  //              vectorStore.getChunksByFilePath) before delete and re-inserts
  //              them on failure (backup/rollback)."
  it('AC-008a (b): handleIngestFile restores previously-indexed chunks when insertChunks fails', async () => {
    // Arrange: 2-chunk fixture
    mocks.chunkText.mockResolvedValue([
      { text: 'new chunk 0', index: 0 },
      { text: 'new chunk 1', index: 1 },
    ])
    mocks.embedBatch.mockResolvedValue(FIXTURE_EMBEDDINGS)

    // Arrange: pre-existing data — getChunksByFilePath returns the full prior
    // chunk (with its real stored vector) that the backup re-inserts verbatim
    // on rollback.
    const priorChunk = {
      id: 'prior-id-0',
      filePath: FIXTURE_FILE_PATH,
      chunkIndex: 0,
      text: 'previously-indexed chunk',
      vector: [0.11, 0.22],
      fileTitle: 'previous title',
      timestamp: '2025-01-01T00:00:00.000Z',
      metadata: {
        fileName: 'handleingestfile-side-effects.md',
        fileSize: 10,
        fileType: 'md',
      },
    }
    mocks.getChunksByFilePath.mockResolvedValue([priorChunk])

    // Arrange: induce insert failure on the FIRST insertChunks call only.
    // The second call (rollback re-insert) must succeed.
    const induced = new Error('induced insert failure')
    mocks.insertChunks.mockRejectedValueOnce(induced).mockResolvedValueOnce(undefined)

    const server = buildServer()

    // Act + Assert: the original insert error is surfaced (wrapped per handler contract)
    let caught: unknown
    try {
      await server.handleIngestFile({ filePath: FIXTURE_FILE_PATH })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(`Failed to ingest file: ${induced.message}`)

    // Assert: backup capture happened BEFORE delete.
    // mock.invocationCallOrder is a monotonically increasing global counter.
    const backupOrder = mocks.getChunksByFilePath.mock.invocationCallOrder[0]!
    const deleteOrder = mocks.deleteChunks.mock.invocationCallOrder[0]!
    expect(mocks.getChunksByFilePath).toHaveBeenCalledWith(FIXTURE_FILE_PATH)
    expect(backupOrder).toBeLessThan(deleteOrder)

    // Assert: deleteChunks called with the target filePath
    expect(mocks.deleteChunks).toHaveBeenCalledTimes(1)
    expect(mocks.deleteChunks).toHaveBeenCalledWith(FIXTURE_FILE_PATH)

    // Assert: insertChunks called exactly twice — first failed, second is rollback
    expect(mocks.insertChunks).toHaveBeenCalledTimes(2)

    // Assert: the rollback re-insert (second call) restored the exact pre-existing
    // chunk, including its real stored vector (not a dummy).
    const rollbackArg = mocks.insertChunks.mock.calls[1]?.[0] as Array<{
      filePath: string
      chunkIndex: number
      text: string
      vector: number[]
    }>
    expect(rollbackArg).toHaveLength(1)
    expect(rollbackArg[0]).toEqual(priorChunk)

    // Assert: optimize was called once during the rollback path (after the
    // successful rollback re-insert), but NOT on the success branch — verified
    // by call count.
    expect(mocks.optimize).toHaveBeenCalledTimes(1)
    const optimizeOrder = mocks.optimize.mock.invocationCallOrder[0]!
    const rollbackInsertOrder = mocks.insertChunks.mock.invocationCallOrder[1]!
    expect(optimizeOrder).toBeGreaterThan(rollbackInsertOrder)
  })

  // AC-008a (c): "handleIngestFile calls vectorStore.optimize() after a
  //              successful insert."
  it('AC-008a (c): handleIngestFile calls vectorStore.optimize() after a successful insert', async () => {
    // Arrange: 2-chunk fixture, successful path (no induced failure)
    mocks.chunkText.mockResolvedValue([
      { text: 'success chunk 0', index: 0 },
      { text: 'success chunk 1', index: 1 },
    ])
    mocks.embedBatch.mockResolvedValue(FIXTURE_EMBEDDINGS)
    mocks.insertChunks.mockResolvedValue(undefined)
    const server = buildServer()

    // Act
    const result = await server.handleIngestFile({ filePath: FIXTURE_FILE_PATH })

    // Assert: insertChunks called exactly once
    expect(mocks.insertChunks).toHaveBeenCalledTimes(1)

    // Assert: optimize called exactly once, AFTER insert
    expect(mocks.optimize).toHaveBeenCalledTimes(1)
    const insertOrder = mocks.insertChunks.mock.invocationCallOrder[0]!
    const optimizeOrder = mocks.optimize.mock.invocationCallOrder[0]!
    expect(optimizeOrder).toBeGreaterThan(insertOrder)

    // Assert: MCP response shape is the existing chunkCount JSON envelope
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type).toBe('text')
    const parsed = JSON.parse(result.content[0]!.text) as {
      filePath: string
      chunkCount: number
      fileTitle: string | null
    }
    expect(parsed.filePath).toBe(FIXTURE_FILE_PATH)
    expect(parsed.chunkCount).toBe(2)
    expect(parsed.fileTitle).toBe(FIXTURE_TITLE)
  })
})
