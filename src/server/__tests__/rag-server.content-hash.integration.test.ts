// MCP ingest `contentHash` ordering integration test.
// Test Type: Integration (real RAGServer, real VectorStore, real DocumentParser +
// SemanticChunker, real filesystem under the gitignored project-root `tmp/`; the
// embedder is stubbed and doubles as the "an editor saves while the file is being
// ingested" trigger)
//
// Work plan: docs/plans/20260726-feature-incremental-sync.md § Post-review Fixes
//
// Why this file exists: `contentHash` used to come from a read taken after parse,
// chunk, and embed, while the chunks came from the parser's read. A save inside
// that window — seconds long for a large document — stored the NEW bytes' digest
// against chunks built from the OLD ones, after which every sync saw
// `disk hash == stored hash`, skipped the file, and the index served stale content
// permanently. The hash is now read before the parse, so the stored digest is at
// worst OLDER than the disk bytes and the next sync re-ingests: fail dirty, never
// fail clean. The same ordering makes this read the first thing to touch a
// client-supplied path, so the checks the parse used to perform ahead of it —
// containment, size, and "is this even a regular file" — are pinned here too.
//
// Mock isolation: `node:fs/promises` is imported across the codebase, so the
// wrapper is installed with `vi.doMock` in `beforeAll` and removed with
// `vi.doUnmock` + `vi.resetModules` in `afterAll`, with the server and the store
// imported dynamically afterwards (see `.claude/skills/project-context/SKILL.md`
// § Test Environment Constraints). The wrapper delegates every call to the real
// module and only records which paths `readFile` was given, which is how "no byte
// read happened" and "exactly one read happened" become observable.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestDevice } from '../../__tests__/test-device.js'
import type { Embedder } from '../../embedder/index.js'
import type { SyncStatusResult } from '../types.js'

// ============================================
// Mock setup (scoped doMock — see header)
// ============================================

/** Every path handed to the production `readFile`, in call order. */
const readPaths: string[] = []

const fsPromisesFactory = async (
  importOriginal: () => Promise<typeof import('node:fs/promises')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readPaths.push(String(args[0]))
      return actual.readFile(...args)
    },
  }
}

const MOCKED_PATHS = ['node:fs/promises'] as const

let RAGServer: typeof import('../index.js').RAGServer
let VectorStore: typeof import('../../vectordb/index.js').VectorStore

type ServerInstance = InstanceType<typeof import('../index.js').RAGServer>

// ============================================
// Fixtures
// ============================================

const TMP_ROOT = resolve('./tmp/test-server-content-hash')

/** Embedding width of the production model, so stub rows match the schema. */
const VECTOR_DIMENSION = 384

/** Bytes on disk when ingestion starts; what the chunks are built from. */
const CONTENT_BEFORE = `Ingested before the save. ${'The quick brown fox jumps over the lazy dog. '.repeat(6)}`
/** Bytes an editor writes while the ingest is still computing embeddings. */
const CONTENT_AFTER = `Saved by an editor during ingestion. ${'A different sentence entirely, written later. '.repeat(6)}`

interface Fixture {
  root: string
  dbPath: string
  cacheDir: string
}

/** Independent hash oracle: `node:crypto` over the exact bytes written. */
function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex')
}

function unitVector(seed: number): number[] {
  const raw = Array.from({ length: VECTOR_DIMENSION }, (_, index) => Math.sin(seed + index))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / norm)
}

/** Isolated case directory: a configured root with a sibling `db` and `cache`. */
function makeFixture(name: string): Fixture {
  const caseDir = join(TMP_ROOT, name)
  rmSync(caseDir, { recursive: true, force: true })
  const root = join(caseDir, 'root')
  mkdirSync(root, { recursive: true })
  return { root, dbPath: join(caseDir, 'db'), cacheDir: join(caseDir, 'cache') }
}

/**
 * When set, the next `embedBatch` call rewrites `filePath` with `content` before
 * returning: the stand-in for an editor saving mid-ingestion. `embedBatch` is the
 * right trigger because it runs after the parser has read the file (both from the
 * chunker and from the embed step) and before anything is persisted, which is
 * exactly the window the defect lived in.
 */
let rewriteDuringEmbed: { filePath: string; content: string } | null = null

/**
 * A real server over the fixture with a deterministic embedder: the model is an
 * external ~90MB download and non-deterministic across devices, while stored row
 * contents are what these tests are about.
 */
async function makeServer(
  fixture: Fixture,
  maxFileSize = 100 * 1024 * 1024
): Promise<ServerInstance> {
  const server = new RAGServer(
    withTestDevice({
      dbPath: fixture.dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: fixture.cacheDir,
      baseDirs: [fixture.root],
      maxFileSize,
    })
  )
  const embedder = (server as unknown as { embedder: Embedder }).embedder
  vi.spyOn(embedder, 'embedBatch').mockImplementation(async (texts: string[]) => {
    if (rewriteDuringEmbed !== null) {
      writeFileSync(rewriteDuringEmbed.filePath, rewriteDuringEmbed.content)
      rewriteDuringEmbed = null
    }
    return texts.map((_, index) => unitVector(index + 1))
  })
  vi.spyOn(embedder, 'embed').mockResolvedValue(unitVector(1))
  await server.initialize()
  return server
}

