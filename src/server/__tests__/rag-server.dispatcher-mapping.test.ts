// Central dispatcher error-mapping tests (Task 04 — Phase 3 commit 2).
//
// Verifies the single try/catch wrapping the CallTool dispatcher routes every
// handler error through `toMcpError(error, context)` + `logError`, with each
// handler's client-message prefix policy preserved exactly (Contract-Delta
// per-handler table). The handlers themselves are gutted of error mapping and
// rethrow the caught error with its ORIGINAL identity.
//
// Test type: unit (spy-based). We inject failures at the adapter boundary
// (vectorStore / embedder / parser) and invoke the dispatcher closure directly
// via the SDK's `_requestHandlers` map, which is the boundary that owns the
// central mapping.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import type { Embedder } from '../../embedder/index.js'
import { EmbeddingError } from '../../embedder/index.js'
import { BaseDirsConfigError } from '../../utils/base-dirs.js'
import type { VectorStore } from '../../vectordb/index.js'
import { DatabaseError } from '../../vectordb/types.js'
import { RAGServer } from '../index.js'

type DispatchResult = { content: { type: string; text: string }[]; isError?: boolean }
type RegisteredHandler = (
  request: { method: string; params: { name: string; arguments?: unknown } },
  extra: { signal: AbortSignal }
) => Promise<DispatchResult>

// Typed accessor for the RAGServer internals exercised by these tests. Mirrors
// the `as unknown as { … }` private-access pattern used elsewhere in the server
// test suite (no `any`, kept local per the task scope boundary).
function internals(server: RAGServer): {
  server: { _requestHandlers: Map<string, RegisteredHandler> }
  embedder: Embedder
  vectorStore: VectorStore
} {
  return server as unknown as {
    server: { _requestHandlers: Map<string, RegisteredHandler> }
    embedder: Embedder
    vectorStore: VectorStore
  }
}

// Invoke the registered CallTool dispatcher closure directly. The SDK stores it
// in `_requestHandlers` keyed by the method literal 'tools/call' and parses the
// request against the schema before calling our closure (which holds the
// central try/catch).
function dispatch(server: RAGServer, name: string, args: unknown): Promise<DispatchResult> {
  const handler = internals(server).server._requestHandlers.get('tools/call')
  if (handler === undefined) throw new Error('tools/call handler not registered')
  return handler(
    { method: 'tools/call', params: { name, arguments: args } },
    { signal: new AbortController().signal }
  )
}

