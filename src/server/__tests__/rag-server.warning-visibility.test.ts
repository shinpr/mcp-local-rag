// Config warnings must be surfaced in EVERY tool response, not only
// `query_documents` / `status`, and a `configError` must make root-dependent
// tools fail fast while `status` stays callable and reports the message.
//
// Most assertions use the early-validation path, which fires before any DB or
// embedder traffic, so the suite stays fast. The warning-block shape is
// asserted on handler return values, since the protocol layer just forwards
// the array.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import { expectDefined, expectRecord, privateMembers } from '../../__tests__/test-doubles.js'
import type { Embedder } from '../../embedder/index.js'
import { BaseDirsConfigError } from '../../utils/base-dirs.js'
import { generateRawDataPath } from '../../utils/raw-data-utils.js'
import type { SearchResult, VectorStore } from '../../vectordb/index.js'
import { RAGServer } from '../index.js'

const PRECEDENCE_WARNING =
  'BASE_DIRS is set; BASE_DIR is ignored. Unset BASE_DIR or remove BASE_DIRS to silence this warning.'
const NESTED_PRUNED_WARNING =
  'Nested base directory pruned: /tmp/child/ is inside /tmp/. Keeping /tmp/ only.'

/**
 * Type helper: every MCP handler returns at least
 *   { content: Array<{ type: 'text'; text: string; annotations?: ... }> }
 * Tests inspect the content array directly, so a structural type is enough.
 */
type ContentBlock = { type: string; text: string; annotations?: unknown }

/** One block of an MCP tool result, before the text-block narrowing below. */
type ResultBlock = { type: string; text?: string | undefined; annotations?: unknown }

function findWarningBlock(
  content: ReadonlyArray<ResultBlock>,
  needle: string
): ContentBlock | undefined {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.includes(needle)) {
      return { ...block, text: block.text }
    }
  }
  return undefined
}

// Construction-only: the early-error path, before any I/O. Root-dependent
// tools must reject when a configError is present, while the ones that never
// touch `baseDirs` — `query_documents`, `ingest_data`, and the source-mode
// branches of `delete_file` / `read_chunk_neighbors` — must stay callable so a
// user can keep working while fixing the config.
describe('root-dependent tools fail fast on configError; non-root-dependent stay callable', () => {
  const testDbPath = resolve('./tmp/test-lancedb-warning-visibility-err')
  const testDataDir = resolve('./tmp/test-data-warning-visibility-err')

  beforeAll(() => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  function newServerWithConfigError(): RAGServer {
    const configError = new BaseDirsConfigError(
      'BASE_DIRS must be a JSON array of non-empty path strings.'
    )
    return new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir, // degraded-mode fallback root
        maxFileSize: 100 * 1024 * 1024,
        configError,
      })
    )
  }

  // Fail-fast set: tools whose work requires `baseDirs` to be valid.
  it('ingest_file rejects with the configError message', async () => {
    const server = newServerWithConfigError()
    await expect(server.handleIngestFile({ filePath: '/tmp/anything.txt' })).rejects.toThrow(
      /BASE_DIRS must be a JSON array of non-empty path strings/
    )
  })

  it('list_files rejects with the configError message', async () => {
    const server = newServerWithConfigError()
    await expect(server.handleListFiles()).rejects.toThrow(
      /BASE_DIRS must be a JSON array of non-empty path strings/
    )
  })

  it('delete_file (filePath mode) rejects with the configError message', async () => {
    const server = newServerWithConfigError()
    await expect(server.handleDeleteFile({ filePath: '/tmp/x.txt' })).rejects.toThrow(
      /BASE_DIRS must be a JSON array of non-empty path strings/
    )
  })

  it('read_chunk_neighbors (filePath mode) rejects with the configError message', async () => {
    const server = newServerWithConfigError()
    await expect(
      server.handleReadChunkNeighbors({ filePath: '/tmp/x.txt', chunkIndex: 0 })
    ).rejects.toThrow(/BASE_DIRS must be a JSON array of non-empty path strings/)
  })

  it('ingest_file rejects raw-data-shaped path traversal in degraded mode', async () => {
    const server = newServerWithConfigError()
    const traversal = `${testDbPath}/raw-data/../../../etc/passwd`
    await expect(server.handleIngestFile({ filePath: traversal })).rejects.toThrow(
      /BASE_DIRS must be a JSON array of non-empty path strings/
    )
  })

  it('ingest_file rejects a raw-data substring in an unrelated path', async () => {
    const server = newServerWithConfigError()
    await expect(server.handleIngestFile({ filePath: '/foo/raw-data/bar.md' })).rejects.toThrow(
      /BASE_DIRS must be a JSON array of non-empty path strings/
    )
  })
})

