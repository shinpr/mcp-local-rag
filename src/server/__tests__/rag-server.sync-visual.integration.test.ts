// Cross-adapter visual-profile inheritance over a real temporary LanceDB.
//
// The point of this file is the handover the CLI flag matrix cannot show: a PDF
// established as `quality` through the CLI, then reconciled by a separate MCP
// server process boundary that has no visual option at all. The parser,
// detector, renderer, orchestrator, planner, shared preparation and store are
// real; only the embedder and the VLM captioner are stubbed, because their
// outputs are external downloads and are not the subject.
//
// Mock isolation: `cli/common.js` and `pdf-visual/captioner.js` are imported by
// other test files, so both factories are installed with `vi.doMock` in
// `beforeAll` and removed in `afterAll`, with the CLI and server imported
// dynamically afterwards (project-context § Test Environment Constraints).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPdfWithImageBytes } from '../../__tests__/pdf-image-fixture.js'
import { withTestDevice } from '../../__tests__/test-device.js'
import { parseJson, privateMembers } from '../../__tests__/test-doubles.js'
import type { Embedder } from '../../embedder/index.js'
import type { SyncStatusResult } from '../types.js'

const CAPTION_TEXT = 'deterministic synthetic figure caption'
const VECTOR_DIMENSION = 384

/** Profiles the stubbed captioner was constructed with, in call order. */
const calls = vi.hoisted<{ captionerProfiles: string[] }>(() => ({ captionerProfiles: [] }))