describe('Central dispatcher error mapping (AC-004/005/006/008)', () => {
  let server: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-dispatcher-map')
  const testDataDir = resolve('./tmp/test-data-dispatcher-map')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // ---- query_documents: prefix-less ----
  it('query_documents: maps an EmbeddingError to InternalError with NO prefix (raw message)', async () => {
    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embed').mockRejectedValue(new EmbeddingError('embedder exploded'))

    await expect(dispatch(server, 'query_documents', { query: 'hi' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
    })
    try {
      await dispatch(server, 'query_documents', { query: 'hi' })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err).toBeInstanceOf(McpError)
      expect(err.message).toContain('embedder exploded')
      expect(err.message).not.toContain('Failed to')
    }
  })

  // ---- ingest_file: prefix-keeping on a NATIVE error ----
  it('ingest_file: prepends "Failed to ingest file" to a native (non-AppError) error', async () => {
    const testFile = resolve(testDataDir, 'dispatch-ingest.txt')
    writeFileSync(testFile, 'Some ingestible content. '.repeat(40))
    // Fail at embedding (before any delete/insert) with a NATIVE error so it
    // propagates to the dispatcher prefix without touching the rollback path.
    vi.spyOn(internals(server).embedder, 'embedBatch').mockRejectedValue(new Error('disk full'))

    try {
      await dispatch(server, 'ingest_file', { filePath: testFile })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err).toBeInstanceOf(McpError)
      expect(err.code).toBe(ErrorCode.InternalError)
      expect(err.message).toContain('Failed to ingest file: disk full')
    }
  })

  // ---- ingest_data: prefix-keeping on a NATIVE error ----
  it('ingest_data: prepends "Failed to ingest data" to a native (non-AppError) error', async () => {
    // ingest_data calls handleIngestFile internally; a NATIVE error from the
    // embedder propagates with identity to the dispatcher, where the
    // TOOL_ERROR_CONTEXT['ingest_data'] prefix is applied via the central mapper.
    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embedBatch').mockRejectedValue(new Error('boom'))

    try {
      await dispatch(server, 'ingest_data', {
        content: 'Ingestible raw data. '.repeat(40),
        metadata: { source: 'dispatch-ingest-data-native', format: 'text' },
      })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err).toBeInstanceOf(McpError)
      expect(err.code).toBe(ErrorCode.InternalError)
      expect(err.message).toContain('Failed to ingest data: boom')
    }
  })

  // ---- delete_file: prefix-keeping on a NATIVE error ----
  it('delete_file: prepends "Failed to delete file" to a native (non-AppError) error', async () => {
    const testFile = resolve(testDataDir, 'dispatch-delete-native.txt')
    writeFileSync(testFile, 'Deletable content. '.repeat(40))
    // Ingest first so the file is a known target, then fail the delete with a
    // NATIVE error at the vector-store adapter boundary.
    await dispatch(server, 'ingest_file', { filePath: testFile })

    const vectorStore = internals(server).vectorStore
    vi.spyOn(vectorStore, 'deleteChunks').mockRejectedValue(new Error('boom'))

    try {
      await dispatch(server, 'delete_file', { filePath: testFile })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err).toBeInstanceOf(McpError)
      expect(err.code).toBe(ErrorCode.InternalError)
      expect(err.message).toContain('Failed to delete file: boom')
    }
  })

  it('ingest_file: an AppError (EmbeddingError) stays prefix-less even under the ingest_file context', async () => {
    const testFile = resolve(testDataDir, 'dispatch-ingest-app.txt')
    writeFileSync(testFile, 'Embeddable content. '.repeat(40))

    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embedBatch').mockRejectedValue(new EmbeddingError('Invalid RAG_DTYPE: q9'))

    try {
      await dispatch(server, 'ingest_file', { filePath: testFile })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err.code).toBe(ErrorCode.InternalError)
      expect(err.message).toContain('Invalid RAG_DTYPE: q9')
      expect(err.message).not.toContain('Failed to ingest file')
    }
  })

  // ---- read_chunk_neighbors: DatabaseError passthrough (no prefix) ----
  it('read_chunk_neighbors: DatabaseError maps to InternalError with NO prefix (raw passthrough)', async () => {
    const testFile = resolve(testDataDir, 'dispatch-neighbors.txt')
    writeFileSync(testFile, 'Neighbor content. '.repeat(40))
    await dispatch(server, 'ingest_file', { filePath: testFile })

    const vectorStore = internals(server).vectorStore
    vi.spyOn(vectorStore, 'getChunksByRange').mockRejectedValue(
      new DatabaseError('lancedb scan failed')
    )

    try {
      await dispatch(server, 'read_chunk_neighbors', { filePath: testFile, chunkIndex: 0 })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err.code).toBe(ErrorCode.InternalError)
      expect(err.message).toContain('lancedb scan failed')
      expect(err.message).not.toContain('Failed to read chunk neighbors')
    }
  })

  it('read_chunk_neighbors: a NATIVE error gets the "Failed to read chunk neighbors" prefix', async () => {
    const testFile = resolve(testDataDir, 'dispatch-neighbors-native.txt')
    writeFileSync(testFile, 'Neighbor native content. '.repeat(40))
    await dispatch(server, 'ingest_file', { filePath: testFile })

    const vectorStore = internals(server).vectorStore
    vi.spyOn(vectorStore, 'getChunksByRange').mockRejectedValue(new Error('unexpected boom'))

    try {
      await dispatch(server, 'read_chunk_neighbors', { filePath: testFile, chunkIndex: 0 })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err.code).toBe(ErrorCode.InternalError)
      expect(err.message).toContain('Failed to read chunk neighbors: unexpected boom')
    }
  })

  // ---- inline McpError(InvalidParams) passes through unchanged ----
  it('read_chunk_neighbors: inline McpError(InvalidParams) input validation passes through unchanged', async () => {
    try {
      await dispatch(server, 'read_chunk_neighbors', { filePath: '/x', chunkIndex: -1 })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err.code).toBe(ErrorCode.InvalidParams)
      expect(err.message).toContain('chunkIndex must be a non-negative integer')
    }
  })

  it('delete_file: inline McpError(InvalidParams) for missing input passes through unchanged', async () => {
    try {
      await dispatch(server, 'delete_file', {})
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err.code).toBe(ErrorCode.InvalidParams)
      expect(err.message).toContain('Either filePath or source must be provided')
    }
  })

  // ---- AC-008: DatabaseError cause reaches stderr ----
  it('query_documents: DatabaseError root cause appears in stderr logs, client message stays generic', async () => {
    const rootCause = new Error('LANCE_INTERNAL_DETAIL')
    const vectorStore = internals(server).vectorStore
    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embed').mockResolvedValue(new Array(384).fill(0))
    vi.spyOn(vectorStore, 'search').mockRejectedValue(
      new DatabaseError('Failed to search vectors', rootCause)
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await dispatch(server, 'query_documents', { query: 'anything' })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      // Client: generic DatabaseError message, NOT the internal cause.
      expect(err.message).toContain('Failed to search vectors')
      expect(err.message).not.toContain('LANCE_INTERNAL_DETAIL')
    }
    // stderr: the full cause chain, including the root cause.
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('LANCE_INTERNAL_DETAIL')
  })
})

