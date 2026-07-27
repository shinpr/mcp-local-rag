// CLI sync Tests
// Test Type: Integration Test (real VectorStore, real filesystem, real parser +
// chunker; only the embedder factory is stubbed and the scanner is wrapped to
// observe its call arguments)
//
// Work plan: docs/plans/20260726-feature-incremental-sync.md
//   § Reference Contract Values → CLI Contract, § Binding Contracts (SYNC-002/004/005)
//
// Mock isolation: `../../cli/common.js` and `../../utils/scan.js` are imported by
// other test files, so both factories are installed with `vi.doMock` in
// `beforeAll` and removed with `vi.doUnmock` + `vi.resetModules` in `afterAll`
// (see `.claude/skills/project-context/SKILL.md` § Test Environment Constraints).
// Both factories delegate to the real module: `createVectorStore` returns a real
// store (instrumented to count `optimize`/`close`), and the scanner keeps walking
// the real filesystem while recording the exact argument list it was called with.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock setup (scoped doMock — see header)
// ============================================

/** Embedding width of the production model; kept so seeded rows look real. */
const VECTOR_DIMENSION = 384

/** A file containing this marker makes the stub embedder throw. */
const FAIL_MARKER = 'INDUCED-EMBEDDING-FAILURE'

const calls = vi.hoisted(() => ({
  createEmbedder: 0,
  optimize: 0,
  close: 0,
  dispose: 0,
  /** One entry per `bfsCollectSupportedFiles` call: its verbatim argument list. */
  scanArgs: [] as unknown[][],
}))

function unitVector(seed: number): number[] {
  const raw = Array.from({ length: VECTOR_DIMENSION }, (_, index) => Math.sin(seed + index))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / norm)
}

/**
 * Deterministic embedder stand-in. The real model is an external ~90MB download
 * and is non-deterministic across devices; every other collaborator (parser,
 * chunker, store, filesystem) stays real because row and path correctness is the
 * subject of these tests.
 */
const embedderStub = {
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.some((text) => text.includes(FAIL_MARKER))) {
      throw new Error('induced embedding failure')
    }
    return texts.map((_, index) => unitVector(index + 1))
  },
  async embed(): Promise<number[]> {
    return unitVector(1)
  },
  async dispose(): Promise<void> {
    calls.dispose += 1
  },
}

const cliCommonFactory = async (
  importOriginal: () => Promise<typeof import('../../cli/common.js')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createEmbedder: () => {
      calls.createEmbedder += 1
      return embedderStub
    },
    createVectorStore: (config: Parameters<typeof actual.createVectorStore>[0]) => {
      const store = actual.createVectorStore(config)
      const realOptimize = store.optimize.bind(store)
      const realClose = store.close.bind(store)
      store.optimize = async () => {
        calls.optimize += 1
        await realOptimize()
      }
      store.close = async () => {
        calls.close += 1
        await realClose()
      }
      return store
    },
  }
}

const scanFactory = async (importOriginal: () => Promise<typeof import('../../utils/scan.js')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    // Records the verbatim argument list, then walks the real filesystem, so the
    // depth assertions stay genuine while the arity stays observable.
    bfsCollectSupportedFiles: (...args: Parameters<typeof actual.bfsCollectSupportedFiles>) => {
      calls.scanArgs.push(args)
      return actual.bfsCollectSupportedFiles(...args)
    },
  }
}

const MOCKED_PATHS = ['../../cli/common.js', '../../utils/scan.js'] as const

let runSync: typeof import('../../cli/sync.js').runSync
let VectorStore: typeof import('../../vectordb/index.js').VectorStore
let buildVectorChunks: typeof import('../../ingest/compute.js').buildVectorChunks
let MAX_SCAN_DEPTH: number

// ============================================
// Fixtures
// ============================================

/** Everything this file writes lives under the gitignored project-root `tmp/`. */
const TMP_ROOT = resolve('./tmp/test-cli-sync')

interface Fixture {
  /** Configured root(s) handed to the command through `BASE_DIRS`. */
  roots: string[]
  dbPath: string
  cacheDir: string
}