function deterministicEmbeddings(texts: string[]): number[][] {
  return texts.map((_text, index) => {
    const vector = new Array<number>(VECTOR_DIMENSION).fill(0)
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
    createEmbedder: () => ({
      embed: async () => deterministicEmbeddings(['query'])[0] ?? [],
      embedBatch: async (texts: string[]) => deterministicEmbeddings(texts),
      dispose: async () => undefined,
    }),
  }
}

const captionerFactory = () => ({
  createCaptioner: (config: { profile: string }) => {
    calls.captionerProfiles.push(config.profile)
    return { caption: async () => CAPTION_TEXT, dispose: async () => undefined }
  },
})

const MOCKED_PATHS = ['../../cli/common.js', '../../pdf-visual/captioner.js'] as const

let runIngest: typeof import('../../cli/ingest.js').runIngest
let RAGServer: typeof import('../index.js').RAGServer
let VectorStore: typeof import('../../vectordb/index.js').VectorStore

type ServerInstance = InstanceType<typeof import('../index.js').RAGServer>

const TMP_ROOT = resolve('./tmp/test-server-sync-visual')

interface Case {
  root: string
  dbPath: string
  cacheDir: string
  pdfPath: string
}

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

/** The narrow manifest projection for one path, as the planner would read it. */
async function storedManifestFor(
  testCase: Case
): Promise<{ contentHashes: number; profiles: (string | null)[] }> {
  const store = new VectorStore({ dbPath: testCase.dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    const rows = (await store.listSyncManifest()).filter((row) => row.filePath === testCase.pdfPath)
    expect(rows.length).toBeGreaterThan(0)
    return {
      contentHashes: new Set(rows.map((row) => row.contentHash)).size,
      profiles: [...new Set(rows.map((row) => row.visualProfile))],
    }
  } finally {
    await store.close()
  }
}

async function hasStoredCaption(testCase: Case): Promise<boolean> {
  const store = new VectorStore({ dbPath: testCase.dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    const rows = await store.getChunksByFilePath(testCase.pdfPath)
    return rows.some((row) => row.text.includes(CAPTION_TEXT))
  } finally {
    await store.close()
  }
}

/** A real server over the case fixture, with only the embedder stubbed. */
async function makeServer(testCase: Case): Promise<ServerInstance> {
  const server = new RAGServer(
    withTestDevice({
      dbPath: testCase.dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: testCase.cacheDir,
      baseDirs: [testCase.root],
      maxFileSize: 100 * 1024 * 1024,
    })
  )
  const embedder = privateMembers<{ embedder: Embedder }>(server).embedder
  vi.spyOn(embedder, 'embedBatch').mockImplementation(async (texts: string[]) =>
    deterministicEmbeddings(texts)
  )
  vi.spyOn(embedder, 'embed').mockResolvedValue(deterministicEmbeddings(['q'])[0] ?? [])
  await server.initialize()
  return server
}

type DispatchResult = { content: { type: string; text: string }[]; isError?: boolean }
type RegisteredHandler = (
  request: { method: string; params: { name: string; arguments?: unknown } },
  extra: { signal: AbortSignal }
) => Promise<DispatchResult>

/** Invoke the registered CallTool dispatcher closure — the real tool boundary. */
function dispatch(server: ServerInstance, name: string, args: unknown): Promise<DispatchResult> {
  const handler = privateMembers<{ server: { _requestHandlers: Map<string, RegisteredHandler> } }>(
    server
  ).server._requestHandlers.get('tools/call')
  if (handler === undefined) {
    throw new Error('tools/call handler not registered')
  }
  return handler(
    { method: 'tools/call', params: { name, arguments: args } },
    { signal: new AbortController().signal }
  )
}

function firstBlock(result: DispatchResult): string {
  return result.content[0]?.text ?? ''
}

/**
 * Start a sync job and poll the real `sync_status` handler until it is
 * terminal, which is the same signal an MCP client has. The wall-clock guard
 * only turns a hang into a readable failure.
 */
async function runSyncJob(server: ServerInstance, args: unknown = {}): Promise<SyncStatusResult> {
  const started = await dispatch(server, 'sync_start', args)
  expect(started.isError).toBeUndefined()
  const { jobId } = parseJson<{ jobId: string }>(firstBlock(started))
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const polled = await dispatch(server, 'sync_status', { jobId })
    expect(polled.isError).toBeUndefined()
    const snapshot = parseJson<SyncStatusResult>(firstBlock(polled))
    if (snapshot.state !== 'running') {
      return snapshot
    }
    await new Promise((tick) => setImmediate(tick))
  }
  throw new Error(`sync job ${jobId} never reached a terminal state`)
}

describe('MCP sync inherits the CLI-established visual profile', () => {
  beforeAll(async () => {
    rmSync(TMP_ROOT, { recursive: true, force: true })
    mkdirSync(TMP_ROOT, { recursive: true })
    vi.resetModules()
    vi.doMock('../../cli/common.js', cliCommonFactory)
    vi.doMock('../../pdf-visual/captioner.js', captionerFactory)
    ;({ runIngest } = await import('../../cli/ingest.js'))
    ;({ RAGServer } = await import('../index.js'))
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
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    calls.captionerProfiles.length = 0
    process.exitCode = undefined
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
    consoleWarn.mockRestore()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('re-captions a CLI-established quality PDF that changed while the server was closed', async () => {
    const testCase = makeCase('cli-quality-to-mcp')
    await runIngest(
      ['--base-dir', testCase.root, '--visual', '--visual-quality', 'quality', testCase.pdfPath],
      {
        dbPath: testCase.dbPath,
        cacheDir: testCase.cacheDir,
        modelName: 'deterministic-test-embedder',
      }
    )
    expect(await storedManifestFor(testCase)).toEqual({ contentHashes: 1, profiles: ['quality'] })

    // The server opens only now, so nothing but the stored rows can tell it the
    // file was ever captioned.
    touchPdf(testCase, 'edited while the server was down')
    calls.captionerProfiles.length = 0
    const server = await makeServer(testCase)
    try {
      const snapshot = await runSyncJob(server)

      expect(snapshot.state).toBe('succeeded')
      expect(snapshot.error).toBeNull()
      expect(snapshot.summary).toMatchObject({ upserted: 1, skipped: 0, empty: 0, pruned: 0 })
    } finally {
      await server.close()
    }

    expect(calls.captionerProfiles).toEqual(['quality'])
    expect(await storedManifestFor(testCase)).toEqual({ contentHashes: 1, profiles: ['quality'] })
    expect(await hasStoredCaption(testCase)).toBe(true)
  })

  it('keeps a profile-less PDF text-only and reports a converged run as a skip', async () => {
    const testCase = makeCase('mcp-plain-inheritance')
    const server = await makeServer(testCase)
    try {
      expect((await runSyncJob(server)).summary).toMatchObject({ upserted: 1, skipped: 0 })
      expect(calls.captionerProfiles).toEqual([])
      expect(await storedManifestFor(testCase)).toEqual({ contentHashes: 1, profiles: [null] })

      expect((await runSyncJob(server)).summary).toMatchObject({ upserted: 0, skipped: 1 })
      expect(calls.captionerProfiles).toEqual([])
    } finally {
      await server.close()
    }
    expect(await hasStoredCaption(testCase)).toBe(false)
  })

  it('records the profile a direct ingest_file requested, and inherits it on the next sync', async () => {
    const testCase = makeCase('ingest-file-profile')
    const server = await makeServer(testCase)
    try {
      const ingested = await dispatch(server, 'ingest_file', {
        filePath: testCase.pdfPath,
        visual: true,
        visualQuality: 'fast',
      })
      expect(ingested.isError).toBeUndefined()
      expect(await storedManifestFor(testCase)).toEqual({ contentHashes: 1, profiles: ['fast'] })

      touchPdf(testCase, 'revised after the direct ingest')
      calls.captionerProfiles.length = 0

      expect((await runSyncJob(server)).summary).toMatchObject({ upserted: 1, skipped: 0 })
      expect(calls.captionerProfiles).toEqual(['fast'])
      expect(await storedManifestFor(testCase)).toEqual({ contentHashes: 1, profiles: ['fast'] })
    } finally {
      await server.close()
    }
    expect(await hasStoredCaption(testCase)).toBe(true)
  })

  it('reports an ambiguous stored profile as a failed job without mutating the rows', async () => {
    const testCase = makeCase('mcp-ambiguous')
    const server = await makeServer(testCase)
    try {
      await dispatch(server, 'ingest_file', {
        filePath: testCase.pdfPath,
        visual: true,
        visualQuality: 'fast',
      })
      const before = await storedManifestFor(testCase)

      // A corrupted half of the row set: the planner has no defensible profile
      // to inherit and must refuse before touching anything.
      const store = new VectorStore({ dbPath: testCase.dbPath, tableName: 'chunks' })
      await store.initialize()
      const rows = await store.getChunksByFilePath(testCase.pdfPath)
      const first = rows[0]
      if (first === undefined) {
        throw new Error('expected at least one stored row')
      }
      await store.insertChunks([
        { ...first, chunkIndex: rows.length + 1, visualProfile: 'quality' },
      ])
      await store.close()

      touchPdf(testCase, 'changed while the profile is ambiguous')
      const snapshot = await runSyncJob(server)

      expect(snapshot.state).toBe('failed')
      expect(snapshot.error).toContain(testCase.pdfPath)
      expect(snapshot.error).toContain('disagree')
      expect(snapshot.summary).toEqual({ upserted: 0, skipped: 0, empty: 0, pruned: 0 })
      expect(await storedManifestFor(testCase)).toEqual({
        contentHashes: before.contentHashes,
        profiles: ['fast', 'quality'],
      })
    } finally {
      await server.close()
    }
  })
})
