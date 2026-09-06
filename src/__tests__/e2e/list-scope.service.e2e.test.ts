// E2E-1: `list --scope` service-integration E2E (Final Phase).
//
// AC: AC2 (CLI `list` accepts repeatable `--scope`) / AC3 (files[] restricted
//     exact-or-descendant on the scan path) / AC6 (raw-data sources always
//     emitted; a real-file ingested entry outside scope appears in neither
//     files[] nor sources[]).
// Behavior: spawn the ACTUAL CLI (`mcp-local-rag list --scope <dir>`) as a real
//     child OS process against a real-FS + real-LanceDB fixture → the full
//     traversal-pushdown stack runs in a fresh process → stdout JSON files[]
//     lists only under-scope files and sources[] retains the raw-data source
//     while excluding the out-of-scope ingested real file.
//     fixture + RAGServer (fixture ingest, real embed) + shared pre-warmed model cache
//
// This E2E asserts BEHAVIORAL CORRECTNESS only: the spawn timeout is a perf
// property (issue #165) and is NOT asserted here. The layered pushdown PROOFS
// (readdir EACCES mock/spy + realpathForMatch spy) live in the integration lane
// (INT-1/INT-2/INT-3); this E2E confirms the assembled CLI produces the scoped
// result through a real process.
//
// Spawn convention: `process.execPath --import tsx src/index.ts ...`, mirroring
// `src/__tests__/cli/entry-routing.test.ts` (the repo's spawned-CLI-in-default-
// suite pattern). No `dist` build step is required, so the test is deterministic
// under a plain `pnpm test`. The fixture is ingested in-process via RAGServer
// (real embedder + LanceDB), then the server is closed before spawning so the
// child `list` opens the persisted DB cleanly; `list` needs no embedder.

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../../server/index.js'
import { testModelCacheDir, withTestDevice } from '../test-device.js'
import { expectError, parseJson } from '../test-doubles.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '../../..')
const ENTRY = resolve(PROJECT_ROOT, 'src/index.ts')

// Cold tsx start + native LanceDB load in a fresh process: keep the ceiling
// generous. The listing itself (VectorStore only, no embed) is fast.
const SPAWN_TIMEOUT_MS = 60_000

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

function runListCli(globalAndListArgs: string[]): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...globalAndListArgs], {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    timeout: SPAWN_TIMEOUT_MS,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

interface ParsedListResult {
  files: Array<{ filePath: string }>
  sources: Array<{ source?: string; filePath?: string }>
}

/**
 * Assert the spawned CLI exited 0 and parse its stdout JSON. On a non-zero exit
 * or non-JSON stdout, surface the captured stderr (and stdout) so a CI failure
 * is debuggable instead of an opaque JSON.parse error.
 */
function parseSuccessfulListOutput(run: CliRun): ParsedListResult {
  expect(run.status, `CLI exited with ${run.status}; stderr:\n${run.stderr}`).toBe(0)
  try {
    return parseJson<ParsedListResult>(run.stdout)
  } catch (error) {
    throw new Error(
      `CLI stdout was not valid JSON (${expectError(error).message}).\n` +
        `--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
      { cause: error }
    )
  }
}

describe('E2E-1: spawned CLI `list --scope` — scoped files[], raw-data sources retained', () => {
  const base = resolve('./tmp/e2e-list-scope')
  const dataDir = join(base, 'data')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')

  const inScopeDir = join(dataDir, 'in-scope')
  const inScopeFile = join(inScopeDir, 'keep.txt')
  const deepDir = join(inScopeDir, 'deep')
  const deepFile = join(deepDir, 'deep-keep.txt')

  const outScopeDir = join(dataDir, 'out-scope')
  const outScopeIngested = join(outScopeDir, 'ingested-out.txt')

  const secondScopeDir = join(dataDir, 'second-scope')
  const secondScopeFile = join(secondScopeDir, 'second-keep.txt')

  const rawSource = 'https://example.com/list-scope-e2e-raw'

  let server: InstanceType<typeof RAGServer>

  beforeAll(async () => {
    mkdirSync(deepDir, { recursive: true })
    mkdirSync(outScopeDir, { recursive: true })
    mkdirSync(secondScopeDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(inScopeFile, 'In-scope file content for the list-scope E2E. '.repeat(20))
    writeFileSync(deepFile, 'Deep in-scope file content for the list-scope E2E. '.repeat(20))
    writeFileSync(outScopeIngested, 'Out-of-scope ingested file content. '.repeat(20))
    writeFileSync(secondScopeFile, 'Second-scope file content for the union case. '.repeat(20))

    // Ingest the fixture in-process (real embedder + real LanceDB). The spawned
    // `list` later reads this same persisted dbPath; listing needs no embedder.
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
    await server.handleIngestFile({ filePath: outScopeIngested })
    await server.handleIngestData({
      content:
        'Raw-data content ingested via ingest_data for the list-scope E2E. ' +
        'Long enough to produce at least one chunk in the vector store.',
      metadata: { source: rawSource, format: 'text' },
    })

    // Release DB handles before spawning so the child process opens cleanly.
    await server.close()
  }, 120_000)

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it(
    'restricts stdout files[] to the in-scope subtree and retains raw-data sources',
    () => {
      const run = runListCli([
        '--db-path',
        dbPath,
        '--cache-dir',
        cacheDir,
        'list',
        '--base-dir',
        dataDir,
        '--scope',
        inScopeDir,
      ])

      const parsed = parseSuccessfulListOutput(run)
      const filePaths = parsed.files.map((f) => f.filePath)
      const sourcePaths = parsed.sources.map((s) => s.filePath)

      // AC3: only under-scope files are listed (exact-or-descendant on scan path).
      expect(filePaths).toContain(inScopeFile)
      expect(filePaths).toContain(deepFile)
      expect(filePaths).not.toContain(outScopeIngested)
      expect(filePaths).not.toContain(secondScopeFile)

      // AC6: raw-data source retained regardless of scope; the out-of-scope
      // ingested real file appears in NEITHER files[] NOR sources[].
      const rawEntry = parsed.sources.find((s: { source?: string }) => s.source === rawSource)
      expect(rawEntry).toBeDefined()
      expect(sourcePaths).not.toContain(outScopeIngested)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'unions results across repeated --scope flags',
    () => {
      const run = runListCli([
        '--db-path',
        dbPath,
        '--cache-dir',
        cacheDir,
        'list',
        '--base-dir',
        dataDir,
        '--scope',
        inScopeDir,
        '--scope',
        secondScopeDir,
      ])

      const parsed = parseSuccessfulListOutput(run)
      const filePaths = parsed.files.map((f) => f.filePath)

      expect(filePaths).toContain(inScopeFile)
      expect(filePaths).toContain(secondScopeFile)
      expect(filePaths).not.toContain(outScopeIngested)
    },
    SPAWN_TIMEOUT_MS
  )
})
