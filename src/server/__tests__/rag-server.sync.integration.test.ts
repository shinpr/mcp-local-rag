// MCP sync tools integration test (SYNC-004 / SYNC-006 / SYNC-007)
// Test Type: Integration (real RAGServer, real VectorStore, real parser +
// chunker, real filesystem under `tmp/`; only the embedder is stubbed)
//
// Work plan: docs/plans/20260726-feature-incremental-sync.md
//   § Reference Contract Values → MCP Contract, § MCP Mutation Guard,
//   § Binding Contracts (SYNC-004/006/007)
//
// Mock isolation: `../../utils/scan.js` is imported by other test files, so the
// factory is installed with `vi.doMock` in `beforeAll` and removed with
// `vi.doUnmock` + `vi.resetModules` in `afterAll`, with the server module
// imported dynamically afterwards (see `.claude/skills/project-context/SKILL.md`
// § Test Environment Constraints). The factory delegates to the real walker: it
// only records the verbatim argument list and, when a test asks for it, parks
// the sync scan so a job can be observed while it is provably still running.
//
// Background work is never awaited with a sleep: every wait polls the real
// `sync_status` handler until the job leaves `running`, which is the same
// signal an MCP client has.

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTestDevice } from '../../__tests__/test-device.js'
import type { Embedder } from '../../embedder/index.js'
import type { SyncStatusResult } from '../types.js'

// ============================================
// Mock setup (scoped doMock — see header)
// ============================================

/** Embedding width of the production model, so stub rows match the schema. */
const VECTOR_DIMENSION = 384

/** A file containing this marker makes the stub embedder throw. */
const FAIL_MARKER = 'INDUCED-EMBEDDING-FAILURE'

/** One entry per walker call: its verbatim argument list. */
const scanArgs: unknown[][] = []

/**
 * When set, the sync walker parks here. Keyed on the three-argument sync
 * signature so `list_files` (which always passes a fourth `scope` argument)
 * keeps working while a sync is deliberately held in `running`.
 */
let scanGate: { pending: Promise<void>; release: () => void } | null = null

function openGate(): { pending: Promise<void>; release: () => void } {
  let release!: () => void
  const pending = new Promise<void>((resolvePending) => {
    release = resolvePending
  })
  return { pending, release }
}

const scanFactory = async (importOriginal: () => Promise<typeof import('../../utils/scan.js')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    bfsCollectSupportedFiles: async (
      ...args: Parameters<typeof actual.bfsCollectSupportedFiles>
    ) => {
      scanArgs.push(args)
      if (scanGate !== null && args.length === 3) await scanGate.pending
      return await actual.bfsCollectSupportedFiles(...args)
    },
  }
}

const MOCKED_PATHS = ['../../utils/scan.js'] as const

let RAGServer: typeof import('../index.js').RAGServer
let VectorStore: typeof import('../../vectordb/index.js').VectorStore
let buildVectorChunks: typeof import('../../ingest/compute.js').buildVectorChunks
let MAX_SCAN_DEPTH: number

type ServerInstance = InstanceType<typeof import('../index.js').RAGServer>

// ============================================
// Fixtures
// ============================================

/** Everything this file writes lives under the gitignored project-root `tmp/`. */
const TMP_ROOT = resolve('./tmp/test-server-sync')

interface Fixture {
  roots: string[]
  dbPath: string
  cacheDir: string
}

function unitVector(seed: number): number[] {
  const raw = Array.from({ length: VECTOR_DIMENSION }, (_, index) => Math.sin(seed + index))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / norm)
}

/** Independent hash oracle: `node:crypto` over the exact bytes written. */
function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content)).digest('hex')
}

/** How many times `needle` appears in `haystack` (non-overlapping). */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

async function writeFixtureFile(filePath: string, content: string): Promise<string> {
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, content)
  return filePath
}

/**
 * Isolated case directory: `<tmp>/<name>/root[N]` as configured root(s), with a
 * sibling `db` and `cache` so neither sits inside a scanned root.
 */
async function makeFixture(name: string, rootCount = 1): Promise<Fixture> {
  const caseDir = join(TMP_ROOT, name)
  await rm(caseDir, { recursive: true, force: true })
  const roots: string[] = []
  for (let index = 0; index < rootCount; index++) {
    const root = join(caseDir, rootCount === 1 ? 'root' : `root${index + 1}`)
    await mkdir(root, { recursive: true })
    roots.push(root)
  }
  return { roots, dbPath: join(caseDir, 'db'), cacheDir: join(caseDir, 'cache') }
}

