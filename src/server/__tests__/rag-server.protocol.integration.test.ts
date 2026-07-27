// RAG MCP Server Integration Test - Protocol & Basic Error Handling
// Split from: rag-server.integration.test.ts (AC-001, AC-005)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  ErrorCode,
  McpError,
  type Notification,
  ProgressNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import type { Embedder } from '../../embedder/index.js'
import { DatabaseError } from '../../vectordb/types.js'
import { RAGServer } from '../index.js'
import type { SyncStatusResult } from '../types.js'

describe('AC-001: MCP Protocol Integration', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-protocol')
  const testDataDir = resolve('./tmp/test-data-protocol')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })

    ragServer = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    await ragServer.initialize()
  })

  afterAll(async () => {
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Error handling] Appropriate MCP error response returned when error occurs
  // Validation: MCP error response (error code, message) returned for invalid input
  it('Appropriate MCP error response (JSON-RPC 2.0 format) returned for invalid tool invocation', async () => {
    // Call ingest_file with non-existent file and verify error occurs
    await expect(
      ragServer.handleIngestFile({ filePath: '/nonexistent/file.pdf' })
    ).rejects.toThrow()
  })

  // Edge Case: Parallel request processing
  // Validation: Multiple MCP tool invocations are processed in parallel
  it('3 parallel MCP tool invocations are processed normally (P-003)', async () => {
    // Invoke 3 handlers in parallel
    const results = await Promise.all([
      ragServer.handleStatus(),
      ragServer.handleListFiles(),
      ragServer.handleStatus(),
    ])

    // Verify all results are returned normally
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result).toBeDefined()
      expect(result.content).toBeDefined()
      expect(result.content.length).toBe(1)
      expect(result.content[0].type).toBe('text')
    }
  })
})

describe('AC-005: Error Handling (Basic)', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-error-basic')
  const testDataDir = resolve('./tmp/test-data-error-basic')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })

    ragServer = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    await ragServer.initialize()
  })

  afterAll(async () => {
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Error handling] Error message returned for non-existent file path
  // Validation: Call ingest_file with non-existent file path, FileOperationError is returned
  it('FileOperationError returned for non-existent file path (e.g., /nonexistent/file.pdf)', async () => {
    const nonExistentFile = resolve(testDataDir, 'nonexistent-file.pdf')
    await expect(ragServer.handleIngestFile({ filePath: nonExistentFile })).rejects.toThrow()
  })

  // AC interpretation: [Error handling] Error message returned for corrupted PDF file
  // Validation: Call ingest_file with corrupted PDF file, FileOperationError is returned
  it('FileOperationError returned for corrupted PDF file (e.g., invalid header)', async () => {
    // Create corrupted PDF file
    const corruptedPdf = resolve(testDataDir, 'corrupted.pdf')
    writeFileSync(corruptedPdf, 'This is not a valid PDF file')

    await expect(ragServer.handleIngestFile({ filePath: corruptedPdf })).rejects.toThrow()
  })

  // AC interpretation: [Error handling] Error message returned when LanceDB connection fails
  // Validation: When LanceDB connection fails, DatabaseError is returned
  it('DatabaseError returned when LanceDB connection fails (e.g., invalid dbPath)', async () => {
    // Nest dbPath under a file (ENOTDIR everywhere): a bogus POSIX path is creatable on Windows.
    const dbBlocker = resolve(testDataDir, 'db-blocker')
    writeFileSync(dbBlocker, 'x')
    const invalidDbPath = resolve(dbBlocker, 'db')
    const invalidServer = new RAGServer(
      withTestDevice({
        dbPath: invalidDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    // The DB failure surfaces either at initialize() or at query time; both must be a DatabaseError.
    try {
      await invalidServer.initialize()
      await expect(invalidServer.handleQueryDocuments({ query: 'test' })).rejects.toBeInstanceOf(
        DatabaseError
      )
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError)
    } finally {
      await invalidServer.close()
    }
  })
})

// ============================================================
// SYNC-006 / SYNC-007: ordinary MCP SDK operation for the sync tools
// ============================================================
//
// Subject: the protocol boundary. A stock SDK `Client` — declaring no
// capabilities and using no experimental option — drives the real `RAGServer`
// registration over `InMemoryTransport.createLinkedPair()`, so every assertion
// below travels as `tools/list` / `tools/call` JSON-RPC traffic. The in-process
// behavior of sync itself (counters, prune evidence, depth arithmetic) is
// already proven in `rag-server.sync.integration.test.ts` and is deliberately
// not repeated here; what is proven here is reachability and result shape over
// the wire.
//
// Only the embedder is stubbed, and only on this server instance (`vi.spyOn`,
// never a module mock, so nothing enters the shared module registry): the model
// is an external ~90MB download, and the stub doubles as the controlled
// collaborator that parks one run inside ingestion so the overlap window is
// deterministic. Transport, server registration, dispatcher, parser, chunker,
// and the LanceDB store are real.
//
// No wait is a timed sleep: every wait polls the real `sync_status` tool over
// the transport, yielding with `setImmediate`.

/** Embedding width of the production model, so stub rows match the schema. */
const VECTOR_DIMENSION = 384

/** Content of the one fixture file whose ingestion the gate can park. */
const GATE_MARKER = 'PROTOCOLGATEMARKER'

const MCP_TMP_ROOT = resolve('./tmp/test-server-protocol-mcp')
const MCP_ROOT_DIR = join(MCP_TMP_ROOT, 'root')
const MCP_SUB_DIR = join(MCP_ROOT_DIR, 'sub')
const MCP_PLAIN_FILE = join(MCP_ROOT_DIR, 'a.md')
const MCP_NESTED_FILE = join(MCP_SUB_DIR, 'b.md')
const MCP_GATED_FILE = join(MCP_SUB_DIR, 'c.md')

/** Long enough for the chunker to produce a chunk. */
function document(label: string): string {
  return `${label} document ${'a'.repeat(200)}`
}

function unitVector(seed: number): number[] {
  const raw = Array.from({ length: VECTOR_DIMENSION }, (_, index) => Math.sin(seed + index))
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map((value) => value / norm)
}

interface Gate {
  /** Resolves once the parked ingestion has actually been reached. */
  entered: Promise<void>
  markEntered: () => void
  released: Promise<void>
  release: () => void
}

function createGate(): Gate {
  let markEntered!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolveEntered) => {
    markEntered = resolveEntered
  })
  const released = new Promise<void>((resolveReleased) => {
    release = resolveReleased
  })
  return { entered, markEntered, released, release }
}

