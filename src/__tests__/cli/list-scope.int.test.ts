// INT-3: `runList(--scope)` CLI integration (Phase 3 Task 2).
//
// AC: AC2 (repeatable `--scope` parsed + documented in HELP_TEXT) / AC3 (files
//     restricted exact-or-descendant on the scan path + symlink-alias contract) /
//     AC6 (raw-data sources always kept; real-file entries scope-filtered from
//     both files[] and sources[]) / AC9 (empty/whitespace/malformed `--scope`
//     rejected with a non-zero exit and a clear stderr message).
// Behavior: `runList(['--base-dir', dataDir, '--scope', inScopeDir], global)` over
//     a real LanceDB + real-FS fixture → BFS pushdown prunes scope-outside
//     subtrees → scoped stdout files[], raw-data sources retained, out-of-scope
//     real-file ingested entry excluded from files[] AND sources[], no
//     scope-outside SCANNED path reaches realpathForMatch, symlink-alias entry
//     included with its stored filePath spelling; empty/whitespace/missing
//     `--scope` exits non-zero with a stderr message and config resolution still
//     fires even when scope is present.
// @category: integration
// @lane: integration
// @dependency: CLI runList + real LanceDB + real-FS fixture (mkdir/symlink) + RAGServer (fixture ingest) + realpathForMatch spy
// @complexity: high (real embed/DB ingest, scan-path pushdown spy, symlink-alias fixture)
// ROI: 72
//
// Mocking strategy (shared-registry safe per project-context: isolate:false,
// pool forks, maxWorkers 1): `../../utils/scan.js` is partial-mocked via
// vi.doMock so `realpathForMatch` RECORDS its argument then DELEGATES to the
// real implementation; `runList` (and the fixture-ingesting RAGServer) are
// dynamically imported AFTER doMock and the mock is removed via doUnmock +
// resetModules in afterAll. Only the CLI SCANNED call site (list.ts:268) is
// asserted: the probe path is an UNINGESTED out-of-scope file, so it can reach
// realpathForMatch solely through the scanned loop — the unchanged ingested-side
// loop (list.ts:253) never sees it, so it cannot confound the proof. DB and FS
// are otherwise real; runList itself needs no embedder (VectorStore only).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalOptions } from '../../cli/options.js'
import { testModelCacheDir, withTestDevice } from '../test-device.js'
import { expectError } from '../test-doubles.js'

// Records every path passed to the (spied) realpathForMatch, in call order.
const realpathCalls: string[] = []

// Directory symlinks require admin/developer mode on windows-latest (in the CI
// matrix); probe support once so the alias contract describe is skipped there
// rather than failing the job on an environment limitation.
function directorySymlinkSupported(): boolean {
  const probeBase = mkdtempSync(join(tmpdir(), 'cli-list-scope-symlink-probe-'))
  try {
    const target = join(probeBase, 'target')
    mkdirSync(target)
    symlinkSync(target, join(probeBase, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeBase, { recursive: true, force: true })
  }
}

let runList: typeof import('../../cli/list.js').runList
let RAGServer: typeof import('../../server/index.js').RAGServer

async function installScanSpyAndImportModules(): Promise<void> {
  vi.doMock('../../utils/scan.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../utils/scan.js')>()
    return {
      ...actual,
      realpathForMatch: vi.fn(async (filePath: string) => {
        realpathCalls.push(filePath)
        return actual.realpathForMatch(filePath)
      }),
    }
  })
  vi.resetModules()
  ;({ runList } = await import('../../cli/list.js'))
  ;({ RAGServer } = await import('../../server/index.js'))
}

/**
 * Run `runList` capturing stdout writes and stderr, with `process.exit` mocked
 * to throw so a non-zero exit surfaces as a caught error rather than killing the
 * test runner.
 */
/** Everything one captured `runList` invocation produced. */
interface CapturedRun {
  stdout: string[]
  stderr: string[]
  error: unknown
}