// =============================================================================
// status remains callable even with configError, and exposes the error in
// content blocks (so MCP clients can diagnose without inspecting stderr).
// =============================================================================
describe('P3-T3: status callable with configError and exposes diagnostic', () => {
  let server: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-warning-visibility-status-err')
  const testDataDir = resolve('./tmp/test-data-warning-visibility-status-err')

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
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
        configError,
      })
    )
    await server.initialize()
  }, 60000)

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('status returns a content response that exposes the configError message', async () => {
    const result = await server.handleStatus()
    expect(result.content.length).toBeGreaterThanOrEqual(2)
    // Primary status JSON block is still present.
    expect(result.content[0]?.type).toBe('text')
    // configError diagnostic must be visible in content (not only stderr).
    const errorBlock = findWarningBlock(
      result.content,
      'BASE_DIRS must be a JSON array of non-empty path strings'
    )
    expect(errorBlock).toBeDefined()
  })

  // Non-root-dependent tools must stay callable in degraded mode. The
  // contract for these tools is "operates against the LanceDB or the
  // raw-data store, never against the configured roots", so a configError
  // is informational here, surfaced as a warning content block via
  // `withWarnings` but never converted into a thrown McpError.

  it('query_documents remains callable in degraded mode (operates on DB only)', async () => {
    // An uninitialized store returns nothing; the contract here is that the
    // handler does not throw an assertConfigOk error before the DB call. The
    // warning-block content is covered by the configWarnings suite below.
    const result = await server.handleQueryDocuments({ query: 'no-op', limit: 1 })
    expect(result.content.length).toBeGreaterThanOrEqual(1)
    expect(result.content[0]?.type).toBe('text')
  }, 30000)

  it('ingest_data remains callable in degraded mode (writes to dbPath/raw-data only)', async () => {
    const result = await server.handleIngestData({
      content:
        'A small markdown document used solely to confirm ingest_data does not fail-fast on configError. ' +
        'It is long enough to clear the minimum chunk filter so the raw-data write produces a real row.',
      metadata: {
        source: 'clipboard://2026-05-23/degraded-mode-callable',
        format: 'markdown',
      },
    })
    const parsed = JSON.parse(result.content[0]?.text ?? '{}')
    expect(parsed.chunkCount).toBeGreaterThan(0)
    expect(typeof parsed.filePath).toBe('string')
  }, 60000)

  it('delete_file (source mode) remains callable in degraded mode', async () => {
    // Source mode operates on the raw-data path generated from `source` and
    // does not touch the configured roots. Even when no chunks exist for the
    // source yet, the call must not throw the configError.
    const result = await server.handleDeleteFile({
      source: 'clipboard://2026-05-23/degraded-mode-callable-delete',
    })
    expect(result.content.length).toBeGreaterThanOrEqual(1)
    expect(result.content[0]?.type).toBe('text')
  }, 30000)

  it('read_chunk_neighbors (source mode) remains callable in degraded mode', async () => {
    // First seed a raw-data row by source so chunkIndex 0 is reachable.
    await server.handleIngestData({
      content:
        'A markdown document used to seed the source-mode read_chunk_neighbors test. ' +
        'It must produce at least one chunk so the neighbors lookup has a target row.',
      metadata: {
        source: 'clipboard://2026-05-23/degraded-mode-callable-neighbors',
        format: 'markdown',
      },
    })

    const result = await server.handleReadChunkNeighbors({
      source: 'clipboard://2026-05-23/degraded-mode-callable-neighbors',
      chunkIndex: 0,
    })
    const parsed = JSON.parse(result.content[0]?.text ?? '[]')
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
  }, 60000)
})