/**
 * Directory symlinks need admin/developer mode on the `windows-latest` CI leg,
 * so probe support once and skip the symlinked-root suite there rather than
 * failing the job on an environment limitation (same probe as
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

/** `mkfifo` is POSIX-only, so the real-FIFO case is probed the same way. */
function fifoSupported(): boolean {
  const probePath = join(TMP_ROOT, 'fifo-probe.md')
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
 * Prepare an isolated case directory: `<tmp>/<name>/root[N]` as configured
 * root(s), a sibling `db` and `cache` so neither is inside a scanned root.
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
  const fixture: Fixture = {
    roots,
    dbPath: join(caseDir, 'db'),
    cacheDir: join(caseDir, 'cache'),
  }
  process.env['BASE_DIRS'] = JSON.stringify(roots)
  return fixture
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

interface RunOutcome {
  stdout: string
  stderr: string[]
  exitCode: number | undefined
  /** Thrown only when the implementation called `process.exit`. */
  exitError: Error | undefined
}

/** Invoke the subcommand, capturing stdout, stderr, and the exit status. */
async function runCli(fixture: Fixture, args: string[]): Promise<RunOutcome> {
  const stderr: string[] = []
  let stdout = ''
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(' '))
  })
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk)
    return true
  })
  let exitError: Error | undefined
  try {
    await runSync(args, { dbPath: fixture.dbPath, cacheDir: fixture.cacheDir })
  } catch (error) {
    exitError = error as Error
  } finally {
    errorSpy.mockRestore()
    stdoutSpy.mockRestore()
  }
  return { stdout, stderr, exitCode: process.exitCode as number | undefined, exitError }
}

/** Counters the command reports on stdout after a successful run. */
function reportedCounters(outcome: RunOutcome): unknown {
  return JSON.parse(outcome.stdout) as unknown
}

const describeSymlinkedRoot = directorySymlinkSupported() ? describe : describe.skip
const itWithSymlinks = directorySymlinkSupported() ? it : it.skip
const itWithFifos = fifoSupported() ? it : it.skip

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

// ============================================
// Tests
// ============================================