function captureRunList(args: string[], globalOptions: GlobalOptions) {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return true
    })
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
  return runList(args, globalOptions)
    .then((): CapturedRun => ({ stdout, stderr, error: undefined }))
    .catch((error: unknown): CapturedRun => ({ stdout, stderr, error }))
    .finally(() => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
    })
}

describe('INT-3: runList(--scope) — scoped files, sources split, pushdown proof', () => {
  const base = resolve('./tmp/test-cli-list-scope-int')
  const dataDir = join(base, 'data')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')

  const inScopeDir = join(dataDir, 'in-scope')
  const inScopeFile = join(inScopeDir, 'keep.txt')
  // In-scope but NOT ingested: reachable only via the scanned-file loop, so it
  // is the airtight non-vacuousness probe for the realpathForMatch spy (an
  // ingested file would also be realpath'd by the ingested-side loop).
  const inScopeUningested = join(inScopeDir, 'scanned-only.txt')
  const deepDir = join(inScopeDir, 'deep')
  const deepFile = join(deepDir, 'deep-keep.txt')

  const outScopeDir = join(dataDir, 'out-scope')
  const outScopeUningested = join(outScopeDir, 'uningested.txt')
  const outScopeIngested = join(outScopeDir, 'ingested-out.txt')

  const secondScopeDir = join(dataDir, 'second-scope')
  const secondScopeFile = join(secondScopeDir, 'second-keep.txt')

  const rawSource = 'https://example.com/int3-raw-source'

  const globalOptions = { dbPath, cacheDir, modelName: 'Xenova/all-MiniLM-L6-v2' }

  let server: InstanceType<typeof import('../../server/index.js').RAGServer>

  beforeAll(async () => {
    mkdirSync(inScopeDir, { recursive: true })
    mkdirSync(deepDir, { recursive: true })
    mkdirSync(outScopeDir, { recursive: true })
    mkdirSync(secondScopeDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(inScopeFile, 'In-scope file content. '.repeat(20))
    writeFileSync(inScopeUningested, 'In-scope UNINGESTED file. '.repeat(20))
    writeFileSync(deepFile, 'Deep in-scope file content. '.repeat(20))
    writeFileSync(outScopeUningested, 'Out-of-scope UNINGESTED file. '.repeat(20))
    writeFileSync(outScopeIngested, 'Out-of-scope ingested file. '.repeat(20))
    writeFileSync(secondScopeFile, 'Second-scope file content. '.repeat(20))

    await installScanSpyAndImportModules()

    // Ingest the fixture via a real RAGServer (real embed + LanceDB). runList
    // then reads the same dbPath; listing needs no embedder.
    server = new RAGServer(
      withTestDevice({
        dbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(cacheDir),
        baseDir: dataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()

    await server.handleIngestFile({ filePath: inScopeFile })
    await server.handleIngestFile({ filePath: deepFile })
    await server.handleIngestFile({ filePath: secondScopeFile })
    await server.handleIngestFile({ filePath: outScopeIngested })
    await server.handleIngestData({
      content:
        'Raw-data content ingested via ingest_data for the INT-3 CLI scope test. ' +
        'Long enough to produce at least one chunk in the vector store.',
      metadata: { source: rawSource, format: 'text' },
    })
  }, 120000)

  afterAll(async () => {
    if (server) {
      await server.close()
    }
    vi.doUnmock('../../utils/scan.js')
    vi.resetModules()
    rmSync(base, { recursive: true, force: true })
  })

  it('restricts stdout files[] to the in-scope subtree (out-of-scope files excluded)', async () => {
    const { stdout, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', inScopeDir],
      globalOptions
    )
    expect(error).toBeUndefined()
    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

    expect(filePaths).toContain(inScopeFile)
    expect(filePaths).toContain(deepFile)
    expect(filePaths).toContain(inScopeUningested)
    expect(filePaths).not.toContain(outScopeUningested)
    expect(filePaths).not.toContain(outScopeIngested)
    expect(filePaths).not.toContain(secondScopeFile)

    // Config resolution still fires with scope present (missing-config proof).
    // rawBaseDirs carry a trailing separator (base-dirs normal-path form), so
    // assert the resolved root without coupling to that exact spelling.
    expect(parsed.baseDirs).toHaveLength(1)
    expect(parsed.baseDir).toBe(parsed.baseDirs[0])
    expect(parsed.baseDir.startsWith(dataDir)).toBe(true)
  })

  it('unions results across repeated --scope flags', async () => {
    const { stdout, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', inScopeDir, '--scope', secondScopeDir],
      globalOptions
    )
    expect(error).toBeUndefined()
    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

    expect(filePaths).toContain(inScopeFile)
    expect(filePaths).toContain(secondScopeFile)
    expect(filePaths).not.toContain(outScopeUningested)
    expect(filePaths).not.toContain(outScopeIngested)
  })

  it('keeps raw-data sources regardless of scope', async () => {
    const { stdout, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', inScopeDir],
      globalOptions
    )
    expect(error).toBeUndefined()
    const parsed = JSON.parse(stdout.join(''))

    const sourceEntry = parsed.sources.find((s: { source?: string }) => s.source === rawSource)
    expect(sourceEntry).toBeDefined()
  })

  it('excludes an out-of-scope real-file ingested entry from BOTH files[] and sources[] (AC6 negative)', async () => {
    const { stdout, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', inScopeDir],
      globalOptions
    )
    expect(error).toBeUndefined()
    const parsed = JSON.parse(stdout.join(''))

    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
    const sourcePaths: string[] = parsed.sources.map((s: { filePath?: string }) => s.filePath)

    expect(filePaths).not.toContain(outScopeIngested)
    expect(sourcePaths).not.toContain(outScopeIngested)
  })

  it('lists every file when no --scope is given (scope-absent no-op)', async () => {
    const { stdout, error } = await captureRunList(['--base-dir', dataDir], globalOptions)
    expect(error).toBeUndefined()
    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

    expect(filePaths).toContain(inScopeFile)
    expect(filePaths).toContain(deepFile)
    expect(filePaths).toContain(outScopeUningested)
    expect(filePaths).toContain(outScopeIngested)

    const sourceEntry = parsed.sources.find((s: { source?: string }) => s.source === rawSource)
    expect(sourceEntry).toBeDefined()
  })

  it('never routes a scope-outside SCANNED path through realpathForMatch (CLI-side pushdown proof, AC4)', async () => {
    realpathCalls.length = 0
    const { error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', inScopeDir],
      globalOptions
    )
    expect(error).toBeUndefined()

    // The uningested out-of-scope file can only reach realpathForMatch via the
    // scanned loop (list.ts:268). Under correct pushdown the walker prunes
    // out-scope, so its path is never a call argument.
    expect(realpathCalls).not.toContain(outScopeUningested)

    // Non-vacuousness: the scanned loop DID run realpathForMatch over an
    // in-scope file that is reachable ONLY via the scan (uningested, so the
    // ingested-side loop never touches it) — proving the assertion above is not
    // vacuously satisfied by a walker that produced nothing.
    expect(realpathCalls).toContain(inScopeUningested)
  })

  it('documents --scope in the help text', async () => {
    const { stderr, error } = await captureRunList(['--help'], globalOptions)
    expect(expectError(error).message).toBe('process.exit(0)')
    const joined = stderr.join('\n')
    expect(joined).toContain('--scope')
  })
})

// AC9: empty / whitespace / missing --scope rejected, plus config resolution
// still fires when scope is present. These cases exit before any DB access, so
// they need no fixture — a valid dbPath/cacheDir keeps resolveGlobalConfig happy.
describe('INT-3: runList(--scope) — validation and config-resolution ordering (AC9)', () => {
  const base = resolve('./tmp/test-cli-list-scope-validate')
  const dataDir = join(base, 'data')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')
  const globalOptions = { dbPath, cacheDir, modelName: 'Xenova/all-MiniLM-L6-v2' }

  let localRunList: typeof import('../../cli/list.js').runList
  let stderr: string[]

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    vi.resetModules()
    ;({ runList: localRunList } = await import('../../cli/list.js'))
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  beforeEach(() => {
    stderr = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      stderr.push(a.map(String).join(' '))
    })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an empty --scope value with a non-zero exit and a clear stderr message', async () => {
    await expect(
      localRunList(['--base-dir', dataDir, '--scope', ''], globalOptions)
    ).rejects.toThrow('process.exit(1)')
    expect(stderr.join('\n')).toContain('--scope')
  })

  it('rejects a whitespace-only --scope value with a non-zero exit', async () => {
    await expect(
      localRunList(['--base-dir', dataDir, '--scope', '   '], globalOptions)
    ).rejects.toThrow('process.exit(1)')
    expect(stderr.join('\n')).toContain('--scope')
  })

  it('rejects a --scope flag with a missing value (next token is a flag)', async () => {
    await expect(
      localRunList(['--base-dir', dataDir, '--scope', '--help'], globalOptions)
    ).rejects.toThrow('process.exit(1)')
    expect(stderr.join('\n')).toContain('Missing value for --scope')
  })

  it('still resolves base dirs (config) even when --scope is present — nonexistent root exits non-zero', async () => {
    const missingRoot = join(base, 'does-not-exist')
    await expect(
      localRunList(['--base-dir', missingRoot, '--scope', join(missingRoot, 'sub')], globalOptions)
    ).rejects.toThrow('process.exit(1)')
    // The error came from config resolution, proving scope parsing did not
    // bypass resolveCliBaseDirsOrExit.
    expect(stderr.length).toBeGreaterThan(0)
  })
})

// AC3 path-basis / symlink-alias contract: under an aliased (dir-symlinked)
// baseDir, an ingested file whose SCAN path is under scope but whose stored
// filePath uses a different (real) spelling is included, and the returned
// filePath keeps its stored spelling.
const describeAlias = directorySymlinkSupported() ? describe : describe.skip

describeAlias('INT-3: runList(--scope) — symlink-alias contract (AC3)', () => {
  const base = resolve('./tmp/test-cli-list-scope-alias')
  const realRoot = join(base, 'real')
  const aliasRoot = join(base, 'alias')
  const realSubDir = join(realRoot, 'sub')
  const realFile = join(realSubDir, 'aliased.txt')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')
  const globalOptions = { dbPath, cacheDir, modelName: 'Xenova/all-MiniLM-L6-v2' }

  let server: InstanceType<typeof import('../../server/index.js').RAGServer>

  beforeAll(async () => {
    mkdirSync(realSubDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(realFile, 'Aliased file content. '.repeat(20))

    // Symlink support was confirmed by `directorySymlinkSupported` before this
    // describe was selected, so the dir symlink creation here is expected to
    // succeed.
    symlinkSync(realRoot, aliasRoot, 'dir')

    await installScanSpyAndImportModules()

    server = new RAGServer(
      withTestDevice({
        dbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(cacheDir),
        baseDir: aliasRoot,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()

    // Ingest via the REAL spelling so the stored filePath differs from the scan
    // path; realpath containment permits it.
    await server.handleIngestFile({ filePath: realFile })
  }, 120000)

  afterAll(async () => {
    if (server) {
      await server.close()
    }
    vi.doUnmock('../../utils/scan.js')
    vi.resetModules()
    rmSync(base, { recursive: true, force: true })
  })

  it('includes an aliased ingested file (scan path under scope) with its stored filePath spelling', async () => {
    const aliasScopeDir = join(aliasRoot, 'sub')
    const { stdout, error } = await captureRunList(
      ['--base-dir', aliasRoot, '--scope', aliasScopeDir],
      globalOptions
    )
    expect(error).toBeUndefined()
    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

    // Stored (real) spelling is returned, not the alias scan spelling.
    expect(filePaths).toContain(realFile)
    expect(filePaths).not.toContain(join(aliasScopeDir, 'aliased.txt'))

    const entry = parsed.files.find((f: { filePath: string }) => f.filePath === realFile)
    expect(entry.ingested).toBe(true)
  })
})
