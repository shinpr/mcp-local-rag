// read_chunk_neighbors Integration Test - Design Doc: read-chunk-neighbors-design.md
// Generated: 2026-04-16 | Budget Used: 7/3 integration (Design Doc explicitly prescribes
// AC-005/006/007/011/013/019 + single-call sufficiency + P95; budget overrun reported)
// PRD reference: docs/prd/read-chunk-neighbors-prd.md (AC-001..AC-020)
//
// Test framework: vitest (pool: forks, maxWorkers: 1, isolate: false)
// Mock boundary decisions (Design Doc §Test Boundaries):
//   @real-dependency: RAGServer, VectorStore, LanceDB, DocumentParser, raw-data-utils
//   Mocked: none in this file (except the single-call-sufficiency spy on vectorStore.getChunksByRange)
//
// Follow existing pattern from rag-server.delete.integration.test.ts:
//   - describe block per AC (or AC group) with its own tmp dbPath + baseDir
//   - beforeAll: create dirs, construct RAGServer, initialize, seed fixtures
//   - afterAll: rmSync tmp dirs recursively
//   - Use handleIngestFile / handleIngestData to seed real chunks

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isRawDataPath } from '../../utils/raw-data-utils.js'
import type { VectorChunk, VectorStore } from '../../vectordb/index.js'
import { RAGServer } from '../index.js'
import type { ReadChunkNeighborsInput, ReadChunkNeighborsResultItem } from '../types.js'

/**
 * Local helper: access the private vectorStore instance on a RAGServer.
 * Mirrors the pattern in rag-server ingest-rollback tests. Kept local;
 * per task scope boundary we do not introduce cross-file test utilities.
 */
function getVectorStore(server: RAGServer): VectorStore {
  return (server as unknown as { vectorStore: VectorStore }).vectorStore
}

/**
 * Local helper: parse the JSON payload of a tool response.
 */
function parseItems(response: {
  content: Array<{ type: 'text'; text: string }>
}): ReadChunkNeighborsResultItem[] {
  const text = response.content[0]?.text
  if (typeof text !== 'string') {
    throw new Error('Response content[0].text is missing')
  }
  return JSON.parse(text) as ReadChunkNeighborsResultItem[]
}

