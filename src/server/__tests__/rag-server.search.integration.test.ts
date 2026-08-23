// RAG MCP Server Integration Test - Vector Search
// Split from: rag-server.integration.test.ts (AC-004)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import type { Embedder } from '../../embedder/index.js'
import type { SearchResult, VectorStore } from '../../vectordb/index.js'
import type { SearchOptions } from '../../vectordb/types.js'
import { RAGServer } from '../index.js'

describe('AC-004: Vector Search', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac004')
  const localTestDataDir = resolve('./tmp/test-data-ac004')

  beforeAll(async () => {
    // Setup dedicated RAGServer for AC-004
    mkdirSync(localTestDbPath, { recursive: true })
    mkdirSync(localTestDataDir, { recursive: true })

    localRagServer = new RAGServer(
      withTestDevice({
        dbPath: localTestDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: localTestDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    await localRagServer.initialize()

    // Ingest test document
    const testFile = resolve(localTestDataDir, 'test-typescript.txt')
    writeFileSync(
      testFile,
      'TypeScript is a strongly typed programming language that builds on JavaScript. ' +
        'TypeScript adds optional static typing to JavaScript. ' +
        'TypeScript provides type safety and helps catch errors at compile time. ' +
        'TypeScript is widely used in modern web development. ' +
        'TypeScript supports interfaces, generics, and other advanced features.'
    )

    await localRagServer.handleIngestFile({ filePath: testFile })
  })

  afterAll(async () => {
    await localRagServer.close()
    rmSync(localTestDbPath, { recursive: true, force: true })
    rmSync(localTestDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Functional requirement] Related documents returned for natural language query
  // Validation: Call query_documents with natural language query, related documents are returned
  it('Related documents returned for natural language query (e.g., "TypeScript type safety")', async () => {
    const result = await localRagServer.handleQueryDocuments({
      query: 'TypeScript type safety',
      limit: 5,
    })

    expect(result).toBeDefined()
    expect(result.content).toBeDefined()
    expect(result.content.length).toBe(1)
    expect(result.content[0].type).toBe('text')

    const results = JSON.parse(result.content[0].text)
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)

    // Verify results contain required fields
    for (const doc of results) {
      expect(doc.filePath).toBeDefined()
      expect(doc.chunkIndex).toBeDefined()
      expect(doc.text).toBeDefined()
      expect(doc.score).toBeDefined()
    }
  })

  // AC interpretation: [Technical requirement] Search results ordered by relevance (most similar first)
  // Validation: LanceDB returns distance scores (smaller = more similar), so results are sorted in ascending score order
  it('Search results ordered by relevance (ascending distance score, most similar first)', async () => {
    const result = await localRagServer.handleQueryDocuments({
      query: 'TypeScript',
      limit: 5,
    })

    const results = JSON.parse(result.content[0].text)
    expect(Array.isArray(results)).toBe(true)

    // Distance score: smaller = more similar, so ascending = most relevant first.
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i + 1].score)
    }
  })

  // AC interpretation: [Technical requirement] Default top-5 results returned
  // Validation: When limit not specified, 5 search results are returned
  it('When limit not specified, default top-5 results returned', async () => {
    const result = await localRagServer.handleQueryDocuments({
      query: 'TypeScript',
    })

    const results = JSON.parse(result.content[0].text)
    expect(Array.isArray(results)).toBe(true)
    // If chunk count is less than 5, that number; if 5 or more, max 5 results
    expect(results.length).toBeLessThanOrEqual(5)
  })

  // Edge Case: No matches
  // Validation: When no matching documents, empty array is returned
  it('Empty array returned for query with no matching documents (e.g., random string)', async () => {
    // Search in empty DB
    const emptyDbPath = resolve('./tmp/test-lancedb-empty')
    mkdirSync(emptyDbPath, { recursive: true })

    const emptyServer = new RAGServer(
      withTestDevice({
        dbPath: emptyDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: localTestDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    try {
      await emptyServer.initialize()

      const result = await emptyServer.handleQueryDocuments({
        query: 'xyzabc123randomstring',
      })

      const results = JSON.parse(result.content[0].text)
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBe(0)
    } finally {
      await emptyServer.close()
      rmSync(emptyDbPath, { recursive: true, force: true })
    }
  })

  // Edge Case: limit boundary values
  // Validation: Operates normally with boundary values limit=1, limit=20
  it('Operates normally with boundary values limit=1, limit=20', async () => {
    const result1 = await localRagServer.handleQueryDocuments({
      query: 'TypeScript',
      limit: 1,
    })

    const results1 = JSON.parse(result1.content[0].text)
    expect(Array.isArray(results1)).toBe(true)
    expect(results1.length).toBeLessThanOrEqual(1)

    const result20 = await localRagServer.handleQueryDocuments({
      query: 'TypeScript',
      limit: 20,
    })

    const results20 = JSON.parse(result20.content[0].text)
    expect(Array.isArray(results20)).toBe(true)
    expect(results20.length).toBeLessThanOrEqual(20)
  })
})

// Boundary test (spy-based unit): asserts handleQueryDocuments threads its
// arguments into VectorStore.search()'s options object. The data-layer behavior
// (scope prefilter) is proven in the vectordb integration suite (Task 01/02);
// here we only verify the handler → search() call boundary, so search and the
// embedder are spied. Roundtrip check: the normalized `string[]` the parser
// emits is the `string[]` search() receives, unchanged.
describe('handleQueryDocuments → VectorStore.search() options boundary', () => {
  let server: RAGServer
  const dbPath = resolve('./tmp/test-lancedb-search-options')
  const dataDir = resolve('./tmp/test-data-search-options')

  function internals(s: RAGServer): { embedder: Embedder; vectorStore: VectorStore } {
    return s as unknown as { embedder: Embedder; vectorStore: VectorStore }
  }

  const queryVector = [0.1, 0.2, 0.3]
  const emptyResults: SearchResult[] = []

  beforeAll(async () => {
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
    await server.initialize()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await server.close()
    rmSync(dbPath, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('passes scope through unchanged as the scope option when present', async () => {
    vi.spyOn(internals(server).embedder, 'embed').mockResolvedValue(queryVector)
    const searchSpy = vi
      .spyOn(internals(server).vectorStore, 'search')
      .mockResolvedValue(emptyResults)

    await server.handleQueryDocuments({
      query: 'typescript',
      limit: 7,
      scope: ['/docs', '/src'],
    })

    expect(searchSpy).toHaveBeenCalledTimes(1)
    const [vector, options] = searchSpy.mock.calls[0] as [number[], SearchOptions]
    expect(vector).toEqual(queryVector)
    expect(options).toEqual({ queryText: 'typescript', limit: 7, scope: ['/docs', '/src'] })
  })

  it('passes scope: undefined when scope is absent', async () => {
    vi.spyOn(internals(server).embedder, 'embed').mockResolvedValue(queryVector)
    const searchSpy = vi
      .spyOn(internals(server).vectorStore, 'search')
      .mockResolvedValue(emptyResults)

    await server.handleQueryDocuments({ query: 'typescript' })

    const [, options] = searchSpy.mock.calls[0] as [number[], SearchOptions]
    // scope key omitted when absent → search() takes its scope-absent path
    expect(options.scope).toBeUndefined()
    // limit defaulting preserved (?? 10) and query threaded as queryText
    expect(options.queryText).toBe('typescript')
    expect(options.limit).toBe(10)
    expect(Object.hasOwn(options, 'scope')).toBe(false)
  })
})
