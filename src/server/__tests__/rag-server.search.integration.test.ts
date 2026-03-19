// RAG MCP Server Integration Test - Vector Search
// Split from: rag-server.integration.test.ts (AC-004)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../index.js'

describe('AC-004: Vector Search', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac004')
  const localTestDataDir = resolve('./tmp/test-data-ac004')

  beforeAll(async () => {
    // Setup dedicated RAGServer for AC-004
    mkdirSync(localTestDbPath, { recursive: true })
    mkdirSync(localTestDataDir, { recursive: true })

    localRagServer = new RAGServer({
      dbPath: localTestDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDir: localTestDataDir,
      maxFileSize: 100 * 1024 * 1024,
    })

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

  // AC interpretation: [Technical requirement] Search results sorted by score (descending)
  // Validation: Search result scores are sorted in descending order
  it('Search results sorted by score (descending)', async () => {
    const result = await localRagServer.handleQueryDocuments({
      query: 'TypeScript',
      limit: 5,
    })

    const results = JSON.parse(result.content[0].text)
    expect(Array.isArray(results)).toBe(true)

    // Verify scores are sorted in descending order
    // LanceDB returns distance scores (smaller means more similar), so verify ascending sort
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

    const emptyServer = new RAGServer({
      dbPath: emptyDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDir: localTestDataDir,
      maxFileSize: 100 * 1024 * 1024,
    })

    await emptyServer.initialize()

    const result = await emptyServer.handleQueryDocuments({
      query: 'xyzabc123randomstring',
    })

    const results = JSON.parse(result.content[0].text)
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(0)

    rmSync(emptyDbPath, { recursive: true, force: true })
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