/** `mkfifo` is POSIX-only, so the real-FIFO case is probed and skipped elsewhere. */
function fifoSupported(): boolean {
  const probePath = join(TMP_ROOT, 'fifo-probe')
  try {
    mkdirSync(TMP_ROOT, { recursive: true })
    execFileSync('mkfifo', [probePath])
    return true
  } catch {
    return false
  } finally {
    rmSync(probePath, { force: true })
  }
}

const itWithFifos = fifoSupported() ? it : it.skip

// ============================================
// Dispatch helpers (the boundary under test)
// ============================================

type DispatchResult = { content: { type: string; text: string }[]; isError?: boolean }
type RegisteredHandler = (
  request: { method: string; params: { name: string; arguments?: unknown } },
  extra: { signal: AbortSignal }
) => Promise<DispatchResult>

/** Invoke the registered CallTool dispatcher closure — the client-facing boundary. */
function dispatch(server: ServerInstance, name: string, args: unknown): Promise<DispatchResult> {
  const handler = (
    server as unknown as { server: { _requestHandlers: Map<string, RegisteredHandler> } }
  ).server._requestHandlers.get('tools/call')
  if (handler === undefined) throw new Error('tools/call handler not registered')
  return handler(
    { method: 'tools/call', params: { name, arguments: args } },
    { signal: new AbortController().signal }
  )
}

function firstBlock(result: DispatchResult): string {
  return result.content[0]?.text ?? ''
}

/** `(filePath, contentHash)` rows of the store, read through a fresh connection. */
async function storedManifest(
  fixture: Fixture
): Promise<{ filePath: string; contentHash: string | null }[]> {
  const store = new VectorStore({ dbPath: fixture.dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    return await store.listChunkHashes()
  } finally {
    await store.close()
  }
}

/** Distinct stored digests, so "every chunk carries the same hash" stays visible. */
async function storedHashes(fixture: Fixture): Promise<(string | null)[]> {
  return [...new Set((await storedManifest(fixture)).map((row) => row.contentHash))]
}

/**
 * Poll the real `sync_status` handler until the job leaves `running`. Yields with
 * `setImmediate` rather than sleeping, so it returns as soon as the job is
 * terminal; the wall-clock guard only turns a hang into a readable failure.
 */
async function awaitSyncOutcome(server: ServerInstance, jobId: string): Promise<SyncStatusResult> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const result = await dispatch(server, 'sync_status', { jobId })
    const snapshot = JSON.parse(firstBlock(result)) as SyncStatusResult
    if (snapshot.state !== 'running') return snapshot
    if (Date.now() > deadline) throw new Error(`sync job ${jobId} never left running`)
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
}

/** How many times the production `readFile` was given exactly this path. */
function readsOf(filePath: string): number {
  return readPaths.filter((path) => path === filePath).length
}

// ============================================
// Setup
// ============================================

beforeAll(async () => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
  mkdirSync(TMP_ROOT, { recursive: true })
  vi.resetModules()
  vi.doMock('node:fs/promises', fsPromisesFactory)
  ;({ RAGServer } = await import('../index.js'))
  ;({ VectorStore } = await import('../../vectordb/index.js'))
})

afterAll(async () => {
  for (const path of MOCKED_PATHS) vi.doUnmock(path)
  vi.resetModules()
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  readPaths.length = 0
  rewriteDuringEmbed = null
})

// ============================================
// contentHash is read before the parse
// ============================================