// Warnings on every tool. The configError path returns an error rather than
// content, so this block uses warnings WITHOUT a configError: the handler must
// run its normal flow AND attach them.
describe('P3-T3: warnings appear in every tool response when warnings exist', () => {
  let server: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-warning-visibility-warn')
  const testDataDir = resolve('./tmp/test-data-warning-visibility-warn')
  const sampleFile = resolve(testDataDir, 'sample.txt')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    writeFileSync(
      sampleFile,
      'This is a small but valid sample document used for warning-visibility tests. ' +
        'It contains enough characters to clear the default minimum-chunk filter so ' +
        'ingest_file produces at least one chunk for the assertion below.'
    )

    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
        configWarnings: [PRECEDENCE_WARNING, NESTED_PRUNED_WARNING],
      })
    )

    await server.initialize()
  }, 60000)

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // status: warning content block must include the precedence warning.
  it('status response includes warning content block', async () => {
    const result = await server.handleStatus()
    const block = findWarningBlock(result.content, PRECEDENCE_WARNING)
    expect(block).toBeDefined()
  })

  // list_files: nested-root pruning warning is exposed here too.
  it('list_files response includes nested-root pruning warning', async () => {
    const result = await server.handleListFiles()
    const block = findWarningBlock(result.content, NESTED_PRUNED_WARNING)
    expect(block).toBeDefined()
  })

  // query_documents must include warnings on EVERY call (not only the first
  // — the legacy "first call only" gate is removed per AC-009).
  it('query_documents includes warnings on every call (not only the first)', async () => {
    const first = await server.handleQueryDocuments({ query: 'sample', limit: 1 })
    const second = await server.handleQueryDocuments({ query: 'sample', limit: 1 })
    const firstBlock = findWarningBlock(first.content, PRECEDENCE_WARNING)
    const secondBlock = findWarningBlock(second.content, PRECEDENCE_WARNING)
    expect(firstBlock).toBeDefined()
    expect(secondBlock).toBeDefined()
  })

  // ingest_file: warning block accompanies the ingest result.
  it('ingest_file response includes warning content block', async () => {
    const result = await server.handleIngestFile({ filePath: sampleFile })
    const block = findWarningBlock(result.content, PRECEDENCE_WARNING)
    expect(block).toBeDefined()
  })

  // ingest_data: warning block accompanies the raw-data ingest result.
  it('ingest_data response includes warning content block', async () => {
    const result = await server.handleIngestData({
      content:
        'A short markdown document used solely to confirm warning visibility on ingest_data.',
      metadata: { source: 'clipboard://2026-05-23/warning-visibility', format: 'markdown' },
    })
    const block = findWarningBlock(result.content, PRECEDENCE_WARNING)
    expect(block).toBeDefined()
  })

  // read_chunk_neighbors: warning block accompanies the neighbors result.
  it('read_chunk_neighbors response includes warning content block', async () => {
    // Ingest a file first so chunkIndex 0 exists.
    await server.handleIngestFile({ filePath: sampleFile })
    const result = await server.handleReadChunkNeighbors({ filePath: sampleFile, chunkIndex: 0 })
    const block = findWarningBlock(result.content, PRECEDENCE_WARNING)
    expect(block).toBeDefined()
  })

  // delete_file: warning block accompanies the delete result.
  it('delete_file response includes warning content block', async () => {
    // Ensure something exists to delete (idempotent for delete semantics).
    await server.handleIngestFile({ filePath: sampleFile })
    const result = await server.handleDeleteFile({ filePath: sampleFile })
    const block = findWarningBlock(result.content, PRECEDENCE_WARNING)
    expect(block).toBeDefined()
  })

  // Annotations remain on the warning block (assistant/user audience, priority 0.3).
  it('warning content blocks carry MCP annotations', async () => {
    const result = await server.handleStatus()
    const block = findWarningBlock(result.content, PRECEDENCE_WARNING)
    expect(block).toBeDefined()
    const annotations = expectRecord(expectDefined(block).annotations)
    expect(annotations['audience']).toEqual(['user', 'assistant'])
    expect(annotations['priority']).toBe(0.3)
  })
})

// =============================================================================
// No spurious blocks when no warnings and no configError exist.
// =============================================================================
describe('P3-T3: no spurious blocks when warnings absent', () => {
  let server: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-warning-visibility-clean')
  const testDataDir = resolve('./tmp/test-data-warning-visibility-clean')
  const sampleFile = resolve(testDataDir, 'sample.txt')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    writeFileSync(
      sampleFile,
      'A small sample document used to confirm that responses contain only the primary content block when no warnings are configured.'
    )

    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
        // No configWarnings, no configError.
      })
    )

    await server.initialize()
  }, 60000)

  afterAll(async () => {
    await server.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('status response has exactly one content block when no warnings', async () => {
    const result = await server.handleStatus()
    expect(result.content.length).toBe(1)
  })

  it('list_files response has exactly one content block when no warnings', async () => {
    const result = await server.handleListFiles()
    expect(result.content.length).toBe(1)
  })

  it('query_documents response has exactly one content block when no warnings', async () => {
    const result = await server.handleQueryDocuments({ query: 'sample', limit: 1 })
    expect(result.content.length).toBe(1)
  })
})

