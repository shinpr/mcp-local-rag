// INT-1: `handleListFiles(scope)` MCP-handler integration (Phase 2 Task 2).
//
// AC: AC3 (scan-path basis + alias contract) / AC4 (handler-side pushdown:
//     scanned-file realpathForMatch runs only over the pruned in-scope result) /
//     AC6 (raw-data sources always kept; real-file entries scope-filtered from
//     both files[] and sources[]) / AC12 (no-arg accepted as no-scope).
// Behavior: `handleListFiles({ scope })` over a real LanceDB + real-FS fixture
//     → BFS pushdown prunes scope-outside subtrees → scoped files[], raw-data
//     sources retained, out-of-scope real-file orphan excluded, no scope-outside
//     SCANNED path reaches realpathForMatch, symlink-alias entry included with
//     its stored filePath spelling.
// @category: integration
// @lane: integration
// @dependency: RAGServer handler + real LanceDB + real-FS fixture (mkdir/symlink) + realpathForMatch spy
// @complexity: high (real embed/DB init, scan-path pushdown spy, symlink-alias fixture)
// ROI: 96
//
// Mocking strategy (shared-registry safe per project-context: isolate:false,
// pool forks, maxWorkers 1): `../../utils/scan.js` is partial-mocked via
// vi.doMock so `realpathForMatch` RECORDS its argument then DELEGATES to the
// real implementation; RAGServer is dynamically imported AFTER doMock and the
// mock is removed via doUnmock + resetModules in afterAll. Only the SCANNED
// call site (index.ts:668) is asserted: the probe path is an UNINGESTED
// out-of-scope file, so it can reach realpathForMatch solely through the
// scanned loop — the unchanged ingested-side loop (index.ts:647) never sees it,
// so it cannot confound the proof. DB and FS are otherwise real.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../test-device.js'

// Records every path passed to the (spied) realpathForMatch, in call order.
const realpathCalls: string[] = []