describe('read_chunk_neighbors integration', () => {
  // =============================================================================
  // Test 1: Default window returns 5 sorted chunks with core fields and isTarget
  // =============================================================================
  // AC: AC-001 "Given an ingested document at filePath, when a client calls
  //     read_chunk_neighbors({ filePath, chunkIndex: N }) with the defaults
  //     (before=2, after=2), then the response contains all existing chunks from
  //     index N-2 to N+2 in the same document, sorted by chunkIndex ascending."
  // AC: AC-002 "Each item contains exactly the core required fields: chunkIndex,
  //     text, filePath."
  // AC: AC-008 "Default before=2, after=2."
  // AC: AC-018 "Response array is always sorted by chunkIndex ascending."
  // AC: AC-019 "Each item includes isTarget (boolean); exactly one item in a
  //     non-empty response has isTarget: true; that item's chunkIndex equals the
  //     requested chunkIndex."
  // ROI: 109 (BV:10 x Freq:10 + Legal:0 + Defect:9)
  // Behavior: Ingest document with >=5 chunks -> call handleReadChunkNeighbors
  //   with filePath + chunkIndex in mid-document -> response is ordered 5-item
  //   window with correct fields and exactly one isTarget:true at the requested
  //   chunkIndex.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB, DocumentParser
  // @complexity: medium
  //
  // Setup:
  //   - Ingest a text file large enough to produce at least 7 chunks
  //     (use '. '.repeat(N) pattern from rag-server.delete.integration.test.ts
  //      or a file sized against CHUNK_MIN_LENGTH to guarantee >= 7 chunks).
  //   - Record the filePath and pick a mid-document chunkIndex (e.g., 3).
  //
  // Verification items:
  //   - Response shape: { content: [{ type: 'text', text: <json> }] }
  //   - Parsed JSON is an array of length 5
  //   - chunkIndex values equal [N-2, N-1, N, N+1, N+2] in that exact order
  //     (ascending sort guarantee; AC-018)
  //   - Every item has keys: chunkIndex (number), text (non-empty string),
  //     filePath (matches ingested path), isTarget (boolean), fileTitle
  //     (string or null)
  //   - Exactly one item has isTarget === true (AC-019)
  //   - The isTarget:true item's chunkIndex equals the requested chunkIndex
  //   - No item carries a 'score' field (Design Doc §Data Representation Decision)
  //   - No item carries a 'metadata' field
  //
  // Pass criteria:
  //   - All verification items above hold.
  describe('Test 1: Default window returns 5 sorted chunks with core fields and isTarget', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t1')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t1')
    let ingestedFilePath: string

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'default-window.txt')
      // Large enough content that chunker produces >= 7 chunks.
      writeFileSync(ingestedFilePath, 'The quick brown fox jumps over the lazy dog. '.repeat(200))
      const ingestRes = await ragServer.handleIngestFile({ filePath: ingestedFilePath })
      const ingest = JSON.parse(ingestRes.content[0].text)
      expect(ingest.chunkCount).toBeGreaterThanOrEqual(7)
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('returns 5 sorted items with core fields, exactly one isTarget true', async () => {
      const response = await ragServer.handleReadChunkNeighbors({
        filePath: ingestedFilePath,
        chunkIndex: 3,
      })
      const items = parseItems(response)

      expect(items).toHaveLength(5)
      expect(items.map((i) => i.chunkIndex)).toEqual([1, 2, 3, 4, 5])

      for (const item of items) {
        expect(typeof item.chunkIndex).toBe('number')
        expect(typeof item.text).toBe('string')
        expect(item.text.length).toBeGreaterThan(0)
        expect(item.filePath).toBe(ingestedFilePath)
        expect(typeof item.isTarget).toBe('boolean')
        // fileTitle is string | null per ReadChunkNeighborsResultItem
        expect(item.fileTitle === null || typeof item.fileTitle === 'string').toBe(true)
        // AC-002 minimal core: no score, no metadata on ChunkRow-derived items.
        expect('score' in item).toBe(false)
        expect('metadata' in item).toBe(false)
      }

      const targets = items.filter((i) => i.isTarget)
      expect(targets).toHaveLength(1)
      expect(targets[0]?.chunkIndex).toBe(3)
    })
  })

  // =============================================================================
  // Test 2: Single-call sufficiency (PRD Quantitative Metric 3)
  // =============================================================================
  // AC: Metric 3 "In an end-to-end agent scenario (query_documents hit ->
  //     read_chunk_neighbors), the agent produces the expected surrounding
  //     context in exactly one follow-up tool call with no retries, measured by
  //     at least one integration test that asserts call count = 1."
  // ROI: 78 (BV:9 x Freq:8 + Legal:0 + Defect:6)
  // Behavior: Simulate agent workflow: query_documents returns a hit -> use
  //   that hit's filePath+chunkIndex -> call read_chunk_neighbors once ->
  //   vectorStore.getChunksByRange is invoked exactly once for the neighbor call.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB (real), vi.spyOn on getChunksByRange
  // @complexity: medium
  //
  // Setup:
  //   - Ingest a document containing a distinctive query term so
  //     handleQueryDocuments returns a deterministic hit.
  //   - Install vi.spyOn(vectorStore, 'getChunksByRange') AFTER the query step
  //     so the query path itself does not contribute to the call count.
  //     Alternative: reset the spy with spy.mockClear() between the two steps.
  //
  // Verification items:
  //   - handleQueryDocuments returns at least one hit; extract filePath and
  //     chunkIndex from results[0]
  //   - After handleReadChunkNeighbors is called with those values,
  //     getChunksByRange spy call count === 1 (not 0, not 2+)
  //   - The single call's arguments match (ingestedFilePath, chunkIndex-2,
  //     chunkIndex+2) — confirming default window + correct filePath plumbing
  //   - Response resolves (no exception thrown)
  //
  // Pass criteria:
  //   - Spy call count equals 1 on the neighbor call.
  //   - Arguments match the expected minIdx/maxIdx range.
  describe('Test 2: Single-call sufficiency (PRD Quantitative Metric 3)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t2')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t2')
    let ingestedFilePath: string

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'single-call.txt')
      writeFileSync(
        ingestedFilePath,
        'Distinctive marker ZZQWERTY12345 appears in this document. '.repeat(60)
      )
      await ragServer.handleIngestFile({ filePath: ingestedFilePath })
    }, 30000)

    afterAll(() => {
      vi.restoreAllMocks()
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('invokes getChunksByRange exactly once with correct range arguments', async () => {
      const queryRes = await ragServer.handleQueryDocuments({
        query: 'ZZQWERTY12345',
        limit: 5,
      })
      const hits = JSON.parse(queryRes.content[0].text) as Array<{
        filePath: string
        chunkIndex: number
      }>
      expect(hits.length).toBeGreaterThan(0)
      const firstHit = hits[0]
      if (!firstHit) throw new Error('Expected at least one query hit')
      const { filePath: hitFilePath, chunkIndex: hitChunkIndex } = firstHit

      // Install spy AFTER the query step so query path doesn't contribute
      const vectorStore = getVectorStore(ragServer)
      const spy = vi.spyOn(vectorStore, 'getChunksByRange')
      spy.mockClear()

      const neighborRes = await ragServer.handleReadChunkNeighbors({
        filePath: hitFilePath,
        chunkIndex: hitChunkIndex,
      })
      // Sanity: response resolved with valid payload
      expect(neighborRes.content[0]).toBeDefined()

      expect(spy.mock.calls).toHaveLength(1)
      // Handler clamps minIdx via Math.max(0, chunkIndex - before) per Design Doc
      // §Main Components → Handler. maxIdx is unclamped.
      const expectedMinIdx = Math.max(0, hitChunkIndex - 2)
      const expectedMaxIdx = hitChunkIndex + 2
      expect(spy.mock.calls[0]).toEqual([hitFilePath, expectedMinIdx, expectedMaxIdx])

      spy.mockRestore()
    })
  })

  // =============================================================================
  // Test 3: Near-start target returns clamped window (AC-005)
  // =============================================================================
  // AC: AC-005 "Given a target chunkIndex near the start or end of the document
  //     (e.g., chunkIndex: 0 with before=2), when the tool runs, then the
  //     response includes only the chunks that exist (e.g., indices 0, 1, 2)
  //     with no error and no placeholder entries for missing indices."
  // ROI: 71 (BV:9 x Freq:7 + Legal:0 + Defect:8)
  // Behavior: Request neighbors centered on chunkIndex=0 with default before=2 ->
  //   no error; response contains only indices [0, 1, 2]; no negative-index
  //   placeholder rows.
  // @category: edge-case
  // @dependency: RAGServer, VectorStore, LanceDB
  // @complexity: low
  //
  // Setup:
  //   - Ingest a document producing at least 4 chunks (so chunks 0,1,2 all exist).
  //   - Call handleReadChunkNeighbors with chunkIndex=0 (defaults on before/after).
  //
  // Verification items:
  //   - Operation resolves without throwing
  //   - Response is an array of length 3
  //   - chunkIndex values are exactly [0, 1, 2] in order
  //   - The item with chunkIndex === 0 has isTarget: true
  //   - The other two items have isTarget: false
  //   - No item has a negative chunkIndex
  //
  // Pass criteria:
  //   - All verification items above hold; response is the clamped window.
  describe('Test 3: Near-start target returns clamped window (AC-005)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t3')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t3')
    let ingestedFilePath: string

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'near-start.txt')
      writeFileSync(ingestedFilePath, 'Alpha beta gamma delta epsilon zeta eta theta. '.repeat(120))
      const ingestRes = await ragServer.handleIngestFile({ filePath: ingestedFilePath })
      const ingest = JSON.parse(ingestRes.content[0].text)
      expect(ingest.chunkCount).toBeGreaterThanOrEqual(4)
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('returns only existing chunks [0,1,2] with isTarget at 0', async () => {
      const response = await ragServer.handleReadChunkNeighbors({
        filePath: ingestedFilePath,
        chunkIndex: 0,
      })
      const items = parseItems(response)

      expect(items).toHaveLength(3)
      expect(items.map((i) => i.chunkIndex)).toEqual([0, 1, 2])
      for (const item of items) {
        expect(item.chunkIndex).toBeGreaterThanOrEqual(0)
      }
      expect(items[0]?.isTarget).toBe(true)
      expect(items[1]?.isTarget).toBe(false)
      expect(items[2]?.isTarget).toBe(false)
    })
  })

  // =============================================================================
  // Test 4: Missing target and fully out-of-range behavior (AC-006)
  // =============================================================================
  // AC: AC-006 "When the target chunkIndex itself does not exist, the tool
  //     returns only the surrounding chunks (within [N-before, N+after]) that
  //     do exist; if none of the requested range exists, it returns an empty
  //     array. No error is raised."
  // AC (cross-reference): AC-019 "when the target chunkIndex itself does not
  //     exist in the document, all returned items have isTarget: false."
  // ROI: 63 (BV:9 x Freq:6 + Legal:0 + Defect:9)
  // Behavior: Two sub-scenarios in a single test:
  //   (a) Target chunkIndex is just past the last valid index (e.g., doc has
  //       chunks 0..5, request chunkIndex=6): surrounding indices 4,5 remain.
  //   (b) Target chunkIndex is far past the document (e.g., chunkIndex=999):
  //       response is an empty array, no error.
  // @category: edge-case
  // @dependency: RAGServer, VectorStore, LanceDB
  // @complexity: medium
  //
  // Setup:
  //   - Ingest a document yielding exactly N known chunks (e.g., N=6 -> last
  //     valid chunkIndex = 5). The exact chunk count is not asserted here
  //     (chunker is deterministic enough via fixed input text) — the test
  //     reads the count via handleListFiles or a prior getChunksByRange call
  //     if needed.
  //
  // Verification items (sub-scenario a):
  //   - Request chunkIndex=(N) with default before=2 after=2
  //   - Operation resolves without throwing
  //   - Response is a non-empty array
  //   - All returned items have isTarget: false (target itself absent)
  //   - All returned chunkIndex values are <= N-1 (no item beyond doc end)
  //   - chunkIndex values are strictly ascending
  //
  // Verification items (sub-scenario b):
  //   - Request chunkIndex=999 (far outside) with default before=2 after=2
  //   - Operation resolves without throwing
  //   - Response is an empty array ([])
  //
  // Pass criteria:
  //   - Both sub-scenarios hold as specified.
  describe('Test 4: Missing target and fully out-of-range behavior (AC-006)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t4')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t4')
    let ingestedFilePath: string
    let chunkCount: number

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'missing-target.txt')
      writeFileSync(
        ingestedFilePath,
        'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(150)
      )
      const ingestRes = await ragServer.handleIngestFile({ filePath: ingestedFilePath })
      const ingest = JSON.parse(ingestRes.content[0].text)
      chunkCount = ingest.chunkCount
      expect(chunkCount).toBeGreaterThanOrEqual(3)
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('(a) target just past last index: returns surrounding chunks with all isTarget false', async () => {
      // Request chunkIndex = chunkCount (one past the last valid index = chunkCount-1)
      const response = await ragServer.handleReadChunkNeighbors({
        filePath: ingestedFilePath,
        chunkIndex: chunkCount,
      })
      const items = parseItems(response)

      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(item.isTarget).toBe(false)
        expect(item.chunkIndex).toBeLessThanOrEqual(chunkCount - 1)
      }
      // Strictly ascending
      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1]
        const curr = items[i]
        if (!prev || !curr) throw new Error('Unexpected undefined item in ascending check')
        expect(curr.chunkIndex).toBeGreaterThan(prev.chunkIndex)
      }
    })

    it('(b) target far outside document: returns empty array', async () => {
      const response = await ragServer.handleReadChunkNeighbors({
        filePath: ingestedFilePath,
        chunkIndex: 999,
      })
      const items = parseItems(response)
      expect(items).toEqual([])
    })
  })

  // =============================================================================
  // Test 5: source input resolves to same document as filePath (AC-003)
  // =============================================================================
  // AC: AC-003 "Given the caller passes source (the identifier used in
  //     ingest_data) instead of filePath, when the tool runs, then it resolves
  //     the internal storage key via the same raw-data-utils helpers used by
  //     delete_file and returns neighbors for that document."
  // ROI: 47 (BV:8 x Freq:5 + Legal:0 + Defect:7)
  // Behavior: Ingest raw data via handleIngestData(content, metadata.source=X)
  //   -> call handleReadChunkNeighbors({ source: X, chunkIndex: N }) -> response
  //   items belong to the same underlying document (same internal filePath).
  // @category: integration
  // @dependency: RAGServer, VectorStore, LanceDB, raw-data-utils
  // @complexity: medium
  //
  // Setup:
  //   - Call handleIngestData with distinctive content and metadata:
  //     { source: 'https://example.com/read-neighbors-test', format: 'html' or 'markdown' }.
  //   - Capture ingest result; confirm chunkCount >= 3 so chunkIndex=1 yields a
  //     full window.
  //   - Call handleReadChunkNeighbors({ source: 'https://example.com/...', chunkIndex: 1 }).
  //
  // Verification items:
  //   - Operation resolves without throwing
  //   - Response is a non-empty array
  //   - All returned items share the same filePath value
  //   - The shared filePath is under the raw-data storage directory
  //     (isRawDataPath(filePath) === true)
  //   - Exactly one item has isTarget: true with chunkIndex === 1
  //
  // Pass criteria:
  //   - Source-based resolution yields a valid neighbor window from the same
  //     raw-data document.
  describe('Test 5: source input resolves to same document as filePath (AC-003)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t5')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t5')
    const SOURCE = 'https://example.com/read-neighbors-test'

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      const content = `# Read Neighbors Source Test\n\n${'Markdown paragraph content with stable wording. '.repeat(200)}`
      const ingestRes = await ragServer.handleIngestData({
        content,
        metadata: { source: SOURCE, format: 'markdown' },
      })
      const ingest = JSON.parse(ingestRes.content[0].text)
      expect(ingest.chunkCount).toBeGreaterThanOrEqual(3)
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('resolves source identifier to the raw-data document and returns a window', async () => {
      const response = await ragServer.handleReadChunkNeighbors({
        source: SOURCE,
        chunkIndex: 1,
      })
      const items = parseItems(response)

      expect(items.length).toBeGreaterThan(0)
      const filePaths = new Set(items.map((i) => i.filePath))
      expect(filePaths.size).toBe(1)
      const sharedPath = items[0]?.filePath ?? ''
      expect(isRawDataPath(sharedPath)).toBe(true)

      const targets = items.filter((i) => i.isTarget)
      expect(targets).toHaveLength(1)
      expect(targets[0]?.chunkIndex).toBe(1)
    })
  })

  // =============================================================================
  // Test 6: Raw-data row includes source field (AC-020)
  // =============================================================================
  // AC: AC-020 "Given a document ingested via ingest_data, when
  //     read_chunk_neighbors returns its chunks, each item includes a source
  //     field whose value equals the ingestion source URL/identifier."
  // ROI: 35 (BV:7 x Freq:4 + Legal:0 + Defect:7)
  // Behavior: Reuse the raw-data document from Test 5 (or seed a new one) ->
  //   verify every returned item carries source === the ingestion identifier.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB, raw-data-utils
  // @complexity: low
  //
  // Setup:
  //   - Ingest content via handleIngestData with metadata.source = KNOWN_SOURCE.
  //   - Call handleReadChunkNeighbors with either { source: KNOWN_SOURCE,
  //     chunkIndex: 0 } or { filePath: <rawDataPath>, chunkIndex: 0 }.
  //     Both paths must surface the source field (Design Doc §Field
  //     Propagation Map: source is derived from targetPath via
  //     extractSourceFromPath, not from the input key).
  //
  // Verification items:
  //   - Response is a non-empty array
  //   - Every item has a 'source' property of type string
  //   - Every item's source === KNOWN_SOURCE (exact match)
  //
  // Cross-check negative:
  //   - For a handleIngestFile-seeded document (non-raw-data), call
  //     handleReadChunkNeighbors and confirm items do NOT carry a 'source' key
  //     (or source is undefined). This guards against source being incorrectly
  //     populated for file-backed documents.
  //
  // Pass criteria:
  //   - source present and correct on raw-data items; absent on file-backed
  //     items.
  describe('Test 6: Raw-data row includes source field (AC-020)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t6')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t6')
    const KNOWN_SOURCE = 'https://example.com/read-neighbors-source-field'
    let fileBackedPath: string

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      // Raw-data document
      const rawContent = `# Source field test\n\n${'Paragraph body content for source field test. '.repeat(120)}`
      await ragServer.handleIngestData({
        content: rawContent,
        metadata: { source: KNOWN_SOURCE, format: 'markdown' },
      })

      // File-backed document (cross-check negative)
      fileBackedPath = resolve(testDataDir, 'file-backed.txt')
      writeFileSync(fileBackedPath, 'File backed document content. '.repeat(100))
      await ragServer.handleIngestFile({ filePath: fileBackedPath })
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('raw-data items carry source === ingestion identifier', async () => {
      const response = await ragServer.handleReadChunkNeighbors({
        source: KNOWN_SOURCE,
        chunkIndex: 0,
      })
      const items = parseItems(response)

      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(typeof item.source).toBe('string')
        expect(item.source).toBe(KNOWN_SOURCE)
      }
    })

    it('file-backed items do NOT carry a source field', async () => {
      const response = await ragServer.handleReadChunkNeighbors({
        filePath: fileBackedPath,
        chunkIndex: 0,
      })
      const items = parseItems(response)

      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        // source key is either absent or undefined on file-backed items
        expect(item.source).toBeUndefined()
      }
    })
  })

  // =============================================================================
  // Test 7: P95 under 100ms on 10k chunk document (NFR)
  // =============================================================================
  // AC: PRD Non-Functional Requirement "P95 under 100 ms for a window of
  //     before=2, after=2 on a document with up to 10,000 chunks, measured in
  //     CI on the default GitHub Actions runner."
  // ROI: 85 (BV:8 x Freq:10 + Legal:0 + Defect:5)
  // Behavior: Seed a LanceDB table with 10,000 chunks for a single filePath ->
  //   warm up with 3 discarded calls -> measure 20 consecutive neighbor calls
  //   -> assert computed P95 < 100 ms.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB
  // @complexity: high
  //
  // Setup (per Design Doc §Performance Measurement Mechanism):
  //   - Insert 10,000 contiguous chunks for one synthetic filePath. Use a
  //     small constant vector (e.g., zeros of embedding dimension) to keep
  //     insertion fast; this is setup, not part of the measured section.
  //   - Consider bypassing the full handleIngestFile pipeline (which invokes
  //     the real embedder) by inserting directly through vectorStore if the
  //     existing test helper (createTestChunk from vectordb unit tests)
  //     allows — otherwise accept longer setup and rely on vitest's 10s
  //     default timeout; if setup exceeds that, split via beforeAll so only
  //     the measured section runs under the per-test timeout.
  //
  // Measurement protocol:
  //   - Warm up: call handleReadChunkNeighbors 3 times with before=2, after=2
  //     on varied chunkIndex values (e.g., 100, 5000, 9500); discard timings.
  //   - Measurement: call handleReadChunkNeighbors 20 times with before=2,
  //     after=2 on a varied set of chunkIndex values spanning start / middle /
  //     end (e.g., a cycle through [50, 2500, 5000, 7500, 9950] four times).
  //   - Record per-call wall-clock using performance.now() deltas (start
  //     BEFORE the call, end AFTER the awaited promise resolves).
  //   - Sort timings ascending; P95 = timings[Math.ceil(0.95 * 20) - 1]
  //     (index 18 of the sorted 20-element array, i.e., the 19th smallest).
  //
  // Verification items:
  //   - All 20 measured calls resolve without throwing
  //   - P95 value is a finite number > 0 (sanity)
  //   - P95 < 100 (milliseconds)
  //   - Emit the observed P95 via console.error(`P95: ${p95.toFixed(2)} ms`)
  //     so CI logs capture the value for the PR description (PRD Success
  //     Criteria 2)
  //
  // Pass criteria:
  //   - P95 strictly below 100 ms.
  //   - On failure, the failure message includes the full timings array for
  //     the PR author (Design Doc §Performance Measurement Mechanism).
  //
  // Flake mitigation note:
  //   - The 100 ms target includes headroom vs. the expected operation cost
  //     on GitHub Actions shared runners (Design Doc §Risks). If the test
  //     flakes in practice, relax to P95 < 150 ms and record the observed
  //     distribution per Design Doc mitigation guidance.
  describe('Test 7: P95 under 100ms on 10k chunk document (NFR)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t7')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t7')
    // Synthetic path must live under baseDir so validateFilePath accepts it.
    // The file itself need not exist on disk (must exist as a real path for
    // validation: writeFileSync an empty file).
    const syntheticFilePath = resolve(testDataDir, 'read-neighbors-perf.txt')
    const TOTAL_CHUNKS = 10000
    const EMBEDDING_DIM = 384

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      // Create a minimal placeholder file so validateFilePath's realpath/BASE_DIR
      // check succeeds. Content is irrelevant — we bypass ingest and write chunks
      // directly via vectorStore.insertChunks.
      writeFileSync(syntheticFilePath, 'placeholder')
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      // Direct vectorStore insertion bypasses the embedder pipeline for speed.
      // Use a constant small vector — content matters for predicate filtering,
      // not for the (unused-here) search pathway.
      const vectorStore = getVectorStore(ragServer)
      const timestamp = new Date().toISOString()
      const constantVector = new Array(EMBEDDING_DIM).fill(0.01)

      // Insert in batches of 1000 to keep each insert call modest.
      const BATCH = 1000
      for (let start = 0; start < TOTAL_CHUNKS; start += BATCH) {
        const end = Math.min(start + BATCH, TOTAL_CHUNKS)
        const batch: VectorChunk[] = []
        for (let i = start; i < end; i++) {
          batch.push({
            id: randomUUID(),
            filePath: syntheticFilePath,
            chunkIndex: i,
            text: `synthetic chunk ${i}`,
            vector: constantVector,
            metadata: {
              fileName: 'read-neighbors-perf.txt',
              fileSize: 0,
              fileType: 'txt',
            },
            fileTitle: null,
            timestamp,
          })
        }
        await vectorStore.insertChunks(batch)
      }
      await vectorStore.optimize()
    }, 120000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('P95 of 20 neighbor reads under 100 ms', async () => {
      // Warm-up (discard timings): varied indices to avoid cold-cache bias
      for (const warmIdx of [100, 5000, 9500]) {
        await ragServer.handleReadChunkNeighbors({
          filePath: syntheticFilePath,
          chunkIndex: warmIdx,
        })
      }

      // Measurement: 20 calls cycling through start/middle/end indices
      const cycle = [50, 2500, 5000, 7500, 9950]
      const timings: number[] = []
      for (let iter = 0; iter < 4; iter++) {
        for (const idx of cycle) {
          const start = performance.now()
          await ragServer.handleReadChunkNeighbors({
            filePath: syntheticFilePath,
            chunkIndex: idx,
          })
          timings.push(performance.now() - start)
        }
      }

      expect(timings).toHaveLength(20)
      const sorted = [...timings].sort((a, b) => a - b)
      // P95 at n=20: Math.ceil(0.95 * 20) - 1 = index 18 (19th smallest)
      const p95 = sorted[Math.ceil(0.95 * 20) - 1] ?? Number.NaN

      // Emit for PR description capture (PRD Success Criteria 2)
      console.error(`P95: ${p95.toFixed(2)} ms`)

      expect(Number.isFinite(p95)).toBe(true)
      expect(p95).toBeGreaterThan(0)

      if (!(p95 < 100)) {
        // Attach timings to the assertion failure message for diagnostics
        throw new Error(
          `P95 ${p95.toFixed(2)} ms exceeded 100 ms. Full timings (ms): ${JSON.stringify(timings)}`
        )
      }
      expect(p95).toBeLessThan(100)
    }, 60000)
  })

  // =============================================================================
  // Test 8 (extension): AC-007 over-large window clamped to document boundaries
  // =============================================================================
  // AC: AC-007 "When before/after request a window larger than the document,
  //     the tool returns only the chunks that exist with no error."
  // Behavior: Seed a small document (~5 chunks). Call handleReadChunkNeighbors
  //   with before=100, after=100 centered at chunkIndex=2. Assert the response
  //   contains only existing chunks (length <= 5), no error, ascending order.
  // @category: edge-case
  // @dependency: RAGServer, VectorStore, LanceDB
  describe('Test 8: Over-large window clamped (AC-007 extension)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t8')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t8')
    let ingestedFilePath: string
    let chunkCount: number

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'small-doc.txt')
      writeFileSync(
        ingestedFilePath,
        'Compact document content for over-large window test. '.repeat(100)
      )
      const ingestRes = await ragServer.handleIngestFile({ filePath: ingestedFilePath })
      const ingest = JSON.parse(ingestRes.content[0].text)
      chunkCount = ingest.chunkCount
      expect(chunkCount).toBeGreaterThan(0)
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('clamps to existing chunks when before/after far exceed document size', async () => {
      const targetIndex = Math.min(2, Math.max(0, chunkCount - 1))
      const response = await ragServer.handleReadChunkNeighbors({
        filePath: ingestedFilePath,
        chunkIndex: targetIndex,
        before: 100,
        after: 100,
      })
      const items = parseItems(response)

      expect(items.length).toBeLessThanOrEqual(chunkCount)
      expect(items.length).toBeGreaterThan(0)
      // Strictly ascending
      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1]
        const curr = items[i]
        if (!prev || !curr) throw new Error('Unexpected undefined item in ascending check')
        expect(curr.chunkIndex).toBeGreaterThan(prev.chunkIndex)
      }
      // All returned chunkIndex values are within the actual document range
      for (const item of items) {
        expect(item.chunkIndex).toBeGreaterThanOrEqual(0)
        expect(item.chunkIndex).toBeLessThanOrEqual(chunkCount - 1)
      }
    })
  })

  // =============================================================================
  // Test 9 (extension): AC-009 negative / non-integer before/after at MCP boundary
  // =============================================================================
  // AC: AC-009 "When before or after is negative or non-integer, the tool
  //     returns a validation error (McpError InvalidParams) without accessing
  //     storage."
  // Behavior: Call handleReadChunkNeighbors with before: -1 and after: 2.5 in
  //   separate invocations. Assert both reject with McpError whose code is
  //   ErrorCode.InvalidParams.
  describe('Test 9: Negative / non-integer before/after at MCP boundary (AC-009 extension)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t9')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t9')
    let ingestedFilePath: string

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'validation-doc.txt')
      writeFileSync(ingestedFilePath, 'Validation boundary test content. '.repeat(60))
      await ragServer.handleIngestFile({ filePath: ingestedFilePath })
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('rejects negative before with McpError InvalidParams', async () => {
      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
          chunkIndex: 5,
          before: -1,
        })
      ).rejects.toThrow(McpError)

      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
          chunkIndex: 5,
          before: -1,
        })
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
    })

    it('rejects non-integer after with McpError InvalidParams', async () => {
      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
          chunkIndex: 5,
          after: 2.5,
        })
      ).rejects.toThrow(McpError)

      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
          chunkIndex: 5,
          after: 2.5,
        })
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
    })
  })

  // =============================================================================
  // Test 10 (extension): AC-010 missing / negative chunkIndex at MCP boundary
  // =============================================================================
  // AC: AC-010 "When chunkIndex is missing, negative, or non-integer, the tool
  //     returns a validation error (McpError InvalidParams) without accessing
  //     storage."
  // Behavior: Call handleReadChunkNeighbors without chunkIndex (cast through
  //   unknown), and with chunkIndex: -1. Assert both reject with McpError
  //   whose code is ErrorCode.InvalidParams.
  describe('Test 10: Missing / negative chunkIndex at MCP boundary (AC-010 extension)', () => {
    let ragServer: RAGServer
    const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-t10')
    const testDataDir = resolve('./tmp/test-data-read-neighbors-t10')
    let ingestedFilePath: string

    beforeAll(async () => {
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })
      ragServer = new RAGServer({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
      await ragServer.initialize()

      ingestedFilePath = resolve(testDataDir, 'validation-chunk-index.txt')
      writeFileSync(ingestedFilePath, 'chunkIndex validation test content. '.repeat(60))
      await ragServer.handleIngestFile({ filePath: ingestedFilePath })
    }, 30000)

    afterAll(() => {
      rmSync(testDbPath, { recursive: true, force: true })
      rmSync(testDataDir, { recursive: true, force: true })
    })

    it('rejects missing chunkIndex with McpError InvalidParams', async () => {
      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
        } as unknown as ReadChunkNeighborsInput)
      ).rejects.toThrow(McpError)

      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
        } as unknown as ReadChunkNeighborsInput)
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
    })

    it('rejects negative chunkIndex with McpError InvalidParams', async () => {
      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
          chunkIndex: -1,
        })
      ).rejects.toThrow(McpError)

      await expect(
        ragServer.handleReadChunkNeighbors({
          filePath: ingestedFilePath,
          chunkIndex: -1,
        })
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
    })
  })
})