function tick(): Promise<void> {
  return new Promise((resolveTick) => setImmediate(resolveTick))
}

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]
type CallToolReturn = Awaited<ReturnType<Client['callTool']>>
type ToolResult = Extract<CallToolReturn, { content: unknown }>

/**
 * Narrow the SDK's `CallToolResult | CompatibilityCallToolResult` union to the
 * standard shape. Both union members carry an index signature, so the check has
 * to inspect the value; a server answering with the legacy `toolResult` shape
 * fails here rather than silently skipping the assertions.
 */
function isStandardToolResult(result: CallToolReturn): result is ToolResult {
  return Array.isArray(result['content'])
}

function toolResult(result: CallToolReturn): ToolResult {
  if (!isStandardToolResult(result)) {
    throw new Error(`tools/call returned a non-standard result shape: ${JSON.stringify(result)}`)
  }
  return result
}

function allText(result: CallToolReturn): string {
  return toolResult(result)
    .content.map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

function firstText(result: CallToolReturn): string {
  const [block] = toolResult(result).content
  if (block === undefined || block.type !== 'text') {
    throw new Error('tools/call returned no leading text block')
  }
  return block.text
}

function namedTool(tools: ListedTool[], name: string): ListedTool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) {
    throw new Error(`tools/list did not return ${name}`)
  }
  return tool
}

/** Narrow a caught value to an `McpError`, failing the test for anything else. */
function asMcpError(error: unknown): McpError {
  if (!(error instanceof McpError)) {
    throw new Error(`expected an McpError, received: ${String(error)}`)
  }
  return error
}