// ---- Identity preservation + rollback side-effects (handlers gutted) ----
describe('Handler identity preservation + local rollback (AC-004)', () => {
  let server: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-identity')
  const testDataDir = resolve('./tmp/test-data-identity')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('handleIngestFile rethrows a typed AppError with ORIGINAL identity (no plain-Error conversion)', async () => {
    const testFile = resolve(testDataDir, 'identity-ingest.txt')
    writeFileSync(testFile, 'Identity content. '.repeat(40))
    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embedBatch').mockRejectedValue(new EmbeddingError('typed embed failure'))

    await expect(server.handleIngestFile({ filePath: testFile })).rejects.toBeInstanceOf(
      EmbeddingError
    )
  })

  it('handleQueryDocuments rethrows a DatabaseError with ORIGINAL identity', async () => {
    const embedder = internals(server).embedder
    const vectorStore = internals(server).vectorStore
    vi.spyOn(embedder, 'embed').mockResolvedValue(new Array(384).fill(0))
    vi.spyOn(vectorStore, 'search').mockRejectedValue(new DatabaseError('db identity'))

    await expect(server.handleQueryDocuments({ query: 'q' })).rejects.toBeInstanceOf(DatabaseError)
  })

  it('ingest_data rollback deletes the raw-data file when the inner ingest throws, and rethrows identity', async () => {
    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embedBatch').mockRejectedValue(new EmbeddingError('inner ingest failure'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      server.handleIngestData({
        content: 'rollback me '.repeat(20),
        metadata: { source: 'rollback-source-identity', format: 'text' },
      })
    ).rejects.toBeInstanceOf(EmbeddingError)

    // Rollback side-effect: the raw-data file removal path ran (logged), and no
    // "Failed to rollback" warning was emitted (unlink succeeded).
    const errLog = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(errLog).toContain('Rolled back raw-data file')
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to rollback raw-data file')
    )
  })
})

// ---- AC-007: config gate throws BaseDirsConfigError -> InvalidParams; status diagnostic block ----
describe('Config-gate central mapping + status diagnostic block (AC-007)', () => {
  const testDbPath = resolve('./tmp/test-lancedb-configgate')
  const testDataDir = resolve('./tmp/test-data-configgate')
  let server: RAGServer

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    const configError = new BaseDirsConfigError(
      'BASE_DIRS must be a JSON array of non-empty path strings.'
    )
    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDirs: [],
        maxFileSize: 100 * 1024 * 1024,
        configError,
      })
    )
    await server.initialize()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('list_files under config error: BaseDirsConfigError maps to InvalidParams centrally', async () => {
    try {
      await dispatch(server, 'list_files', {})
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err).toBeInstanceOf(McpError)
      expect(err.code).toBe(ErrorCode.InvalidParams)
      expect(err.message).toContain('BASE_DIRS must be a JSON array')
    }
  })

  it('status under config error: returns a diagnostic content block and does NOT throw', async () => {
    const result = await dispatch(server, 'status', {})
    expect(result.content.length).toBeGreaterThanOrEqual(2)
    const joined = result.content.map((b) => b.text).join('\n')
    expect(joined).toContain('Configuration error')
    expect(joined).toContain('BASE_DIRS must be a JSON array')
  })
})