describe('query_documents attachment warning isolation', () => {
  const dbPath = resolve('./tmp/test-lancedb-attachment-warning-isolation')
  const dataDir = resolve('./tmp/test-data-attachment-warning-isolation')
  const PNG_1X1_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='
  const searchResults: SearchResult[] = [
    {
      id: 'row-first',
      filePath: '/test/first.pdf',
      chunkIndex: 3,
      text: 'first preserved text',
      score: 0.1,
      metadata: { fileName: 'first.pdf', fileSize: 100, fileType: 'pdf' },
      fileTitle: 'First',
    },
    {
      id: 'row-second',
      filePath: '/test/second.pdf',
      chunkIndex: 7,
      text: 'second preserved text',
      score: 0.2,
      metadata: { fileName: 'second.pdf', fileSize: 200, fileType: 'pdf' },
      fileTitle: 'Second',
    },
    {
      id: 'row-third',
      filePath: '/test/third.pdf',
      chunkIndex: 11,
      text: 'third preserved text',
      score: 0.3,
      metadata: { fileName: 'third.pdf', fileSize: 300, fileType: 'pdf' },
      fileTitle: 'Third',
    },
    {
      id: 'row-fourth',
      filePath: '/test/fourth.pdf',
      chunkIndex: 13,
      text: 'fourth preserved text',
      score: 0.4,
      metadata: { fileName: 'fourth.pdf', fileSize: 400, fileType: 'pdf' },
      fileTitle: 'Fourth',
    },
  ]
  let server: RAGServer

  function internals(value: RAGServer): { embedder: Embedder; vectorStore: VectorStore } {
    return privateMembers<{ embedder: Embedder; vectorStore: VectorStore }>(value)
  }

  beforeAll(() => {
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    server = new RAGServer(
      withTestDevice({
        dbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: dataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => {
    rmSync(dbPath, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  function stubSearch(): void {
    vi.spyOn(internals(server).embedder, 'embed').mockResolvedValue([0.1, 0.2])
    vi.spyOn(internals(server).vectorStore, 'search').mockResolvedValue(searchResults)
  }

  it('includes an existing public source in the association result identity', async () => {
    const source = 'clipboard://2026-08-23/visual-association'
    const filePath = generateRawDataPath(dbPath, source)
    const searchResult: SearchResult = {
      ...searchResults[0],
      filePath,
    }
    vi.spyOn(internals(server).embedder, 'embed').mockResolvedValue([0.1, 0.2])
    vi.spyOn(internals(server).vectorStore, 'search').mockResolvedValue([searchResult])
    vi.spyOn(internals(server).vectorStore, 'hydrateVisualAttachments').mockResolvedValue({
      rows: [
        {
          id: searchResult.id,
          attachments: [
            {
              imageIndex: 5,
              mimeType: 'image/png',
              data: PNG_1X1_BASE64,
            },
          ],
        },
      ],
      omittedCount: 0,
    })

    const result = await server.handleQueryDocuments({ query: 'source identity', limit: 1 })

    expect(result.content[1]).toEqual({
      type: 'text',
      text: JSON.stringify({
        type: 'visual_attachment',
        result: { filePath, chunkIndex: searchResult.chunkIndex, source },
        imageIndex: 5,
        mimeType: 'image/png',
      }),
    })
    expect(result.content[2]).toEqual({
      type: 'image',
      data: PNG_1X1_BASE64,
      mimeType: 'image/png',
    })
  })

  it('keeps every text result and emits one controlled warning on total hydration failure', async () => {
    stubSearch()
    vi.spyOn(internals(server).vectorStore, 'hydrateVisualAttachments').mockRejectedValue(
      new Error('sensitive database internals')
    )

    const result = await server.handleQueryDocuments({ query: 'preserved', limit: 2 })
    const firstBlock = result.content[0]
    const parsed = JSON.parse(firstBlock?.type === 'text' ? firstBlock.text : 'null')
    expect(parsed.map((item: QueryResultShape) => item.text)).toEqual([
      'first preserved text',
      'second preserved text',
      'third preserved text',
      'fourth preserved text',
    ])
    expect(result.content).toHaveLength(2)
    const warnings = result.content.filter(
      (block): block is Extract<(typeof result.content)[number], { type: 'text' }> =>
        block.type === 'text' && block.text.startsWith('Warning: Visual attachments')
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text).not.toContain('sensitive database internals')
  })
})

type QueryResultShape = { text: string }