describe('CLI sync', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  const savedBaseDirs = process.env['BASE_DIRS']

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../cli/common.js', cliCommonFactory)
    vi.doMock('../../utils/scan.js', scanFactory)
    ;({ runSync } = await import('../../cli/sync.js'))
    ;({ VectorStore } = await import('../../vectordb/index.js'))
    ;({ buildVectorChunks } = await import('../../ingest/compute.js'))
    ;({ MAX_SCAN_DEPTH } = await import('../../utils/limits.js'))
  })

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
    if (savedBaseDirs === undefined) {
      delete process.env['BASE_DIRS']
    } else {
      process.env['BASE_DIRS'] = savedBaseDirs
    }
    for (const path of MOCKED_PATHS) vi.doUnmock(path)
    vi.resetModules()
  })

  beforeEach(() => {
    calls.createEmbedder = 0
    calls.optimize = 0
    calls.close = 0
    calls.dispose = 0
    calls.scanArgs.length = 0
    process.exitCode = undefined
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })
  })

  afterEach(() => {
    exitSpy.mockRestore()
    process.exitCode = undefined
  })

  // --------------------------------------------
  // Argument parsing: no visual option is exposed
  // --------------------------------------------

  it('shows help with no visual option and exits 0 when --help is passed', async () => {
    const fixture = await makeFixture('help')

    const outcome = await runCli(fixture, ['--help'])

    expect(outcome.exitError?.message).toBe('process.exit(0)')
    const help = outcome.stderr.join('\n')
    expect(help).toContain('sync')
    expect(help).toContain('-h, --help')
    expect(help).not.toContain('--visual')
    expect(help).not.toContain('--dry-run')
  })

  it('rejects --visual with a non-zero exit and mutates nothing', async () => {
    const fixture = await makeFixture('visual-rejected')
    const filePath = await writeFixtureFile(join(fixture.roots[0]!, 'a.md'), 'a'.repeat(200))
    await seedRows(fixture, filePath, 'stale-hash')

    const outcome = await runCli(fixture, ['--visual'])

    expect(outcome.exitError?.message).toBe('process.exit(1)')
    expect(outcome.stderr.join('\n')).toContain('Unknown option: --visual')
    expect(calls.createEmbedder).toBe(0)
    expect(await storedManifest(fixture)).toEqual([
      { filePath, contentHash: 'stale-hash' },
      { filePath, contentHash: 'stale-hash' },
    ])
  })

  // --------------------------------------------
  // Scope validation
  // --------------------------------------------

  it('exits non-zero without mutating when the path is outside every configured root', async () => {
    const fixture = await makeFixture('outside-root')
    const insidePath = await writeFixtureFile(join(fixture.roots[0]!, 'a.md'), 'a'.repeat(200))
    await seedRows(fixture, insidePath, 'stale-hash')
    const outsidePath = join(TMP_ROOT, 'outside-root', 'elsewhere')
    await mkdir(outsidePath, { recursive: true })

    const outcome = await runCli(fixture, [outsidePath])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toBe('')
    const errorLines = outcome.stderr.filter((line) => line.startsWith('Error:'))
    expect(errorLines).toHaveLength(1)
    // The core message already names the path, so the CLI must not append it a
    // second time: the operator sees the offending path exactly once.
    expect(errorLines[0]).toBe(`Error: Sync path is outside every configured root: ${outsidePath}`)
    expect(occurrences(errorLines[0] ?? '', outsidePath)).toBe(1)
    expect(calls.createEmbedder).toBe(0)
    expect(calls.optimize).toBe(0)
    expect(await storedManifest(fixture)).toEqual([
      { filePath: insidePath, contentHash: 'stale-hash' },
      { filePath: insidePath, contentHash: 'stale-hash' },
    ])
  })

  // --------------------------------------------
  // True no-op
  // --------------------------------------------

  it('reports skips only and builds no embedder and no optimize for a byte-identical tree', async () => {
    const fixture = await makeFixture('noop')
    const rootDir = fixture.roots[0]!
    const topContent = `top file content ${'x'.repeat(200)}`
    const nestedContent = `nested file content ${'y'.repeat(200)}`
    const topPath = await writeFixtureFile(join(rootDir, 'top.md'), topContent)
    const nestedPath = await writeFixtureFile(join(rootDir, 'sub', 'nested.md'), nestedContent)
    await seedRows(fixture, topPath, sha256(topContent))
    await seedRows(fixture, nestedPath, sha256(nestedContent))
    const before = await storedManifest(fixture)

    const outcome = await runCli(fixture, [])

    expect(outcome.exitCode).toBeUndefined()
    expect(reportedCounters(outcome)).toEqual({ upserted: 0, skipped: 2, empty: 0, pruned: 0 })
    expect(calls.createEmbedder).toBe(0)
    expect(calls.optimize).toBe(0)
    expect(calls.dispose).toBe(0)
    expect(calls.close).toBe(1)
    expect(await storedManifest(fixture)).toEqual(before)
  })

  // --------------------------------------------
  // add / modify / delete / empty
  // --------------------------------------------

  it('adds, replaces, prunes, and counts an empty file in one run', async () => {
    const fixture = await makeFixture('mixed')
    const rootDir = fixture.roots[0]!
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

    const outcome = await runCli(fixture, [])

    expect(outcome.exitCode).toBeUndefined()
    expect(reportedCounters(outcome)).toEqual({ upserted: 2, skipped: 1, empty: 1, pruned: 1 })
    // One embedder for the whole run, one optimize at the end.
    expect(calls.createEmbedder).toBe(1)
    expect(calls.optimize).toBe(1)
    expect(calls.dispose).toBe(1)

    const manifest = await storedManifest(fixture)
    const pathsPresent = [...new Set(manifest.map((row) => row.filePath))].sort()
    expect(pathsPresent).toEqual([addedPath, changedPath, unchangedPath].sort())
    expect(
      new Set(manifest.filter((row) => row.filePath === addedPath).map((r) => r.contentHash))
    ).toEqual(new Set([sha256(addedContent)]))
    expect(
      new Set(manifest.filter((row) => row.filePath === changedPath).map((r) => r.contentHash))
    ).toEqual(new Set([sha256(changedContent)]))
    expect(manifest.filter((row) => row.filePath === unchangedPath)).toEqual([
      { filePath: unchangedPath, contentHash: sha256(unchangedContent) },
      { filePath: unchangedPath, contentHash: sha256(unchangedContent) },
    ])
    expect(manifest.filter((row) => row.filePath === emptyPath)).toEqual([])
    expect(manifest.filter((row) => row.filePath === gonePath)).toEqual([])

    // Counters alone do not say which file changed, so each mutated path is named.
    // Unchanged files stay silent, which keeps the output proportional to changes.
    const named = outcome.stderr.filter((line) => /^(upserted|pruned) /.test(line)).sort()
    expect(named).toEqual(
      [
        `upserted ${addedPath} (1 chunks)`,
        `upserted ${changedPath} (1 chunks)`,
        `pruned ${gonePath}`,
      ].sort()
    )
    expect(outcome.stderr.join('\n')).not.toContain(unchangedPath)
  })

  // --------------------------------------------
  // Path classification: omitted / directory / file
  // --------------------------------------------

  it('scans every configured root with depth counted from that root when the path is omitted', async () => {
    const fixture = await makeFixture('omitted', 2)
    const firstPath = await writeFixtureFile(
      join(fixture.roots[0]!, 'first.md'),
      `first root document ${'a'.repeat(200)}`
    )
    const secondPath = await writeFixtureFile(
      join(fixture.roots[1]!, 'nested', 'second.md'),
      `second root document ${'b'.repeat(200)}`
    )
    const deepDir = deepChainDir(fixture.roots[0]!, MAX_SCAN_DEPTH)
    const deepPath = await writeFixtureFile(
      join(deepDir, 'deep.md'),
      `too deep for a root-relative scan ${'c'.repeat(200)}`
    )

    const outcome = await runCli(fixture, [])

    expect(outcome.exitCode).toBeUndefined()
    expect(reportedCounters(outcome)).toEqual({ upserted: 2, skipped: 0, empty: 0, pruned: 0 })
    // Both configured roots were scanned, each as its own BFS root, and each with
    // exactly three arguments. The omitted-path route is the one that must never
    // forward a `scope`: its prune scope is the whole index, so an unobserved
    // region hidden from the coverage facts would be maximally dangerous.
    // Configured roots carry the resolver's trailing separator (`BaseDirsConfig`).
    expect(calls.scanArgs).toEqual(
      fixture.roots.map((root) => [
        `${root}${sep}`,
        [`${resolve(fixture.dbPath)}${sep}`, `${resolve(fixture.cacheDir)}${sep}`],
        MAX_SCAN_DEPTH,
      ])
    )
    expect(calls.scanArgs.every((args) => args.length === 3)).toBe(true)
    const storedPaths = [
      ...new Set((await storedManifest(fixture)).map((row) => row.filePath)),
    ].sort()
    expect(storedPaths).toEqual([firstPath, secondPath].sort())
    expect(storedPaths).not.toContain(deepPath)
    // The unobserved region is reported so the operator knows why it was kept.
    expect(outcome.stderr.some((line) => line.includes(deepDir))).toBe(true)
  })

  it('makes an explicit directory the depth-zero BFS root and forwards no scope to the walker', async () => {
    const fixture = await makeFixture('explicit-directory')
    const rootDir = fixture.roots[0]!
    const requestedDir = join(rootDir, 'd1', 'd2')
    const deepDir = deepChainDir(rootDir, MAX_SCAN_DEPTH)
    const deepPath = await writeFixtureFile(
      join(deepDir, 'deep.md'),
      `reachable only when depth restarts ${'c'.repeat(200)}`
    )

    const outcome = await runCli(fixture, [requestedDir])

    expect(outcome.exitCode).toBeUndefined()
    expect(reportedCounters(outcome)).toEqual({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
    const storedPaths = [...new Set((await storedManifest(fixture)).map((row) => row.filePath))]
    expect(storedPaths).toEqual([deepPath])
    // Exactly three arguments: a `scope` filter would hide unobserved regions
    // from the coverage facts and make prune unsafe.
    expect(calls.scanArgs).toHaveLength(1)
    const scanCall = calls.scanArgs[0]!
    expect(scanCall).toEqual([
      requestedDir,
      [`${resolve(fixture.dbPath)}${sep}`, `${resolve(fixture.cacheDir)}${sep}`],
      MAX_SCAN_DEPTH,
    ])
    expect(scanCall).toHaveLength(3)
    expect(scanCall[3]).toBeUndefined()
  })

  it('handles an explicit file directly, with no directory scan and no sibling changes', async () => {
    const fixture = await makeFixture('explicit-file')
    const rootDir = fixture.roots[0]!
    const targetContent = `requested document ${'a'.repeat(200)}`
    const siblingContent = `sibling document ${'b'.repeat(200)}`
    const targetPath = await writeFixtureFile(join(rootDir, 'target.md'), targetContent)
    const siblingPath = await writeFixtureFile(join(rootDir, 'sibling.md'), siblingContent)
    await seedRows(fixture, siblingPath, sha256('an older sibling revision'), 1)

    const outcome = await runCli(fixture, [targetPath])

    expect(outcome.exitCode).toBeUndefined()
    expect(reportedCounters(outcome)).toEqual({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
    // No directory was walked and no depth was evaluated.
    expect(calls.scanArgs).toEqual([])
    const manifest = await storedManifest(fixture)
    expect(
      new Set(manifest.filter((row) => row.filePath === targetPath).map((r) => r.contentHash))
    ).toEqual(new Set([sha256(targetContent)]))
    // The sibling is outside the requested scope: neither re-ingested nor pruned.
    expect(manifest.filter((row) => row.filePath === siblingPath)).toEqual([
      { filePath: siblingPath, contentHash: sha256('an older sibling revision') },
    ])
  })

  // --------------------------------------------
  // An explicitly requested path passes the walker's predicates
  // --------------------------------------------
  //
  // A file the walker discovers must be a non-symlink, non-excluded, supported
  // regular file before its bytes are touched. A path the caller names used to
  // reach `readFile` first and be judged afterwards — by the parser, or (for a
  // FIFO) never. Each case below asserts the controlled message AND that nothing
  // was ingested, which is what "rejected before any read" looks like from
  // outside.

  itWithSymlinks(
    'refuses an explicitly requested symbolic link without reading its target',
    async () => {
      const fixture = await makeFixture('requested-symlink')
      const rootDir = fixture.roots[0]!
      // A perfectly readable, perfectly ingestible .md — outside every root.
      const outsideTarget = await writeFixtureFile(
        join(TMP_ROOT, 'requested-symlink', 'outside', 'secret.md'),
        `a secret outside every configured root ${'s'.repeat(200)}`
      )
      const linkPath = join(rootDir, 'alias.md')
      await symlink(outsideTarget, linkPath, 'file')
      const insidePath = await writeFixtureFile(join(rootDir, 'a.md'), 'a'.repeat(200))
      await seedRows(fixture, insidePath, 'stale-hash')

      const outcome = await runCli(fixture, [linkPath])

      expect(outcome.exitCode).toBe(1)
      expect(outcome.stdout).toBe('')
      const errorLines = outcome.stderr.filter((line) => line.startsWith('Error:'))
      expect(errorLines).toEqual([
        `Error: Sync path is a symbolic link, which sync never follows: ${linkPath}`,
      ])
      expect(calls.createEmbedder).toBe(0)
      expect(calls.optimize).toBe(0)
      // Nothing about the target reached the index, under either spelling.
      expect(await storedManifest(fixture)).toEqual([
        { filePath: insidePath, contentHash: 'stale-hash' },
        { filePath: insidePath, contentHash: 'stale-hash' },
      ])
    }
  )

  it('refuses an explicitly requested file whose extension is unsupported', async () => {
    const fixture = await makeFixture('requested-unsupported')
    const binaryPath = await writeFixtureFile(
      join(fixture.roots[0]!, 'archive.bin'),
      `not a document ${'b'.repeat(200)}`
    )

    const outcome = await runCli(fixture, [binaryPath])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr.filter((line) => line.startsWith('Error:'))).toEqual([
      `Error: Sync path is not a supported document type: ${binaryPath}`,
    ])
    expect(calls.createEmbedder).toBe(0)
    expect(await storedManifest(fixture)).toEqual([])
  })

  it('refuses an explicitly requested path inside the database directory', async () => {
    // The database lives inside the configured root here, which is the only way
    // a managed path can also be a scope-valid request.
    const caseDir = join(TMP_ROOT, 'requested-excluded')
    await rm(caseDir, { recursive: true, force: true })
    const rootDir = join(caseDir, 'root')
    await mkdir(rootDir, { recursive: true })
    const fixture: Fixture = {
      roots: [rootDir],
      dbPath: join(rootDir, '.rag-db'),
      cacheDir: join(caseDir, 'cache'),
    }
    process.env['BASE_DIRS'] = JSON.stringify(fixture.roots)
    const managedPath = await writeFixtureFile(
      join(fixture.dbPath, 'raw-data', 'captured.md'),
      `captured content ${'c'.repeat(200)}`
    )

    const outcome = await runCli(fixture, [managedPath])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr.filter((line) => line.startsWith('Error:'))).toEqual([
      `Error: Sync path is inside the database or cache directory: ${managedPath}`,
    ])
    expect(calls.createEmbedder).toBe(0)
    expect(await storedManifest(fixture)).toEqual([])
  })

  itWithFifos(
    'refuses an explicitly requested FIFO instead of blocking on its bytes',
    async () => {
      const fixture = await makeFixture('requested-fifo')
      const fifoPath = join(fixture.roots[0]!, 'pipe.md')
      execFileSync('mkfifo', [fifoPath])

      // Reading this path never returns, so finishing at all is the assertion:
      // classification refuses it before any read is attempted.
      const outcome = await runCli(fixture, [fifoPath])

      expect(outcome.exitCode).toBe(1)
      expect(outcome.stderr.filter((line) => line.startsWith('Error:'))).toEqual([
        `Error: Sync path is not a regular file or directory: ${fifoPath}`,
      ])
      expect(calls.createEmbedder).toBe(0)
    },
    20000
  )

  // --------------------------------------------
  // The configured file-size limit bounds the hash read
  // --------------------------------------------

  it('skips an oversized file with a warning, keeps its rows, and reconciles the rest', async () => {
    const fixture = await makeFixture('oversized')
    const rootDir = fixture.roots[0]!
    const savedMaxFileSize = process.env['MAX_FILE_SIZE']
    // Small enough that the oversized fixture stays cheap, large enough for the
    // other documents to remain ingestible.
    process.env['MAX_FILE_SIZE'] = '1024'
    try {
      const oversizedPath = await writeFixtureFile(join(rootDir, 'huge.md'), 'h'.repeat(5000))
      const addedPath = await writeFixtureFile(
        join(rootDir, 'added.md'),
        `added document ${'a'.repeat(200)}`
      )
      const gonePath = join(rootDir, 'gone.md')
      await seedRows(fixture, oversizedPath, 'hash-from-a-run-with-a-larger-limit')
      await seedRows(fixture, gonePath, sha256('deleted from disk'))

      const outcome = await runCli(fixture, [])

      expect(outcome.exitCode).toBeUndefined()
      // The oversized file is neither upserted nor pruned; everything else is
      // reconciled normally, so one huge file cannot stall the whole root.
      expect(reportedCounters(outcome)).toEqual({
        upserted: 1,
        skipped: 0,
        empty: 0,
        pruned: 1,
      })
      // The operator is told which path was skipped and why prune was withheld.
      expect(
        outcome.stderr.filter(
          (line) => line.includes(oversizedPath) && line.includes('maximum file size')
        )
      ).toHaveLength(1)

      const manifest = await storedManifest(fixture)
      // THE assertion: its stored rows survived the run untouched.
      expect(manifest.filter((row) => row.filePath === oversizedPath)).toEqual([
        { filePath: oversizedPath, contentHash: 'hash-from-a-run-with-a-larger-limit' },
        { filePath: oversizedPath, contentHash: 'hash-from-a-run-with-a-larger-limit' },
      ])
      expect(
        new Set(manifest.filter((row) => row.filePath === addedPath).map((row) => row.contentHash))
      ).toEqual(new Set([sha256(`added document ${'a'.repeat(200)}`)]))
      expect(manifest.filter((row) => row.filePath === gonePath)).toEqual([])
    } finally {
      if (savedMaxFileSize === undefined) {
        delete process.env['MAX_FILE_SIZE']
      } else {
        process.env['MAX_FILE_SIZE'] = savedMaxFileSize
      }
    }
  })

  it('keeps the rows of an explicitly requested oversized file', async () => {
    const fixture = await makeFixture('oversized-explicit')
    const savedMaxFileSize = process.env['MAX_FILE_SIZE']
    process.env['MAX_FILE_SIZE'] = '1024'
    try {
      const oversizedPath = await writeFixtureFile(
        join(fixture.roots[0]!, 'huge.md'),
        'h'.repeat(5000)
      )
      await seedRows(fixture, oversizedPath, 'hash-from-a-run-with-a-larger-limit')

      const outcome = await runCli(fixture, [oversizedPath])

      // A single-file scope whose only file was not observed prunes nothing: the
      // run succeeds, reports nothing done, and leaves the rows searchable.
      expect(outcome.exitCode).toBeUndefined()
      expect(reportedCounters(outcome)).toEqual({
        upserted: 0,
        skipped: 0,
        empty: 0,
        pruned: 0,
      })
      expect(calls.createEmbedder).toBe(0)
      expect(await storedManifest(fixture)).toEqual([
        { filePath: oversizedPath, contentHash: 'hash-from-a-run-with-a-larger-limit' },
        { filePath: oversizedPath, contentHash: 'hash-from-a-run-with-a-larger-limit' },
      ])
    } finally {
      if (savedMaxFileSize === undefined) {
        delete process.env['MAX_FILE_SIZE']
      } else {
        process.env['MAX_FILE_SIZE'] = savedMaxFileSize
      }
    }
  })

  // --------------------------------------------
  // First error stops the run (SYNC-004)
  // --------------------------------------------

  it('stops at the first failure with one stderr error, no prune, and earlier upserts retained', async () => {
    const fixture = await makeFixture('first-error')
    const rootDir = fixture.roots[0]!
    // BFS reads the root's own entries before descending, so `first.md` is
    // always ingested before the failing `deep/fails.md`.
    const firstContent = `first document ${'a'.repeat(200)}`
    const failingContent = `${FAIL_MARKER} document ${'b'.repeat(200)}`
    const untouchedContent = `untouched document ${'c'.repeat(200)}`
    const firstPath = await writeFixtureFile(join(rootDir, 'first.md'), firstContent)
    const failingPath = await writeFixtureFile(join(rootDir, 'deep', 'fails.md'), failingContent)
    const untouchedPath = await writeFixtureFile(
      join(rootDir, 'deep', 'untouched.md'),
      untouchedContent
    )
    const gonePath = join(rootDir, 'gone.md')
    await seedRows(fixture, firstPath, sha256('an older first revision'))
    await seedRows(fixture, failingPath, sha256('an older failing revision'))
    await seedRows(fixture, untouchedPath, sha256(untouchedContent))
    await seedRows(fixture, gonePath, sha256('deleted from disk'))

    const outcome = await runCli(fixture, [])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stdout).toBe('')
    const errorLines = outcome.stderr.filter((line) => line.startsWith('Error:'))
    expect(errorLines).toHaveLength(1)
    // The per-file failure message carries no path of its own, so the appended
    // suffix is the only thing identifying which file failed.
    expect(errorLines[0]).toBe(`Error: induced embedding failure (${failingPath})`)
    expect(occurrences(errorLines[0] ?? '', failingPath)).toBe(1)
    // Prune and optimize are both abandoned after the first error.
    expect(calls.optimize).toBe(0)

    const manifest = await storedManifest(fixture)
    // The upsert that completed before the failure is retained.
    expect(
      new Set(manifest.filter((row) => row.filePath === firstPath).map((r) => r.contentHash))
    ).toEqual(new Set([sha256(firstContent)]))
    // The failing file kept its previous rows (construction precedes deletion).
    expect(manifest.filter((row) => row.filePath === failingPath)).toEqual([
      { filePath: failingPath, contentHash: sha256('an older failing revision') },
      { filePath: failingPath, contentHash: sha256('an older failing revision') },
    ])
    // An unchanged file is never touched, and the prune candidate survives.
    expect(manifest.filter((row) => row.filePath === untouchedPath)).toEqual([
      { filePath: untouchedPath, contentHash: sha256(untouchedContent) },
      { filePath: untouchedPath, contentHash: sha256(untouchedContent) },
    ])
    expect(manifest.filter((row) => row.filePath === gonePath)).toEqual([
      { filePath: gonePath, contentHash: sha256('deleted from disk') },
      { filePath: gonePath, contentHash: sha256('deleted from disk') },
    ])
  })

  // --------------------------------------------
  // Symlinked configured root
  // --------------------------------------------
  //
  // Every other case lives where resolve() and realpath() agree, so the choice
  // between the resolver's `rawBaseDirs` (resolve()-only) and `baseDirs`
  // (realpath'd) is invisible there. Under a symlinked root prefix — macOS
  // `/tmp`, a symlinked home or mount, a Windows junction — scanning in the
  // realpath space yields spellings the DB never holds, so nothing ever
  // converges: the whole tree is re-ingested on every run and a second row set
  // accumulates per file. The core cannot catch this: it receives roots as an
  // injected value and knows nothing of the resolver.

  describeSymlinkedRoot('with a symlinked configured root', () => {
    it('stores the symlink spelling and converges on the second run', async () => {
      const caseDir = join(TMP_ROOT, 'symlinked-root')
      await rm(caseDir, { recursive: true, force: true })
      const realRoot = join(caseDir, 'real')
      const linkRoot = join(caseDir, 'link')
      const outsideTarget = join(caseDir, 'outside-target')
      await mkdir(realRoot, { recursive: true })
      await mkdir(outsideTarget, { recursive: true })
      await symlink(realRoot, linkRoot, 'dir')
      await symlink(outsideTarget, join(realRoot, 'inner-link'), 'dir')
      // The walker starts at the configured (symlink) spelling, so that is the
      // spelling every path it reports carries.
      const scannedInnerLink = join(linkRoot, 'inner-link')
      const fixture: Fixture = {
        roots: [linkRoot],
        dbPath: join(caseDir, 'db'),
        cacheDir: join(caseDir, 'cache'),
      }
      process.env['BASE_DIRS'] = JSON.stringify(fixture.roots)
      const content = `document under a symlinked root ${'a'.repeat(200)}`
      // Written through the symlink, so the file exists under both spellings.
      const linkSpelling = await writeFixtureFile(join(linkRoot, 'doc.md'), content)

      const first = await runCli(fixture, [])

      expect(first.exitCode).toBeUndefined()
      expect(reportedCounters(first)).toEqual({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
      expect(await storedManifest(fixture)).toEqual([
        { filePath: linkSpelling, contentHash: sha256(content) },
      ])
      // The skipped symlink is named so the operator knows why prune was withheld
      // under it; the wording itself is not a contract.
      expect(first.stderr.some((line) => line.includes(scannedInnerLink))).toBe(true)

      const second = await runCli(fixture, [])

      expect(second.exitCode).toBeUndefined()
      expect(reportedCounters(second)).toEqual({ upserted: 0, skipped: 1, empty: 0, pruned: 0 })
      expect(await storedManifest(fixture)).toEqual([
        { filePath: linkSpelling, contentHash: sha256(content) },
      ])
    })
  })

  // --------------------------------------------
  // A path named THROUGH a symlinked directory
  // --------------------------------------------
  //
  // `resolve()` is lexical: it cannot see that an intermediate component of the
  // requested path is a symbolic link, so `<root>/link/x.md` looks in-root while
  // its real location is outside every configured root. The walk is unaffected
  // (it never descends into a link entry), so this is the one route that has to
  // be closed, and it has to be closed before anything reads the target.

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
      const fixture: EscapeFixture = {
        roots: [rootDir],
        dbPath: join(caseDir, 'db'),
        cacheDir: join(caseDir, 'cache'),
        rootDir,
        outsideDir,
      }
      process.env['BASE_DIRS'] = JSON.stringify(fixture.roots)
      return fixture
    }

    it('refuses an out-of-root file named through the link, ingesting and disclosing nothing', async () => {
      const fixture = await makeEscapeFixture('escape-file')
      const requestedPath = join(fixture.rootDir, 'link', 'inner.md')
      await writeFile(requestedPath, `out-of-root document ${'s'.repeat(200)}`)
      const insidePath = await writeFixtureFile(join(fixture.rootDir, 'a.md'), 'a'.repeat(200))
      await seedRows(fixture, insidePath, 'stale-hash')

      const outcome = await runCli(fixture, [requestedPath])

      expect(outcome.exitCode).toBe(1)
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr.filter((line) => line.startsWith('Error:'))).toEqual([
        `Error: Sync path is outside every configured root: ${requestedPath}`,
      ])
      // Nothing about the real location leaks, under any spelling.
      expect(outcome.stderr.join('\n')).not.toContain(fixture.outsideDir)
      // No embedder was built and no row was written for the out-of-root file:
      // its bytes were never hashed or parsed.
      expect(calls.createEmbedder).toBe(0)
      expect(await storedManifest(fixture)).toEqual([
        { filePath: insidePath, contentHash: 'stale-hash' },
        { filePath: insidePath, contentHash: 'stale-hash' },
      ])
    })

    it('refuses an out-of-root directory named through the link and scans nothing under it', async () => {
      const fixture = await makeEscapeFixture('escape-directory')
      const requestedPath = join(fixture.rootDir, 'link', 'quiet')
      await writeFixtureFile(
        join(requestedPath, 'hidden.md'),
        `out-of-root document ${'h'.repeat(200)}`
      )

      const outcome = await runCli(fixture, [requestedPath])

      expect(outcome.exitCode).toBe(1)
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr.filter((line) => line.startsWith('Error:'))).toEqual([
        `Error: Sync path is outside every configured root: ${requestedPath}`,
      ])
      // No entry under the out-of-root directory is named anywhere in the output.
      expect(outcome.stderr.join('\n')).not.toContain('hidden.md')
      expect(outcome.stderr.join('\n')).not.toContain(fixture.outsideDir)
      expect(calls.createEmbedder).toBe(0)
      expect(await storedManifest(fixture)).toEqual([])
    })

    // The assertion that kills the oracle: one requested path, three states of
    // the out-of-root target, one byte-identical message. Anything that varied
    // per state would tell the caller whether a path outside the roots exists
    // and whether it is readable.
    it('answers with one identical message whether the out-of-root target is readable, unreadable, or absent', async () => {
      const fixture = await makeEscapeFixture('escape-oracle')
      const requestedPath = join(fixture.rootDir, 'link', 'probe.md')
      const expectedMessage = `Error: Sync path is outside every configured root: ${requestedPath}`
      const errorsOf = (outcome: RunOutcome): string[] =>
        outcome.stderr.filter((line) => line.startsWith('Error:'))

      await writeFile(requestedPath, `out-of-root document ${'p'.repeat(200)}`)
      const readable = await runCli(fixture, [requestedPath])

      process.exitCode = undefined
      await chmod(requestedPath, 0o000)
      const unreadable = await runCli(fixture, [requestedPath])

      process.exitCode = undefined
      await chmod(requestedPath, 0o600)
      await rm(requestedPath)
      const absent = await runCli(fixture, [requestedPath])

      expect(errorsOf(readable)).toEqual([expectedMessage])
      expect(errorsOf(unreadable)).toEqual(errorsOf(readable))
      expect(errorsOf(absent)).toEqual(errorsOf(readable))
      for (const outcome of [readable, unreadable, absent]) {
        expect(outcome.stdout).toBe('')
        expect(outcome.stderr.join('\n')).not.toContain(fixture.outsideDir)
      }
    })
  })

  // The collapse above applies only to out-of-root requests: an in-root path
  // names nothing the caller did not already know, so its specific message
  // stays.
  it('keeps the specific message for an in-root path that does not exist', async () => {
    const fixture = await makeFixture('requested-missing')
    const missingPath = join(fixture.roots[0]!, 'ghost.md')

    const outcome = await runCli(fixture, [missingPath])

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stderr.filter((line) => line.startsWith('Error:'))).toEqual([
      `Error: Sync path does not exist: ${missingPath}`,
    ])
    expect(calls.createEmbedder).toBe(0)
  })

  // --------------------------------------------
  // Cleanup
  // --------------------------------------------

  it('closes the store and disposes the embedder after a failing run', async () => {
    const fixture = await makeFixture('cleanup')
    const rootDir = fixture.roots[0]!
    await writeFixtureFile(join(rootDir, 'fails.md'), `${FAIL_MARKER} content ${'b'.repeat(200)}`)

    const outcome = await runCli(fixture, [])

    expect(outcome.exitCode).toBe(1)
    expect(calls.createEmbedder).toBe(1)
    expect(calls.dispose).toBe(1)
    expect(calls.close).toBe(1)
  })
})
