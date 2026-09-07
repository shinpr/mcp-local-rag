// CLI visual-profile sync against a real temporary LanceDB.
//
// The parser, chunker, detector, renderer, region orchestrator, planner, shared
// preparation and store are all real; only the embedder and the captioner are
// stubbed, because their outputs are external downloads rather than the subject,
// which is the profile each row carries and whether a caption survives a sync.
//
// Mock isolation: `cli/common.js` and `pdf-visual/captioner.js` are imported by
// other test files, so both factories are installed with `vi.doMock` in
// `beforeAll` and removed in `afterAll`, with the subcommands imported
// dynamically afterwards (project-context § Test Environment Constraints).
// Mocking the captioner module rather than the `pdf-visual` barrel keeps the
// real detector, renderer and orchestrator in the run.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VectorChunk } from '../../vectordb/index.js'
import { buildPdfWithImageBytes } from '../pdf-image-fixture.js'
import { parseJson } from '../test-doubles.js'

const CAPTION_TEXT = 'deterministic synthetic figure caption'

/** Model boundaries actually reached, so a true no-op is provable. */
interface ModelCalls {
  createEmbedder: number
  /** Profiles the stubbed captioner was constructed with, in call order. */
  captionerProfiles: string[]
  optimize: number
}

const calls = vi.hoisted<ModelCalls>(() => ({
  createEmbedder: 0,
  captionerProfiles: [],
  optimize: 0,
}))

function deterministicEmbeddings(texts: string[]): number[][] {
  return texts.map((_text, index) => {
    const vector = new Array<number>(384).fill(0)
    vector[index % vector.length] = 1
    return vector
  })
}

const cliCommonFactory = async (
  importOriginal: () => Promise<typeof import('../../cli/common.js')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createEmbedder: () => {
      calls.createEmbedder += 1
      return {
        embed: async () => deterministicEmbeddings(['query'])[0] ?? [],
        embedBatch: async (texts: string[]) => deterministicEmbeddings(texts),
        dispose: async () => undefined,
      }
    },
    createVectorStore: (config: Parameters<typeof actual.createVectorStore>[0]) => {
      const store = actual.createVectorStore(config)
      const realOptimize = store.optimize.bind(store)
      store.optimize = async () => {
        calls.optimize += 1
        await realOptimize()
      }
      return store
    },
  }
}

const captionerFactory = () => ({
  createCaptioner: (config: { profile: string }) => {
    calls.captionerProfiles.push(config.profile)
    return {
      caption: async () => CAPTION_TEXT,
      dispose: async () => undefined,
    }
  },
})

const MOCKED_PATHS = ['../../cli/common.js', '../../pdf-visual/captioner.js'] as const

let runIngest: typeof import('../../cli/ingest.js').runIngest
let runSync: typeof import('../../cli/sync.js').runSync
let VectorStore: typeof import('../../vectordb/index.js').VectorStore

const TMP_ROOT = resolve('./tmp/test-cli-sync-visual')

interface Case {
  root: string
  dbPath: string
  cacheDir: string
  pdfPath: string
}

/**
 * One isolated case directory with the fixture PDF already written, so every
 * test owns its own store and can run in any order.
 */
function makeCase(name: string): Case {
  const caseDir = join(TMP_ROOT, name)
  rmSync(caseDir, { recursive: true, force: true })
  const root = join(caseDir, 'root')
  mkdirSync(root, { recursive: true })
  const pdfPath = join(root, 'figure.pdf')
  writeFileSync(pdfPath, buildPdfWithImageBytes())
  return { root, dbPath: join(caseDir, 'db'), cacheDir: join(caseDir, 'cache'), pdfPath }
}

/**
 * Change the PDF's bytes without changing its rendered content: trailing bytes
 * after `%%EOF` are ignored by the parser, so only the content hash moves.
 */
function touchPdf(testCase: Case, marker: string): void {
  writeFileSync(
    testCase.pdfPath,
    Buffer.concat([Buffer.from(buildPdfWithImageBytes()), Buffer.from(`\n% ${marker}\n`)])
  )
}

async function readRows(testCase: Case): Promise<VectorChunk[]> {
  const store = new VectorStore({ dbPath: testCase.dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    return await store.getChunksByFilePath(testCase.pdfPath)
  } finally {
    await store.close()
  }
}

/** The distinct profile values the reopened rows carry; `null` means absence. */
async function storedProfiles(testCase: Case): Promise<(string | null)[]> {
  const rows = await readRows(testCase)
  expect(rows.length).toBeGreaterThan(0)
  return [...new Set(rows.map((row) => row.visualProfile ?? null))]
}

async function hasStoredCaption(testCase: Case): Promise<boolean> {
  return (await readRows(testCase)).some((row) => row.text.includes(CAPTION_TEXT))
}

function globalOptions(testCase: Case): { dbPath: string; cacheDir: string; modelName: string } {
  return {
    dbPath: testCase.dbPath,
    cacheDir: testCase.cacheDir,
    modelName: 'deterministic-test-embedder',
  }
}

interface SyncCounters {
  upserted: number
  skipped: number
  empty: number
  pruned: number
}

/** Run `sync`, returning the counters it reports on stdout. */
async function cliSync(testCase: Case, args: string[] = []): Promise<SyncCounters> {
  let stdout = ''
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk)
    return true
  })
  try {
    await runSync(['--base-dir', testCase.root, ...args], globalOptions(testCase))
  } finally {
    stdoutSpy.mockRestore()
  }
  expect(process.exitCode).toBeUndefined()
  return parseJson<SyncCounters>(stdout)
}