// Directory symlinks require admin/developer mode on windows-latest (in the CI
// matrix); probe support once so the alias contract describe is skipped there
// rather than failing the job on an environment limitation.
function directorySymlinkSupported(): boolean {
  const probeBase = mkdtempSync(join(tmpdir(), 'list-scope-symlink-probe-'))
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

let RAGServer: typeof import('../../server/index.js').RAGServer

async function installScanSpyAndImportServer(): Promise<void> {
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
  ;({ RAGServer } = await import('../../server/index.js'))
}

describe('INT-1: handleListFiles(scope) — scoped files, sources split, pushdown proof', () => {
  const base = resolve('./tmp/test-list-files-scope-int')
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

  const rawSource = 'https://example.com/int1-raw-source'

  let server: InstanceType<typeof import('../../server/index.js').RAGServer>

  beforeAll(async () => {
    mkdirSync(inScopeDir, { recursive: true })
    mkdirSync(deepDir, { recursive: true })
    mkdirSync(outScopeDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(inScopeFile, 'In-scope file content. '.repeat(20))
    writeFileSync(inScopeUningested, 'In-scope UNINGESTED file. '.repeat(20))
    writeFileSync(deepFile, 'Deep in-scope file content. '.repeat(20))
    writeFileSync(outScopeUningested, 'Out-of-scope UNINGESTED file. '.repeat(20))
    writeFileSync(outScopeIngested, 'Out-of-scope ingested file. '.repeat(20))

    await installScanSpyAndImportServer()

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

    // Ingest the two in-scope files and the out-of-scope real file, plus one
    // raw-data source. `uningested.txt` is deliberately NOT ingested — it is the
    // scanned-loop pushdown probe.
    await server.handleIngestFile({ filePath: inScopeFile })
    await server.handleIngestFile({ filePath: deepFile })
    await server.handleIngestFile({ filePath: outScopeIngested })
    await server.handleIngestData({
      content:
        'Raw-data content ingested via ingest_data for the INT-1 scope test. ' +
        'Long enough to produce at least one chunk in the vector store.',
      metadata: { source: rawSource, format: 'text' },
    })
  }, 120000)

  afterAll(async () => {
    await server.close()
    vi.doUnmock('../../utils/scan.js')
    vi.resetModules()
    rmSync(base, { recursive: true, force: true })
  })

  it('restricts files[] to the in-scope subtree (out-of-scope files excluded)', async () => {
    const result = await server.handleListFiles({ scope: inScopeDir })
    const parsed = JSON.parse(result.content[0].text)
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

    expect(filePaths).toContain(inScopeFile)
    expect(filePaths).toContain(deepFile)
    expect(filePaths).not.toContain(outScopeUningested)
    expect(filePaths).not.toContain(outScopeIngested)
  })

  it('keeps raw-data sources regardless of scope', async () => {
    const result = await server.handleListFiles({ scope: inScopeDir })
    const parsed = JSON.parse(result.content[0].text)

    const sourceEntry = parsed.sources.find((s: { source?: string }) => s.source === rawSource)
    expect(sourceEntry).toBeDefined()
  })

  it('excludes an out-of-scope real-file ingested entry from BOTH files[] and sources[] (AC6 negative)', async () => {
    const result = await server.handleListFiles({ scope: inScopeDir })
    const parsed = JSON.parse(result.content[0].text)

    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
    const sourcePaths: string[] = parsed.sources.map((s: { filePath?: string }) => s.filePath)

    expect(filePaths).not.toContain(outScopeIngested)
    expect(sourcePaths).not.toContain(outScopeIngested)
  })

  it('accepts a no-arg call as "no scope" and returns every file (AC12)', async () => {
    const result = await server.handleListFiles()
    const parsed = JSON.parse(result.content[0].text)
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

    expect(filePaths).toContain(inScopeFile)
    expect(filePaths).toContain(deepFile)
    expect(filePaths).toContain(outScopeUningested)
    expect(filePaths).toContain(outScopeIngested)

    // Raw-data source still present with no scope.
    const sourceEntry = parsed.sources.find((s: { source?: string }) => s.source === rawSource)
    expect(sourceEntry).toBeDefined()
  })

  it('never routes a scope-outside SCANNED path through realpathForMatch (handler-side pushdown proof, AC4)', async () => {
    realpathCalls.length = 0
    await server.handleListFiles({ scope: inScopeDir })

    // The uningested out-of-scope file can only reach realpathForMatch via the
    // scanned loop (index.ts:668). Under correct pushdown the walker prunes
    // out-scope, so its path is never a call argument.
    expect(realpathCalls).not.toContain(outScopeUningested)

    // Non-vacuousness: the scanned loop DID run realpathForMatch over an
    // in-scope file that is reachable ONLY via the scan (uningested, so the
    // ingested-side loop never touches it) — proving the assertion above is not
    // vacuously satisfied by a walker that simply produced nothing.
    expect(realpathCalls).toContain(inScopeUningested)
  })
})

// AC3 path-basis / symlink-alias contract: under an aliased (dir-symlinked)
// baseDir, an ingested file whose SCAN path is under scope but whose stored
// filePath uses a different (real) spelling is included, and the returned
// filePath keeps its stored spelling (scope is guaranteed over the reachable
// scan path, not the stored spelling).
const describeAlias = directorySymlinkSupported() ? describe : describe.skip

describeAlias('INT-1: handleListFiles(scope) — symlink-alias contract (AC3)', () => {
  const base = resolve('./tmp/test-list-files-scope-alias')
  const realRoot = join(base, 'real')
  const aliasRoot = join(base, 'alias')
  const realSubDir = join(realRoot, 'sub')
  const realFile = join(realSubDir, 'aliased.txt')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')

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

    await installScanSpyAndImportServer()

    server = new RAGServer(
      withTestDevice({
        dbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(cacheDir),
        // Scan through the aliased (symlinked) root; the walker follows the root
        // symlink so scanned paths use the alias spelling.
        baseDir: aliasRoot,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()

    // Ingest via the REAL spelling so the stored filePath differs from the scan
    // path; realpath containment (real path under realpath(aliasRoot)) permits it.
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
    const result = await server.handleListFiles({ scope: aliasScopeDir })
    const parsed = JSON.parse(result.content[0].text)

    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
    // Stored (real) spelling is returned, not the alias scan spelling.
    expect(filePaths).toContain(realFile)
    expect(filePaths).not.toContain(join(aliasScopeDir, 'aliased.txt'))

    const entry = parsed.files.find((f: { filePath: string }) => f.filePath === realFile)
    expect(entry.ingested).toBe(true)
  })
})