describe('SYNC-006 / SYNC-007: sync tools over the MCP SDK protocol', () => {
  let ragServer: RAGServer
  let client: Client
  let serverTransport: InMemoryTransport
  /** Every server-to-client notification observed for the whole session. */
  const observedNotifications: string[] = []
  let activeGate: Gate | null = null

  beforeAll(async () => {
    rmSync(MCP_TMP_ROOT, { recursive: true, force: true })
    mkdirSync(MCP_SUB_DIR, { recursive: true })
    writeFileSync(MCP_PLAIN_FILE, document('root'))
    writeFileSync(MCP_NESTED_FILE, document('nested'))
    writeFileSync(MCP_GATED_FILE, document(`${GATE_MARKER} baseline`))

    ragServer = new RAGServer(
      withTestDevice({
        dbPath: join(MCP_TMP_ROOT, 'db'),
        modelName: 'Xenova/all-MiniLM-L6-v2',
        // Fixture-local: the stubbed embedder never loads a model, and neither
        // the db nor the cache may sit inside the scanned root.
        cacheDir: join(MCP_TMP_ROOT, 'cache'),
        baseDirs: [MCP_ROOT_DIR],
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    const embedder = (ragServer as unknown as { embedder: Embedder }).embedder
    vi.spyOn(embedder, 'embedBatch').mockImplementation(async (texts: string[]) => {
      if (activeGate !== null && texts.some((text) => text.includes(GATE_MARKER))) {
        activeGate.markEntered()
        await activeGate.released
      }
      return texts.map((_, index) => unitVector(index + 1))
    })
    vi.spyOn(embedder, 'embed').mockResolvedValue(unitVector(1))

    await ragServer.initialize()

    const [linkedClientTransport, linkedServerTransport] = InMemoryTransport.createLinkedPair()
    serverTransport = linkedServerTransport
    // No `capabilities` and no experimental option: a client with nothing
    // special negotiated must be able to use both sync tools.
    client = new Client({ name: 'protocol-integration-test-client', version: '1.0.0' })
    const record = async (notification: Notification): Promise<void> => {
      observedNotifications.push(notification.method)
    }
    // The catch-all covers every method the SDK does not pre-register, and the
    // explicit progress handler replaces the SDK's built-in one so a progress
    // notification (the historical regression) is recorded rather than absorbed.
    client.fallbackNotificationHandler = record
    client.setNotificationHandler(ProgressNotificationSchema, record)

    await Promise.all([
      client.connect(linkedClientTransport),
      ragServer.connect(linkedServerTransport),
    ])
  }, 60000)

  afterAll(async () => {
    await client.close()
    await ragServer.close()
    vi.restoreAllMocks()
    rmSync(MCP_TMP_ROOT, { recursive: true, force: true })
  })

  async function startSync(args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name: 'sync_start', arguments: args })
    expect(toolResult(result).isError).toBeUndefined()
    const { jobId } = JSON.parse(firstText(result)) as { jobId: string }
    expect(jobId.length).toBeGreaterThan(0)
    return jobId
  }

  async function syncStatus(jobId: string): Promise<SyncStatusResult> {
    const result = await client.callTool({ name: 'sync_status', arguments: { jobId } })
    expect(toolResult(result).isError).toBeUndefined()
    return JSON.parse(firstText(result)) as SyncStatusResult
  }

  /**
   * Poll the real `sync_status` tool over the transport until the job leaves
   * `running`, returning the terminal record. Yields with `setImmediate` (never
   * a timed sleep), so it returns as soon as the job is terminal; the wall-clock
   * guard only turns a hang into a readable failure instead of a suite timeout.
   */
  async function pollUntilTerminal(jobId: string): Promise<SyncStatusResult> {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const snapshot = await syncStatus(jobId)
      // § MCP Contract: `completed` never exceeds a non-null `total`.
      if (snapshot.total !== null) {
        expect(snapshot.completed).toBeLessThanOrEqual(snapshot.total)
      }
      if (snapshot.state !== 'running') return snapshot
      await tick()
    }
    throw new Error(`sync job ${jobId} never reached a terminal state`)
  }

  it('returns both sync tools with their schemas from tools/list, next to every pre-existing tool', async () => {
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'delete_file',
      'ingest_data',
      'ingest_file',
      'list_files',
      'query_documents',
      'read_chunk_neighbors',
      'status',
      'sync_start',
      'sync_status',
    ])

    const syncStart = namedTool(tools, 'sync_start')
    expect(syncStart.inputSchema.type).toBe('object')
    expect(Object.keys(syncStart.inputSchema.properties ?? {})).toEqual(['path'])
    // `path` is optional: an omitted path means every configured base directory.
    expect(syncStart.inputSchema.required).toBeUndefined()

    const syncStatusTool = namedTool(tools, 'sync_status')
    expect(syncStatusTool.inputSchema.type).toBe('object')
    expect(Object.keys(syncStatusTool.inputSchema.properties ?? {})).toEqual(['jobId'])
    expect(syncStatusTool.inputSchema.required).toEqual(['jobId'])
  })

  it('negotiates the tools capability alone, with no experimental entry', () => {
    const capabilities = client.getServerCapabilities()

    // Positive assertion rather than a bare `experimental === undefined`: any
    // added capability key would fail here.
    expect(Object.keys(capabilities ?? {})).toEqual(['tools'])
    expect(capabilities?.experimental).toBeUndefined()
  })

  it('drives a whole job to succeeded through tools/call alone and emits no notification', async () => {
    const jobId = await startSync()
    const terminal = await pollUntilTerminal(jobId)

    expect(terminal.jobId).toBe(jobId)
    expect(terminal.state).toBe('succeeded')
    expect(terminal.error).toBeNull()
    // Three supported files on disk; none is pruned, so every one lands in
    // `completed = upserted + skipped + empty`.
    expect(terminal.total).toBe(3)
    expect(terminal.completed).toBe(3)
    const { upserted, skipped, empty } = terminal.summary
    expect(terminal.completed).toBe(upserted + skipped + empty)
    expect(terminal.summary.pruned).toBe(0)

    // The lifecycle used ordinary request/response traffic only.
    expect(observedNotifications).toEqual([])

    // Non-vacuity: the same observer records a progress notification — the exact
    // shape a previous revision emitted — the moment one is delivered, so the
    // empty array above is a fact about the server, not a dead observer.
    await serverTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'observer-liveness-probe', progress: 1 },
    })
    await tick()
    expect(observedNotifications).toEqual(['notifications/progress'])
    observedNotifications.length = 0
  }, 60000)

  it('answers sync_start while the run is parked, rejects an overlapping mutation as a tool error, and keeps read-only tools callable', async () => {
    // Rewritten so the gated file is dirty whatever ran before: its ingestion,
    // and therefore the park, is always reached.
    writeFileSync(MCP_GATED_FILE, document(`${GATE_MARKER} overlap revision`))
    const gate = createGate()
    activeGate = gate

    let jobId: string
    try {
      // Resolves while the run is still ahead of it: a `sync_start` that awaited
      // the whole run could not answer before the park is released below.
      jobId = await startSync()
      await gate.entered
      expect((await syncStatus(jobId)).state).toBe('running')

      const overlap = await client.callTool({ name: 'sync_start', arguments: {} })
      // An ordinary MCP Tool Execution Error: the call resolves, so the client
      // is never told the connection or the request itself failed.
      expect(toolResult(overlap).isError).toBe(true)
      expect(allText(overlap)).toContain(jobId)
      expect(allText(overlap)).toContain('sync_status')

      const listed = await client.callTool({ name: 'list_files', arguments: {} })
      expect(toolResult(listed).isError).toBeUndefined()
      const { files } = JSON.parse(firstText(listed)) as { files: { filePath: string }[] }
      expect(files.map((file) => file.filePath).sort()).toEqual(
        [MCP_PLAIN_FILE, MCP_NESTED_FILE, MCP_GATED_FILE].sort()
      )
    } finally {
      gate.release()
      activeGate = null
    }

    const terminal = await pollUntilTerminal(jobId)
    expect(terminal.state).toBe('succeeded')
    expect(terminal.error).toBeNull()
    expect(observedNotifications).toEqual([])
  }, 60000)

  it('routes an explicit directory and an explicit file the same way the CLI does', async () => {
    const directoryJob = await pollUntilTerminal(await startSync({ path: MCP_SUB_DIR }))
    expect(directoryJob.state).toBe('succeeded')
    expect(directoryJob.error).toBeNull()
    // The requested directory is the scan root: its two files, not the third
    // one sitting beside it in the configured base directory.
    expect(directoryJob.total).toBe(2)
    expect(directoryJob.completed).toBe(2)

    const fileJob = await pollUntilTerminal(await startSync({ path: MCP_PLAIN_FILE }))
    expect(fileJob.state).toBe('succeeded')
    expect(fileJob.error).toBeNull()
    // An explicit file is handled directly: exactly itself, no directory scan.
    expect(fileJob.total).toBe(1)
    expect(fileJob.completed).toBe(1)
  }, 60000)

  it('reports a replaced jobId as unknown and leaves the connection usable', async () => {
    const replacedJobId = await startSync({ path: MCP_PLAIN_FILE })
    expect((await pollUntilTerminal(replacedJobId)).state).toBe('succeeded')

    // Starting the next job replaces the terminal record, so the older id is
    // unknown from then on.
    const currentJobId = await startSync({ path: MCP_PLAIN_FILE })
    expect(currentJobId).not.toBe(replacedJobId)

    const error = asMcpError(
      await client
        .callTool({ name: 'sync_status', arguments: { jobId: replacedJobId } })
        .catch((caught: unknown) => caught)
    )
    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(error.message).toContain('Unknown sync job')

    // The error travelled the ordinary error channel: the session is intact.
    expect((await syncStatus(currentJobId)).jobId).toBe(currentJobId)
    expect((await pollUntilTerminal(currentJobId)).state).toBe('succeeded')
  }, 60000)

  it('surfaces InvalidParams for a malformed sync_status call without faulting the connection', async () => {
    const error = asMcpError(
      await client
        .callTool({ name: 'sync_status', arguments: {} })
        .catch((caught: unknown) => caught)
    )
    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(error.message).toContain('jobId must be a non-empty string')

    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(toolResult(status).isError).toBeUndefined()
    expect(firstText(status)).toContain('chunkCount')
  })
})