/**
 * Directory symlinks need admin/developer mode on the `windows-latest` CI leg, so
 * probe support once and skip the escape suite there rather than failing the job
 * on an environment limitation (same probe as
 * `src/__tests__/cli/list-scope.int.test.ts`).
 */
function directorySymlinkSupported(): boolean {
  const probeDir = join(TMP_ROOT, 'symlink-probe')
  try {
    mkdirSync(join(probeDir, 'target'), { recursive: true })
    symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

/**
 * `root/d1/…/d10/deep.md`: `d10` sits at depth 10 from `root`, so a root-relative
 * scan (MAX_SCAN_DEPTH = 10) never reads it, while a scan rooted at `d2` does.
 */
function deepChainDir(root: string, levels: number): string {
  let dirPath = root
  for (let level = 1; level <= levels; level++) {
    dirPath = join(dirPath, `d${level}`)
  }
  return dirPath
}

/** Rows exactly as ingestion writes them, for pre-seeding the store. */
async function seedRows(
  fixture: Fixture,
  filePath: string,
  contentHash: string | null,
  chunkCount = 2
): Promise<void> {
  const store = new VectorStore({ dbPath: fixture.dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    await store.insertChunks(
      buildVectorChunks({
        filePath,
        chunks: Array.from({ length: chunkCount }, (_, index) => ({
          index,
          text: `seeded chunk ${index} for ${filePath}`,
        })),
        embeddings: Array.from({ length: chunkCount }, (_, index) => unitVector(index + 1)),
        fileSize: 64,
        fileTitle: null,
        contentHash,
      })
    )
  } finally {
    await store.close()
  }
}

/** `(filePath, contentHash)` manifest of the store, sorted for stable equality. */
async function storedManifest(
  fixture: Fixture
): Promise<{ filePath: string; contentHash: string | null }[]> {
  const store = new VectorStore({ dbPath: fixture.dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    const rows = await store.listChunkHashes()
    return rows.sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        (left.contentHash ?? '').localeCompare(right.contentHash ?? '')
    )
  } finally {
    await store.close()
  }
}

/** Distinct stored file paths, sorted. */
async function storedPaths(fixture: Fixture): Promise<string[]> {
  return [...new Set((await storedManifest(fixture)).map((row) => row.filePath))].sort()
}

/**
 * A real server over the fixture with a deterministic embedder: the model is an
 * external ~90MB download and is non-deterministic across devices, while row,
 * path, and job-state correctness is what these tests are about.
 */
async function makeServer(fixture: Fixture): Promise<ServerInstance> {
  const server = new RAGServer(
    withTestDevice({
      dbPath: fixture.dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      // Fixture-local: the stubbed embedder never loads a model, and the walker
      // must be shown excluding this exact directory.
      cacheDir: fixture.cacheDir,
      baseDirs: fixture.roots,
      maxFileSize: 100 * 1024 * 1024,
    })
  )
  const embedder = (server as unknown as { embedder: Embedder }).embedder
  vi.spyOn(embedder, 'embedBatch').mockImplementation(async (texts: string[]) => {
    if (texts.some((text) => text.includes(FAIL_MARKER))) {
      throw new Error('induced embedding failure')
    }
    return texts.map((_, index) => unitVector(index + 1))
  })
  vi.spyOn(embedder, 'embed').mockResolvedValue(unitVector(1))
  await server.initialize()
  return server
}

// ============================================
// Dispatch helpers (the boundary under test)
// ============================================

type DispatchResult = { content: { type: string; text: string }[]; isError?: boolean }
type RegisteredHandler = (
  request: { method: string; params: { name: string; arguments?: unknown } },
  extra: { signal: AbortSignal }
) => Promise<DispatchResult>

/**
 * Invoke the registered CallTool dispatcher closure directly — the boundary that
 * owns the mutation guard and the tool switch.
 */
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

async function syncStart(server: ServerInstance, args: unknown = {}): Promise<string> {
  const result = await dispatch(server, 'sync_start', args)
  expect(result.isError).toBeUndefined()
  const { jobId } = JSON.parse(firstBlock(result)) as { jobId: string }
  return jobId
}

async function syncStatus(server: ServerInstance, jobId: string): Promise<SyncStatusResult> {
  const result = await dispatch(server, 'sync_status', { jobId })
  expect(result.isError).toBeUndefined()
  return JSON.parse(firstBlock(result)) as SyncStatusResult
}

/**
 * Poll the real `sync_status` handler until the job leaves `running`, returning
 * every snapshot observed. Yields with `setImmediate` (never a timed sleep), so
 * it returns as soon as the job is terminal; the wall-clock guard only turns a
 * hang into a readable failure instead of a suite timeout.
 */
async function pollUntilTerminal(
  server: ServerInstance,
  jobId: string
): Promise<SyncStatusResult[]> {
  const snapshots: SyncStatusResult[] = []
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const snapshot = await syncStatus(server, jobId)
    snapshots.push(snapshot)
    if (snapshot.state !== 'running') return snapshots
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
  throw new Error(`sync job ${jobId} never reached a terminal state`)
}

function lastSnapshot(snapshots: SyncStatusResult[]): SyncStatusResult {
  const last = snapshots.at(-1)
  if (last === undefined) throw new Error('no status snapshot was collected')
  return last
}

/** The four invariants every observed snapshot must satisfy. */
function expectProgressInvariants(snapshots: SyncStatusResult[]): void {
  let previousCompleted = -1
  for (const snapshot of snapshots) {
    const { upserted, skipped, empty } = snapshot.summary
    expect(snapshot.completed).toBeGreaterThanOrEqual(previousCompleted)
    previousCompleted = snapshot.completed
    if (snapshot.total !== null) {
      expect(snapshot.completed).toBeLessThanOrEqual(snapshot.total)
    }
    if (snapshot.state !== 'running') {
      expect(snapshot.completed).toBe(upserted + skipped + empty)
    }
  }
}

// ============================================
// Tests
// ============================================

const describeSymlinkedRoot = directorySymlinkSupported() ? describe : describe.skip

describe('MCP sync tools', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../utils/scan.js', scanFactory)
    ;({ RAGServer } = await import('../index.js'))
    ;({ VectorStore } = await import('../../vectordb/index.js'))
    ;({ buildVectorChunks } = await import('../../ingest/compute.js'))
    ;({ MAX_SCAN_DEPTH } = await import('../../utils/limits.js'))
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await rm(TMP_ROOT, { recursive: true, force: true })
    for (const path of MOCKED_PATHS) vi.doUnmock(path)
    vi.resetModules()
  })

  beforeEach(() => {
    scanArgs.length = 0
    scanGate = null
  })

  // --------------------------------------------
  // Start before work (SYNC-006)
  // --------------------------------------------

  it('returns a jobId without waiting for the run to finish', async () => {
    const fixture = await makeFixture('start-before-work')
    const filePath = await writeFixtureFile(
      join(fixture.roots[0] ?? '', 'a.md'),
      `document for the start-before-work case ${'a'.repeat(200)}`
    )
    const server = await makeServer(fixture)
    try {
      const gate = openGate()
      scanGate = gate

      // Resolves while the walker is parked: an implementation that awaited the
      // run would never answer here.
      const jobId = await syncStart(server)
      expect(jobId.length).toBeGreaterThan(0)

      expect(await syncStatus(server, jobId)).toEqual({
        jobId,
        state: 'running',
        total: null,
        completed: 0,
        summary: { upserted: 0, skipped: 0, empty: 0, pruned: 0 },
        warnings: [],
        error: null,
      })
      // The scan is parked at its first call, so no file has been hashed and
      // nothing has been written.
      expect(scanArgs).toHaveLength(1)
      const statusBlock = JSON.parse(firstBlock(await dispatch(server, 'status', {}))) as {
        chunkCount: number
      }
      expect(statusBlock.chunkCount).toBe(0)

      gate.release()
      scanGate = null
      const terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
      expect(terminal.state).toBe('succeeded')
      expect(terminal.error).toBeNull()
    } finally {
      await server.close()
    }
    expect(await storedPaths(fixture)).toEqual([filePath])
  }, 45000)

  // --------------------------------------------
  // Progress and counters (SYNC-006)
  // --------------------------------------------

  it('polls from total null to a number with monotonic completed and a succeeded terminal state', async () => {
    const fixture = await makeFixture('progress')
    const rootDir = fixture.roots[0] ?? ''
    const addedContent = `added document ${'a'.repeat(200)}`
    const changedContent = `changed document ${'b'.repeat(200)}`
    const unchangedContent = `unchanged document ${'c'.repeat(200)}`
    const addedPath = await writeFixtureFile(join(rootDir, 'added.md'), addedContent)
    const changedPath = await writeFixtureFile(join(rootDir, 'changed.md'), changedContent)
    const unchangedPath = await writeFixtureFile(join(rootDir, 'unchanged.md'), unchangedContent)
    const emptyPath = await writeFixtureFile(join(rootDir, 'empty.md'), '')
    const gonePath = join(rootDir, 'gone.md')
    await seedRows(fixture, changedPath, sha256('a previous revision'))
    await seedRows(fixture, unchangedPath, sha256(unchangedContent))
    await seedRows(fixture, gonePath, sha256('deleted from disk'))

    const server = await makeServer(fixture)
    try {
      const gate = openGate()
      scanGate = gate
      const jobId = await syncStart(server)
      const beforeScan = await syncStatus(server, jobId)
      expect(beforeScan.total).toBeNull()
      expect(beforeScan.completed).toBe(0)

      gate.release()
      scanGate = null
      const snapshots = [beforeScan, ...(await pollUntilTerminal(server, jobId))]
      expectProgressInvariants(snapshots)

      const terminal = lastSnapshot(snapshots)
      expect(terminal.state).toBe('succeeded')
      expect(terminal.error).toBeNull()
      // Four supported files on disk; `gone.md` is pruned and stays outside
      // `completed`.
      expect(terminal.total).toBe(4)
      expect(terminal.summary).toEqual({ upserted: 2, skipped: 1, empty: 1, pruned: 1 })
      expect(terminal.completed).toBe(4)
    } finally {
      await server.close()
    }

    const manifest = await storedManifest(fixture)
    expect([...new Set(manifest.map((row) => row.filePath))].sort()).toEqual(
      [addedPath, changedPath, unchangedPath].sort()
    )
    expect(
      new Set(manifest.filter((row) => row.filePath === changedPath).map((row) => row.contentHash))
    ).toEqual(new Set([sha256(changedContent)]))
    expect(manifest.filter((row) => row.filePath === emptyPath)).toEqual([])
    expect(manifest.filter((row) => row.filePath === gonePath)).toEqual([])
  }, 60000)

  // --------------------------------------------
  // Failure (SYNC-004)
  // --------------------------------------------

  it('reaches failed with one error naming the file and performs no prune', async () => {
    const fixture = await makeFixture('failure')
    const rootDir = fixture.roots[0] ?? ''
    const failingPath = await writeFixtureFile(
      join(rootDir, 'failing.md'),
      `${FAIL_MARKER} document ${'a'.repeat(200)}`
    )
    const gonePath = join(rootDir, 'gone.md')
    await seedRows(fixture, gonePath, sha256('deleted from disk'))

    const server = await makeServer(fixture)
    let terminal: SyncStatusResult
    try {
      const jobId = await syncStart(server)
      terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
    } finally {
      await server.close()
    }

    expect(terminal.state).toBe('failed')
    expect(terminal.error).toContain('induced embedding failure')
    expect(terminal.error).toContain(failingPath)
    // Exactly one controlled error, naming the file once.
    expect(occurrences(terminal.error ?? '', failingPath)).toBe(1)
    expect(terminal.summary).toEqual({ upserted: 0, skipped: 0, empty: 0, pruned: 0 })
    // The first error stops the run before the prune phase: the row for the
    // file that left the disk survives.
    expect(await storedPaths(fixture)).toEqual([gonePath])
  }, 45000)

  // --------------------------------------------
  // The mutation guard (SYNC-007)
  // --------------------------------------------

  it('rejects every external mutation while a sync runs, keeps read-only tools callable, and replaces the terminal job', async () => {
    const fixture = await makeFixture('guard')
    const rootDir = fixture.roots[0] ?? ''
    const documentPath = await writeFixtureFile(
      join(rootDir, 'guarded.md'),
      `guarded document ${'a'.repeat(200)}`
    )
    const server = await makeServer(fixture)
    try {
      // Seed one indexed document so the read-only probes return real data.
      await dispatch(server, 'ingest_file', { filePath: documentPath })

      const gate = openGate()
      scanGate = gate
      const jobId = await syncStart(server)

      for (const [tool, args] of [
        ['sync_start', {}],
        ['ingest_file', { filePath: documentPath }],
        [
          'ingest_data',
          { content: 'blocked '.repeat(20), metadata: { source: 'blocked', format: 'text' } },
        ],
        ['delete_file', { filePath: documentPath }],
      ] as const) {
        const overlap = await dispatch(server, tool, args)
        expect(overlap.isError, `${tool} must be rejected while a sync runs`).toBe(true)
        const text = overlap.content.map((block) => block.text).join('\n')
        expect(text).toContain(jobId)
        expect(text).toContain('sync_status')
      }

      // Read-only tools are deliberately not gated.
      const running = await syncStatus(server, jobId)
      expect(running.state).toBe('running')
      for (const [tool, args] of [
        ['query_documents', { query: 'guarded document' }],
        ['read_chunk_neighbors', { filePath: documentPath, chunkIndex: 0 }],
        ['list_files', {}],
        ['status', {}],
      ] as const) {
        const result = await dispatch(server, tool, args)
        expect(result.isError, `${tool} must stay callable during a sync`).toBeUndefined()
        expect(result.content.length).toBeGreaterThan(0)
      }

      gate.release()
      scanGate = null
      expect(lastSnapshot(await pollUntilTerminal(server, jobId)).state).toBe('succeeded')

      // The guard was released on the terminal transition: a new job starts and
      // replaces the old record, whose id is then unknown.
      const secondJobId = await syncStart(server)
      expect(secondJobId).not.toBe(jobId)
      await expect(dispatch(server, 'sync_status', { jobId })).rejects.toThrow(/Unknown sync job/)
      expect(lastSnapshot(await pollUntilTerminal(server, secondJobId)).state).toBe('succeeded')

      // And an ordinary mutation is accepted again.
      const deleted = await dispatch(server, 'delete_file', { filePath: documentPath })
      expect(deleted.isError).toBeUndefined()
    } finally {
      await server.close()
    }
  }, 60000)

  it('releases the guard when a sync job fails, so the next sync_start is accepted', async () => {
    const fixture = await makeFixture('guard-after-failure')
    const rootDir = fixture.roots[0] ?? ''
    const failingPath = await writeFixtureFile(
      join(rootDir, 'failing.md'),
      `${FAIL_MARKER} document ${'a'.repeat(200)}`
    )
    const server = await makeServer(fixture)
    try {
      const failedJobId = await syncStart(server)
      expect(lastSnapshot(await pollUntilTerminal(server, failedJobId)).state).toBe('failed')

      await writeFile(failingPath, `repaired document ${'b'.repeat(200)}`)
      const retryJobId = await syncStart(server)
      const terminal = lastSnapshot(await pollUntilTerminal(server, retryJobId))
      expect(terminal.state).toBe('succeeded')
      expect(terminal.summary.upserted).toBe(1)
    } finally {
      await server.close()
    }
  }, 45000)

  it('reports a jobId from a previous server instance as unknown', async () => {
    const fixture = await makeFixture('process-local')
    await writeFixtureFile(
      join(fixture.roots[0] ?? '', 'a.md'),
      `document for the process-local case ${'a'.repeat(200)}`
    )

    const first = await makeServer(fixture)
    let jobId: string
    try {
      jobId = await syncStart(first)
      expect(lastSnapshot(await pollUntilTerminal(first, jobId)).state).toBe('succeeded')
    } finally {
      await first.close()
    }

    const second = await makeServer(fixture)
    try {
      await expect(dispatch(second, 'sync_status', { jobId })).rejects.toThrow(/Unknown sync job/)
    } finally {
      await second.close()
    }
  }, 45000)

  // --------------------------------------------
  // Path classification and depth: identical to the CLI
  // --------------------------------------------

  it('scans every configured root with depth counted from that root when the path is omitted', async () => {
    const fixture = await makeFixture('omitted', 2)
    const firstPath = await writeFixtureFile(
      join(fixture.roots[0] ?? '', 'first.md'),
      `first root document ${'a'.repeat(200)}`
    )
    const secondPath = await writeFixtureFile(
      join(fixture.roots[1] ?? '', 'nested', 'second.md'),
      `second root document ${'b'.repeat(200)}`
    )
    const deepDir = deepChainDir(fixture.roots[0] ?? '', MAX_SCAN_DEPTH)
    const deepPath = await writeFixtureFile(
      join(deepDir, 'deep.md'),
      `too deep for a root-relative scan ${'c'.repeat(200)}`
    )

    const server = await makeServer(fixture)
    let terminal: SyncStatusResult
    try {
      const jobId = await syncStart(server)
      terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
    } finally {
      await server.close()
    }

    expect(terminal.state).toBe('succeeded')
    expect(terminal.summary).toEqual({ upserted: 2, skipped: 0, empty: 0, pruned: 0 })
    // Both configured roots were scanned, each as its own BFS root, and each
    // with exactly three arguments: forwarding a `scope` would hide an
    // unobserved region from the coverage facts and make prune unsafe.
    expect(scanArgs).toEqual(
      fixture.roots.map((root) => [
        root,
        [`${resolve(fixture.dbPath)}${sep}`, `${resolve(fixture.cacheDir)}${sep}`],
        MAX_SCAN_DEPTH,
      ])
    )
    expect(scanArgs.every((args) => args.length === 3)).toBe(true)
    const paths = await storedPaths(fixture)
    expect(paths).toEqual([firstPath, secondPath].sort())
    expect(paths).not.toContain(deepPath)
    // The unobserved region is reported on the job record so the caller knows
    // why its indexed files were kept. Matched on the portion below `tmp/`,
    // because this surface abbreviates a home-directory prefix to `~` (whether
    // one applies depends on where the checkout lives); the abbreviation itself
    // is pinned by its own case below.
    expect(
      terminal.warnings.some((warning) => warning.includes(deepDir.slice(TMP_ROOT.length)))
    ).toBe(true)
  }, 45000)

  // --------------------------------------------
  // Warning presentation and compaction
  // --------------------------------------------

  it('abbreviates the home directory in job warnings, as list_files already does', async () => {
    const fixture = await makeFixture('home-abbreviation')
    const deepDir = deepChainDir(fixture.roots[0] ?? '', MAX_SCAN_DEPTH)
    await writeFixtureFile(
      join(deepDir, 'deep.md'),
      `too deep for a root-relative scan ${'c'.repeat(200)}`
    )

    const savedHome = process.env['HOME']
    // The fixture is not really under the operator's home, so `HOME` is pointed at
    // it: the assertion is about the abbreviation, not about where `tmp/` lives.
    process.env['HOME'] = TMP_ROOT
    let terminal: SyncStatusResult
    const server = await makeServer(fixture)
    try {
      const jobId = await syncStart(server)
      terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
    } finally {
      await server.close()
      if (savedHome === undefined) {
        delete process.env['HOME']
      } else {
        process.env['HOME'] = savedHome
      }
    }

    expect(terminal.state).toBe('succeeded')
    const depthWarnings = terminal.warnings.filter((warning) => warning.includes('maximum depth'))
    expect(depthWarnings).toHaveLength(1)
    // The path is still identifiable, but the home prefix — and with it the OS
    // account name — is withheld from the client.
    expect(depthWarnings[0]).toContain(`~${deepDir.slice(TMP_ROOT.length)}`)
    expect(depthWarnings[0]).not.toContain(TMP_ROOT)
  }, 45000)

  it('compacts once for the whole run, and not at all for a no-op', async () => {
    const fixture = await makeFixture('single-optimize')
    const rootDir = fixture.roots[0] ?? ''
    await writeFixtureFile(join(rootDir, 'first.md'), `first document ${'a'.repeat(200)}`)
    await writeFixtureFile(join(rootDir, 'second.md'), `second document ${'b'.repeat(200)}`)

    const server = await makeServer(fixture)
    const vectorStore = (server as unknown as { vectorStore: InstanceType<typeof VectorStore> })
      .vectorStore
    const optimizeSpy = vi.spyOn(vectorStore, 'optimize')
    try {
      const jobId = await syncStart(server)
      const terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
      expect(terminal.summary).toEqual({ upserted: 2, skipped: 0, empty: 0, pruned: 0 })
      // Two upserts, one compaction: the per-file `optimize()` of `ingest_file` is
      // skipped for sync's reuse of that handler.
      expect(optimizeSpy).toHaveBeenCalledTimes(1)

      optimizeSpy.mockClear()
      const noopJobId = await syncStart(server)
      const noop = lastSnapshot(await pollUntilTerminal(server, noopJobId))
      expect(noop.summary).toEqual({ upserted: 0, skipped: 2, empty: 0, pruned: 0 })
      expect(optimizeSpy).not.toHaveBeenCalled()
    } finally {
      optimizeSpy.mockRestore()
      await server.close()
    }
  }, 60000)

  it('makes an explicit directory the depth-zero BFS root and forwards no scope to the walker', async () => {
    const fixture = await makeFixture('explicit-directory')
    const rootDir = fixture.roots[0] ?? ''
    const requestedDir = join(rootDir, 'd1', 'd2')
    const deepDir = deepChainDir(rootDir, MAX_SCAN_DEPTH)
    const deepPath = await writeFixtureFile(
      join(deepDir, 'deep.md'),
      `reachable only when depth restarts ${'c'.repeat(200)}`
    )

    const server = await makeServer(fixture)
    let terminal: SyncStatusResult
    try {
      const jobId = await syncStart(server, { path: requestedDir })
      terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
    } finally {
      await server.close()
    }

    expect(terminal.state).toBe('succeeded')
    expect(terminal.summary).toEqual({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
    expect(await storedPaths(fixture)).toEqual([deepPath])
    expect(scanArgs).toHaveLength(1)
    const scanCall = scanArgs[0] ?? []
    expect(scanCall).toEqual([
      requestedDir,
      [`${resolve(fixture.dbPath)}${sep}`, `${resolve(fixture.cacheDir)}${sep}`],
      MAX_SCAN_DEPTH,
    ])
    expect(scanCall).toHaveLength(3)
    expect(scanCall[3]).toBeUndefined()
  }, 45000)

  it('handles an explicit file directly, with no directory scan and no sibling changes', async () => {
    const fixture = await makeFixture('explicit-file')
    const rootDir = fixture.roots[0] ?? ''
    const targetContent = `requested document ${'a'.repeat(200)}`
    const targetPath = await writeFixtureFile(join(rootDir, 'target.md'), targetContent)
    const siblingPath = await writeFixtureFile(
      join(rootDir, 'sibling.md'),
      `sibling document ${'b'.repeat(200)}`
    )
    await seedRows(fixture, siblingPath, sha256('an older sibling revision'), 1)

    const server = await makeServer(fixture)
    let terminal: SyncStatusResult
    try {
      const jobId = await syncStart(server, { path: targetPath })
      terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
    } finally {
      await server.close()
    }

    expect(terminal.state).toBe('succeeded')
    expect(terminal.summary).toEqual({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
    expect(terminal.total).toBe(1)
    // No directory was walked and no depth was evaluated.
    expect(scanArgs).toEqual([])

    const manifest = await storedManifest(fixture)
    expect(
      new Set(manifest.filter((row) => row.filePath === targetPath).map((row) => row.contentHash))
    ).toEqual(new Set([sha256(targetContent)]))
    // The sibling is outside the requested scope: neither re-ingested nor pruned.
    expect(manifest.filter((row) => row.filePath === siblingPath)).toEqual([
      { filePath: siblingPath, contentHash: sha256('an older sibling revision') },
    ])
  }, 45000)

  // --------------------------------------------
  // A `path` named THROUGH a symlinked directory
  // --------------------------------------------
  //
  // The MCP client fully controls `path` and is the untrusted party here.
  // `resolve()` is lexical, so it cannot see that an intermediate component is a
  // symbolic link: `<root>/link/x.md` passes a key-based containment check while
  // its real location is outside every configured root. `ingest_file` already
  // realpath-validates, so this surface must refuse the same paths.

  describeSymlinkedRoot('with a symlinked intermediate directory', () => {
    interface EscapeFixture extends Fixture {
      rootDir: string
      /** The real, out-of-root directory `<root>/link` points at. */
      outsideDir: string
    }

    /** `<case>/root/link` → `<case>/outside/secret`, with `db`/`cache` siblings. */
    async function makeEscapeFixture(name: string): Promise<EscapeFixture> {
      const caseDir = join(TMP_ROOT, name)
      await rm(caseDir, { recursive: true, force: true })
      const rootDir = join(caseDir, 'root')
      const outsideDir = join(caseDir, 'outside', 'secret')
      await mkdir(rootDir, { recursive: true })
      await mkdir(outsideDir, { recursive: true })
      await symlink(outsideDir, join(rootDir, 'link'), 'dir')
      return {
        roots: [rootDir],
        dbPath: join(caseDir, 'db'),
        cacheDir: join(caseDir, 'cache'),
        rootDir,
        outsideDir,
      }
    }

    it('fails the job for an out-of-root file named through the link, naming nothing under it', async () => {
      const fixture = await makeEscapeFixture('escape-file')
      const requestedPath = join(fixture.rootDir, 'link', 'inner.md')
      await writeFile(requestedPath, `out-of-root document ${'s'.repeat(200)}`)
      const insidePath = await writeFixtureFile(
        join(fixture.rootDir, 'a.md'),
        `in-root document ${'a'.repeat(200)}`
      )
      await seedRows(fixture, insidePath, 'stale-hash')

      const server = await makeServer(fixture)
      let terminal: SyncStatusResult
      try {
        const jobId = await syncStart(server, { path: requestedPath })
        terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
      } finally {
        await server.close()
      }

      // The job never reaches `succeeded`, and the one error names only the path
      // the caller already supplied.
      expect(terminal.state).toBe('failed')
      expect(terminal.error).toBe(`Sync path is outside every configured root: ${requestedPath}`)
      expect(terminal.warnings).toEqual([])
      expect(JSON.stringify(terminal)).not.toContain(fixture.outsideDir)
      expect(terminal.summary).toEqual({ upserted: 0, skipped: 0, empty: 0, pruned: 0 })
      // Nothing out of root was hashed, so the file count never counted it.
      expect(terminal.total).toBeNull()
      // No walk happened at all, and no out-of-root row was written.
      expect(scanArgs).toEqual([])
      expect(await storedPaths(fixture)).toEqual([insidePath])
    }, 45000)

    it('fails the job for an out-of-root directory named through the link and scans nothing under it', async () => {
      const fixture = await makeEscapeFixture('escape-directory')
      const requestedPath = join(fixture.rootDir, 'link', 'quiet')
      await writeFixtureFile(
        join(requestedPath, 'hidden.md'),
        `out-of-root document ${'h'.repeat(200)}`
      )

      const server = await makeServer(fixture)
      let terminal: SyncStatusResult
      try {
        const jobId = await syncStart(server, { path: requestedPath })
        terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
      } finally {
        await server.close()
      }

      expect(terminal.state).toBe('failed')
      expect(terminal.error).toBe(`Sync path is outside every configured root: ${requestedPath}`)
      expect(terminal.warnings).toEqual([])
      const record = JSON.stringify(terminal)
      expect(record).not.toContain('hidden.md')
      expect(record).not.toContain(fixture.outsideDir)
      expect(scanArgs).toEqual([])
      expect(await storedPaths(fixture)).toEqual([])
    }, 45000)

    // The assertion that kills the oracle: one requested path, three states of
    // the out-of-root target, one byte-identical error. Anything that varied per
    // state would tell the client whether a path outside the roots exists and
    // whether it is readable.
    it('reports one identical error whether the out-of-root target is readable, unreadable, or absent', async () => {
      const fixture = await makeEscapeFixture('escape-oracle')
      const requestedPath = join(fixture.rootDir, 'link', 'probe.md')
      await writeFile(requestedPath, `out-of-root document ${'p'.repeat(200)}`)

      const server = await makeServer(fixture)
      const errors: (string | null)[] = []
      try {
        const runOnce = async (): Promise<void> => {
          const jobId = await syncStart(server, { path: requestedPath })
          errors.push(lastSnapshot(await pollUntilTerminal(server, jobId)).error)
        }
        await runOnce()
        await chmod(requestedPath, 0o000)
        await runOnce()
        await chmod(requestedPath, 0o600)
        await rm(requestedPath)
        await runOnce()
      } finally {
        await server.close()
      }

      expect(errors[0]).toBe(`Sync path is outside every configured root: ${requestedPath}`)
      expect(errors[1]).toBe(errors[0])
      expect(errors[2]).toBe(errors[0])
      expect(new Set(errors).size).toBe(1)
    }, 60000)
  })

  // The collapse above applies only to out-of-root requests: an in-root path
  // names nothing the client did not already know, so its specific message stays.
  it('keeps the specific error for an in-root path that does not exist', async () => {
    const fixture = await makeFixture('requested-missing')
    const missingPath = join(fixture.roots[0] ?? '', 'ghost.md')

    const server = await makeServer(fixture)
    let terminal: SyncStatusResult
    try {
      const jobId = await syncStart(server, { path: missingPath })
      terminal = lastSnapshot(await pollUntilTerminal(server, jobId))
    } finally {
      await server.close()
    }

    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe(`Sync path does not exist: ${missingPath}`)
  }, 45000)
})