async function cliIngest(testCase: Case, args: string[] = []): Promise<void> {
  await runIngest(['--base-dir', testCase.root, ...args, testCase.pdfPath], globalOptions(testCase))
}

describe('CLI sync visual-profile preservation', () => {
  beforeAll(async () => {
    rmSync(TMP_ROOT, { recursive: true, force: true })
    mkdirSync(TMP_ROOT, { recursive: true })
    vi.resetModules()
    vi.doMock('../../cli/common.js', cliCommonFactory)
    vi.doMock('../../pdf-visual/captioner.js', captionerFactory)
    ;({ runIngest } = await import('../../cli/ingest.js'))
    ;({ runSync } = await import('../../cli/sync.js'))
    ;({ VectorStore } = await import('../../vectordb/index.js'))
  })

  afterAll(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true })
    for (const path of MOCKED_PATHS) {
      vi.doUnmock(path)
    }
    vi.resetModules()
  })

  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    calls.createEmbedder = 0
    calls.captionerProfiles.length = 0
    calls.optimize = 0
    process.exitCode = undefined
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
    process.exitCode = undefined
  })

  it('re-captions a changed PDF at its recorded profile without being asked', async () => {
    const testCase = makeCase('inherits-quality')
    await cliIngest(testCase, ['--visual', '--visual-quality', 'quality'])
    expect(await storedProfiles(testCase)).toEqual(['quality'])
    expect(await hasStoredCaption(testCase)).toBe(true)

    touchPdf(testCase, 'revision 2')
    calls.captionerProfiles.length = 0

    expect(await cliSync(testCase)).toMatchObject({ upserted: 1, skipped: 0 })
    expect(calls.captionerProfiles).toEqual(['quality'])
    expect(await storedProfiles(testCase)).toEqual(['quality'])
    expect(await hasStoredCaption(testCase)).toBe(true)
  })

  it('leaves a changed profile-less PDF text-only even with a bare --visual-quality', async () => {
    const testCase = makeCase('inherits-absence')
    await cliIngest(testCase)
    expect(await storedProfiles(testCase)).toEqual([null])

    touchPdf(testCase, 'revision 2')

    // Without `--visual` the quality value is parsed and validated but must not
    // become an explicit request, so the PDF still inherits its absent profile.
    expect(await cliSync(testCase, ['--visual-quality', 'quality'])).toMatchObject({
      upserted: 1,
      skipped: 0,
    })
    expect(calls.captionerProfiles).toEqual([])
    expect(await storedProfiles(testCase)).toEqual([null])
    expect(await hasStoredCaption(testCase)).toBe(false)
  })

  it('indexes a never-seen PDF at the explicitly requested profile', async () => {
    const testCase = makeCase('new-pdf-explicit')

    expect(await cliSync(testCase, ['--visual'])).toMatchObject({ upserted: 1, skipped: 0 })

    expect(calls.captionerProfiles).toEqual(['fast'])
    expect(await storedProfiles(testCase)).toEqual(['fast'])
    expect(await hasStoredCaption(testCase)).toBe(true)
  })

  it('promotes an unchanged text-only PDF and then converts it on the next explicit switch', async () => {
    const testCase = makeCase('promote-then-switch')
    await cliIngest(testCase)
    expect(await storedProfiles(testCase)).toEqual([null])

    // Identical bytes: only the profile mismatch makes the file dirty.
    expect(await cliSync(testCase, ['--visual'])).toMatchObject({ upserted: 1, skipped: 0 })
    expect(await storedProfiles(testCase)).toEqual(['fast'])

    expect(await cliSync(testCase, ['--visual', '--visual-quality', 'quality'])).toMatchObject({
      upserted: 1,
      skipped: 0,
    })
    expect(calls.captionerProfiles).toEqual(['fast', 'quality'])
    expect(await storedProfiles(testCase)).toEqual(['quality'])
    expect(await hasStoredCaption(testCase)).toBe(true)
  })

  it('loads no model and optimizes nothing when the profile and bytes already agree', async () => {
    const testCase = makeCase('repeat-no-op')
    await cliSync(testCase, ['--visual'])

    calls.createEmbedder = 0
    calls.captionerProfiles.length = 0
    calls.optimize = 0

    expect(await cliSync(testCase, ['--visual'])).toEqual({
      upserted: 0,
      skipped: 1,
      empty: 0,
      pruned: 0,
    })
    expect(calls.createEmbedder).toBe(0)
    expect(calls.captionerProfiles).toEqual([])
    expect(calls.optimize).toBe(0)
    expect(await storedProfiles(testCase)).toEqual(['fast'])
  })

  it('clears the recorded profile on a direct normal ingest, and the next sync keeps it cleared', async () => {
    const testCase = makeCase('direct-ingest-reset')
    await cliSync(testCase, ['--visual', '--visual-quality', 'quality'])
    expect(await storedProfiles(testCase)).toEqual(['quality'])

    await cliIngest(testCase)

    expect(await storedProfiles(testCase)).toEqual([null])
    expect(await hasStoredCaption(testCase)).toBe(false)

    // The reset is durable: with the bytes unchanged the file is now converged
    // on absence, so a plain sync does not resurrect the old profile.
    expect(await cliSync(testCase)).toMatchObject({ upserted: 0, skipped: 1 })
    expect(await storedProfiles(testCase)).toEqual([null])
  })
})