// ---- SYNC-006/SYNC-007: sync dispatch + the server-instance mutation guard ----
//
// The guard lives in the `CallToolRequestSchema` closure, so these tests drive
// it through the same `_requestHandlers` entry the SDK calls. The embedder is
// stubbed (external ML I/O) and, for the overlap case, gated on a promise this
// file resolves, so one mutation is provably still in flight — and parked
// BEFORE any store mutation — while the probes run. Everything else (dispatch,
// guard, parser, chunker, store, filesystem) is real.
describe('External mutation guard at the dispatch boundary (SYNC-007)', () => {
  let server: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-guard')
  const testDataDir = resolve('./tmp/test-data-guard')

  /** Embedding width of the production model, so stub rows match the schema. */
  const VECTOR_DIMENSION = 384

  function unitVector(seed: number): number[] {
    const raw = Array.from({ length: VECTOR_DIMENSION }, (_, index) => Math.sin(seed + index))
    const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
    return raw.map((value) => value / norm)
  }

  /**
   * A well-formed job id this server never issued. Well-formed on purpose: the
   * input boundary bounds `jobId` to the UUID alphabet, so a prose sentinel would
   * be rejected there and never reach `handleSyncStatus` — which is the handler
   * these cases are proving the dispatcher reaches.
   */
  const NEVER_ISSUED_JOB_ID = '00000000-0000-4000-8000-000000000000'

  /** When set, every batch embedding parks here until the test releases it. */
  let embedGate: { pending: Promise<void>; release: () => void } | null = null

  function openGate(): { pending: Promise<void>; release: () => void } {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    return { pending, release }
  }

  function stubEmbedder(): void {
    const embedder = internals(server).embedder
    vi.spyOn(embedder, 'embedBatch').mockImplementation(async (texts: string[]) => {
      if (embedGate !== null) await embedGate.pending
      return texts.map((_, index) => unitVector(index + 1))
    })
    vi.spyOn(embedder, 'embed').mockResolvedValue(unitVector(1))
  }

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()
  })

  afterEach(() => {
    embedGate = null
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('routes sync_start and sync_status to their own handlers, not the Unknown tool arm', async () => {
    // A rejected `sync_start` argument can only come from `parseSyncStartInput`,
    // and `Unknown sync job` can only come from `handleSyncStatus`: both prove
    // the switch reached the new arms.
    await expect(dispatch(server, 'sync_start', { path: 42 })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    })
    try {
      await dispatch(server, 'sync_start', { path: 42 })
      throw new Error('expected throw')
    } catch (e) {
      expect((e as McpError).message).toContain('path must be a non-empty string')
      expect((e as McpError).message).not.toContain('Unknown tool')
    }

    try {
      await dispatch(server, 'sync_status', { jobId: NEVER_ISSUED_JOB_ID })
      throw new Error('expected throw')
    } catch (e) {
      const err = e as McpError
      expect(err).toBeInstanceOf(McpError)
      expect(err.message).toContain('Unknown sync job')
      expect(err.message).not.toContain('Unknown tool')
    }
  })

  it('releases the guard when sync_start is rejected before a job is scheduled', async () => {
    stubEmbedder()
    await expect(dispatch(server, 'sync_start', { path: '   ' })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    })

    // A leaked guard here would soft-lock every mutation for the process
    // lifetime, so the next mutation must be accepted normally.
    const testFile = resolve(testDataDir, 'guard-after-rejected-start.txt')
    writeFileSync(testFile, 'Content after a rejected sync_start. '.repeat(40))
    const result = await dispatch(server, 'ingest_file', { filePath: testFile })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]?.text ?? '{}').chunkCount).toBeGreaterThan(0)
  }, 60000)

  it('rejects every other external mutation while one is in flight and keeps read-only tools callable', async () => {
    stubEmbedder()
    // Seed a document so the read-only probes have real data to return.
    const probeFile = resolve(testDataDir, 'guard-probe.txt')
    writeFileSync(probeFile, 'Guard probe content for read-only tools. '.repeat(40))
    await dispatch(server, 'ingest_file', { filePath: probeFile })

    const inFlightFile = resolve(testDataDir, 'guard-in-flight.txt')
    writeFileSync(inFlightFile, 'Content held mid-ingest by the embedder gate. '.repeat(40))
    const gate = openGate()
    embedGate = gate
    // Parked inside the embedder, i.e. before any delete/insert: the store is
    // quiescent while the probes below run, but the guard is held.
    const inFlight = dispatch(server, 'ingest_file', { filePath: inFlightFile })

    for (const [tool, args] of [
      ['sync_start', {}],
      ['ingest_file', { filePath: probeFile }],
      [
        'ingest_data',
        { content: 'blocked '.repeat(20), metadata: { source: 'g', format: 'text' } },
      ],
      ['delete_file', { filePath: probeFile }],
    ] as const) {
      const overlap = await dispatch(server, tool, args)
      expect(overlap.isError, `${tool} must be rejected as busy`).toBe(true)
      expect(overlap.content.map((block) => block.text).join('\n')).toMatch(/in progress|running/i)
    }

    // Read-only tools are deliberately not gated.
    const queried = await dispatch(server, 'query_documents', { query: 'guard probe' })
    expect(queried.isError).toBeUndefined()
    const neighbors = await dispatch(server, 'read_chunk_neighbors', {
      filePath: probeFile,
      chunkIndex: 0,
    })
    expect(neighbors.isError).toBeUndefined()
    expect(JSON.parse(neighbors.content[0]?.text ?? '[]').length).toBeGreaterThan(0)
    const listed = await dispatch(server, 'list_files', {})
    expect(listed.isError).toBeUndefined()
    const status = await dispatch(server, 'status', {})
    expect(status.isError).toBeUndefined()
    // `sync_status` is ungated too: with no job registered it answers with its
    // own unknown-job error rather than the busy overlap message.
    await expect(dispatch(server, 'sync_status', { jobId: NEVER_ISSUED_JOB_ID })).rejects.toThrow(
      /Unknown sync job/
    )

    gate.release()
    const finished = await inFlight
    expect(finished.isError).toBeUndefined()

    // The guard was released when the request completed.
    embedGate = null
    const afterwards = await dispatch(server, 'delete_file', { filePath: probeFile })
    expect(afterwards.isError).toBeUndefined()
  }, 60000)

  it('releases the guard when a mutation throws, so the next mutation is accepted', async () => {
    stubEmbedder()
    const testFile = resolve(testDataDir, 'guard-throwing-delete.txt')
    writeFileSync(testFile, 'Content for the throwing delete. '.repeat(40))
    await dispatch(server, 'ingest_file', { filePath: testFile })

    const vectorStore = internals(server).vectorStore
    const deleteSpy = vi
      .spyOn(vectorStore, 'deleteChunks')
      .mockRejectedValueOnce(new Error('induced delete failure'))
    await expect(dispatch(server, 'delete_file', { filePath: testFile })).rejects.toThrow(
      /induced delete failure/
    )
    deleteSpy.mockRestore()

    const recovered = resolve(testDataDir, 'guard-after-throw.txt')
    writeFileSync(recovered, 'Content ingested after the failure. '.repeat(40))
    const result = await dispatch(server, 'ingest_file', { filePath: recovered })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]?.text ?? '{}').chunkCount).toBeGreaterThan(0)
  }, 60000)

  it('completes ingest_data end to end, so the internal handleIngestFile never reacquires the guard', async () => {
    stubEmbedder()
    const result = await dispatch(server, 'ingest_data', {
      content: 'Nested ingest must not self-deadlock. '.repeat(30),
      metadata: { source: 'guard-nested-ingest-data', format: 'text' },
    })

    expect(result.isError).toBeUndefined()
    const ingested = JSON.parse(result.content[0]?.text ?? '{}')
    expect(ingested.chunkCount).toBeGreaterThan(0)
    // And the guard is free afterwards.
    const followUp = await dispatch(server, 'delete_file', { source: 'guard-nested-ingest-data' })
    expect(followUp.isError).toBeUndefined()
    expect(JSON.parse(followUp.content[0]?.text ?? '{}').deleted).toBe(true)
  }, 60000)
})