describe('ingest_file — contentHash is read before the parse', () => {
  it('stores the digest of the bytes the chunks were built from, not the bytes left on disk', async () => {
    const fixture = makeFixture('stores-pre-modification-digest')
    const filePath = join(fixture.root, 'report.md')
    writeFileSync(filePath, CONTENT_BEFORE)
    const server = await makeServer(fixture)
    try {
      rewriteDuringEmbed = { filePath, content: CONTENT_AFTER }

      const result = await dispatch(server, 'ingest_file', { filePath })
      expect(result.isError).toBeUndefined()

      // The save really landed mid-ingestion.
      expect(readFileSync(filePath, 'utf-8')).toBe(CONTENT_AFTER)
      expect(await storedHashes(fixture)).toEqual([sha256(CONTENT_BEFORE)])
    } finally {
      await server.close()
    }
  })

  it('leaves a following sync re-ingesting the file instead of skipping it', async () => {
    const fixture = makeFixture('following-sync-re-ingests')
    const filePath = join(fixture.root, 'report.md')
    writeFileSync(filePath, CONTENT_BEFORE)
    const server = await makeServer(fixture)
    try {
      rewriteDuringEmbed = { filePath, content: CONTENT_AFTER }
      await dispatch(server, 'ingest_file', { filePath })

      const { jobId } = JSON.parse(firstBlock(await dispatch(server, 'sync_start', {}))) as {
        jobId: string
      }
      const outcome = await awaitSyncOutcome(server, jobId)

      expect(outcome.state).toBe('succeeded')
      expect(outcome.error).toBeNull()
      // The stored digest was older than the disk bytes, so the file is dirty.
      expect(outcome.summary).toEqual({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
      // And the index has caught up with what is now on disk.
      expect(await storedHashes(fixture)).toEqual([sha256(CONTENT_AFTER)])
    } finally {
      await server.close()
    }
  })

  it('reads the raw-data file exactly once when ingesting data', async () => {
    const fixture = makeFixture('ingest-data-single-read')
    const server = await makeServer(fixture)
    try {
      const result = await dispatch(server, 'ingest_data', {
        content: CONTENT_BEFORE,
        metadata: { source: 'https://example.com/captured', format: 'text' },
      })
      expect(result.isError).toBeUndefined()

      // `ingest_data` already holds the bytes it just wrote, so the pre-parse hash
      // must reuse them rather than adding a read of its own.
      const rawDataDir = join(fixture.dbPath, 'raw-data')
      const rawDataReads = readPaths.filter(
        (path) => path.startsWith(rawDataDir) && path.endsWith('.md')
      )
      expect(rawDataReads).toHaveLength(1)
    } finally {
      await server.close()
    }
  })
})

// ============================================
// The pre-parse read is guarded
// ============================================

describe('ingest_file — the pre-parse read is guarded', () => {
  it('refuses a directory with InvalidParams instead of a native read failure', async () => {
    const fixture = makeFixture('directory-target')
    const dirPath = join(fixture.root, 'not-a-file.md')
    mkdirSync(dirPath, { recursive: true })
    const server = await makeServer(fixture)
    try {
      // `readFile` on a directory fails with a native EISDIR, which this boundary
      // would report as InternalError; the format dispatch it now precedes used to
      // answer InvalidParams, and that is the code a client still gets.
      const error = await dispatch(server, 'ingest_file', { filePath: dirPath }).then(
        () => null,
        (caught: unknown) => caught as McpError
      )

      expect(error).toBeInstanceOf(McpError)
      expect(error?.code).toBe(ErrorCode.InvalidParams)
      expect(error?.message).toContain('not a regular file')
      expect(readsOf(dirPath)).toBe(0)
    } finally {
      await server.close()
    }
  })

  itWithFifos(
    'refuses a FIFO without reading it, and answers instead of blocking',
    async () => {
      const fixture = makeFixture('fifo-target')
      // An unsupported extension too, so the only thing that can answer before the
      // read is the guard: a read of this path never returns, and this tool holds
      // the mutation slot until the request ends, so a block would refuse every
      // later mutation until the process restarts. The tight timeout is the
      // assertion that nothing read it.
      const fifoPath = join(fixture.root, 'pipe.xyz')
      execFileSync('mkfifo', [fifoPath])
      const server = await makeServer(fixture)
      try {
        const error = await dispatch(server, 'ingest_file', { filePath: fifoPath }).then(
          () => null,
          (caught: unknown) => caught as McpError
        )

        expect(error).toBeInstanceOf(McpError)
        expect(error?.code).toBe(ErrorCode.InvalidParams)
        expect(error?.message).toContain('not a regular file')
        expect(readsOf(fifoPath)).toBe(0)
      } finally {
        await server.close()
      }
    },
    10_000
  )

  it('refuses an oversized file before reading its bytes', async () => {
    const fixture = makeFixture('oversized-target')
    const filePath = join(fixture.root, 'oversized.md')
    writeFileSync(filePath, CONTENT_BEFORE)
    const server = await makeServer(fixture, 64)
    try {
      const error = await dispatch(server, 'ingest_file', { filePath }).then(
        () => null,
        (caught: unknown) => caught as McpError
      )

      expect(error?.code).toBe(ErrorCode.InvalidParams)
      expect(error?.message).toContain('File size exceeds limit')
      // The bound the old post-parse read position relied on: the whole file must
      // never reach memory.
      expect(readsOf(filePath)).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('refuses an absolute path outside every configured root before reading its bytes', async () => {
    const fixture = makeFixture('out-of-root-target')
    const outsideDir = join(TMP_ROOT, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const filePath = join(outsideDir, 'secret.md')
    writeFileSync(filePath, CONTENT_BEFORE)
    const server = await makeServer(fixture)
    try {
      const error = await dispatch(server, 'ingest_file', { filePath }).then(
        () => null,
        (caught: unknown) => caught as McpError
      )

      expect(error?.code).toBe(ErrorCode.InvalidParams)
      expect(error?.message).toContain('within a configured base directory')
      // Containment is decided before anything outside the roots is read.
      expect(readsOf(filePath)).toBe(0)
    } finally {
      await server.close()
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
