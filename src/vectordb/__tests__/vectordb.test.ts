import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextChunk } from '../../chunker/index.js'
import { ingestSingleFile } from '../../cli/ingest.js'
import { buildVectorChunks, computeContentHash } from '../../ingest/compute.js'
import { type VectorChunk, VectorStore } from '../index.js'
import { type ChunkRow, DatabaseError, isLanceDBRawResult, toSearchResult } from '../types.js'

describe('VectorStore', () => {
  const testDbPath = './tmp/test-vectordb'

  beforeEach(() => {
    // Clean up test database before each test
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up after tests
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true })
    }
  })

  /**
   * Helper function to create a test vector chunk
   */
  function createTestChunk(
    text: string,
    filePath: string,
    chunkIndex: number,
    vector?: number[]
  ): VectorChunk {
    return {
      id: randomUUID(),
      filePath,
      chunkIndex,
      text,
      vector: vector || new Array(384).fill(0).map(() => Math.random()),
      metadata: {
        fileName: path.basename(filePath),
        fileSize: text.length,
        fileType: path.extname(filePath).slice(1),
      },
      fileTitle: null,
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Helper function to create a normalized vector (L2 norm = 1)
   */
  function createNormalizedVector(seed: number): number[] {
    const vector = new Array(384).fill(0).map((_, i) => Math.sin(seed + i))
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))
    return vector.map((x) => x / norm)
  }

  /**
   * Run `fn` against a freshly initialized VectorStore backed by a unique,
   * isolated temp DB path. The path is removed before construction and again
   * in a finally block, so each test gets a clean DB and leaves nothing behind
   * regardless of pass/fail. Removes the per-test
   * `dbPath + existsSync/rmSync + try/finally` boilerplate.
   */
  async function withTempDb(
    name: string,
    fn: (store: VectorStore, dbPath: string) => Promise<void>
  ): Promise<void> {
    const dbPath = `./tmp/test-vectordb-${name}`
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { recursive: true })
    }
    try {
      const store = new VectorStore({ dbPath, tableName: 'chunks' })
      await store.initialize()
      await fn(store, dbPath)
    } finally {
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }
    }
  }

  describe('deleteChunks behavior', () => {
    it('removes all chunks for the given file path', async () => {
      const store = new VectorStore({ dbPath: testDbPath, tableName: 'chunks' })
      await store.initialize()
      await store.insertChunks([
        createTestChunk('keep body', '/docs/keep.txt', 0),
        createTestChunk('drop body one', '/docs/drop.txt', 0),
        createTestChunk('drop body two', '/docs/drop.txt', 1),
      ])

      const removed = await store.deleteChunks('/docs/drop.txt')
      expect(removed).toBe(2)

      const paths = (await store.listFiles()).map((f) => f.filePath)
      expect(paths).toContain('/docs/keep.txt')
      expect(paths).not.toContain('/docs/drop.txt')
    })

    it('is a no-op success when no chunk matches the file path', async () => {
      const store = new VectorStore({ dbPath: testDbPath, tableName: 'chunks' })
      await store.initialize()
      await store.insertChunks([createTestChunk('only body', '/docs/keep.txt', 0)])

      await expect(store.deleteChunks('/docs/never-ingested.txt')).resolves.toBe(0)
      expect((await store.listFiles()).map((f) => f.filePath)).toEqual(['/docs/keep.txt'])
    })

    it('returns 0 when the table does not exist yet', async () => {
      const store = new VectorStore({ dbPath: testDbPath, tableName: 'chunks' })
      await store.initialize()
      await expect(store.deleteChunks('/docs/anything.txt')).resolves.toBe(0)
    })

    it('escapes single quotes in the file path (SQL-injection-safe)', async () => {
      const store = new VectorStore({ dbPath: testDbPath, tableName: 'chunks' })
      await store.initialize()
      const tricky = "/docs/o'brien's file.txt"
      await store.insertChunks([
        createTestChunk('tricky body', tricky, 0),
        createTestChunk('other body', '/docs/other.txt', 0),
      ])

      await store.deleteChunks(tricky)

      expect((await store.listFiles()).map((f) => f.filePath)).toEqual(['/docs/other.txt'])
    })

    // Sync reconciles by a case-folded comparison key on Windows but must delete
    // by the verbatim stored spelling. This pins the storage fact that makes the
    // per-variant deletion necessary: two spellings of one Windows file are two
    // independent row sets here, so deleting the key would delete nothing and
    // deleting one spelling cannot touch the other.
    it('deletes only the exact stored spelling and leaves a case-differing spelling of the same file', async () => {
      await withTempDb('delete-exact-spelling', async (store) => {
        const lowerSpelling = 'c:\\root\\sub\\report.md'
        const upperSpelling = 'C:\\Root\\Sub\\Report.md'
        await store.insertChunks([
          createTestChunk('stale variant', lowerSpelling, 0, createNormalizedVector(1)),
          createTestChunk('live variant', upperSpelling, 0, createNormalizedVector(2)),
        ])

        expect(await store.deleteChunks(lowerSpelling)).toBe(1)

        expect((await store.listFiles()).map((file) => file.filePath)).toEqual([upperSpelling])
      })
    })

    // Guards against a future rewrite of the equality predicate into a LIKE
    // term: `%` and `_` in a stored path are literal characters, so a path
    // containing them must not match its neighbours.
    it('treats LIKE metacharacters in the path as literals, not wildcards', async () => {
      await withTempDb('delete-like-metacharacters', async (store) => {
        const wildcardish = '/docs/100%_done.md'
        const neighbour = '/docs/100x1done.md'
        await store.insertChunks([
          createTestChunk('wildcardish body', wildcardish, 0, createNormalizedVector(1)),
          createTestChunk('neighbour body', neighbour, 0, createNormalizedVector(2)),
        ])

        expect(await store.deleteChunks(wildcardish)).toBe(1)

        expect((await store.listFiles()).map((file) => file.filePath)).toEqual([neighbour])
      })
    })
  })

  describe('FTS per-request degrade', () => {
    it('falls back to vector-only for a failed FTS query without disabling FTS', async () => {
      const store = new VectorStore({ dbPath: testDbPath, tableName: 'chunks' })
      await store.initialize()
      await store.insertChunks([
        createTestChunk(
          'alpha document about typescript',
          '/d/a.txt',
          0,
          createNormalizedVector(1)
        ),
        createTestChunk('beta document about rust', '/d/b.txt', 0, createNormalizedVector(2)),
      ])
      expect((await store.getStatus()).ftsIndexEnabled).toBe(true)

      // Force only the FTS path (table.search) to throw; the vector path
      // (table.vectorSearch) is a separate method and stays intact.
      const table = (store as unknown as { table: { search: (...args: unknown[]) => unknown } })
        .table
      const ftsSpy = vi.spyOn(table, 'search').mockImplementationOnce(() => {
        throw new Error('transient FTS failure')
      })

      // The query still resolves with vector-only results (no throw).
      const results = await store.search(createNormalizedVector(1), {
        queryText: 'typescript',
        limit: 5,
      })
      expect(results.length).toBeGreaterThan(0)

      // FTS is NOT permanently disabled by a single failed query.
      expect((await store.getStatus()).ftsIndexEnabled).toBe(true)

      // And the next query retries hybrid search successfully.
      ftsSpy.mockRestore()
      const retry = await store.search(createNormalizedVector(1), {
        queryText: 'typescript',
        limit: 5,
      })
      expect(retry.length).toBeGreaterThan(0)
    })
  })

  describe('Phase 1: FTS Index Creation and Migration', () => {
    describe('FTS index auto-creation', () => {
      it('should create FTS index on initialize when table exists', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        // Insert some data to create the table
        const chunk = createTestChunk(
          'This is a test document about TypeScript programming',
          '/test/doc.txt',
          0,
          createNormalizedVector(1)
        )
        await store.insertChunks([chunk])

        // Get status and check FTS is enabled
        const status = await store.getStatus()
        expect(status).toHaveProperty('ftsIndexEnabled')
        expect(status.ftsIndexEnabled).toBe(true)
      })

      it('should set ftsIndexEnabled to false when table does not exist yet', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        // No data inserted, table doesn't exist
        const status = await store.getStatus()
        expect(status.ftsIndexEnabled).toBe(false)
      })

      it('should report searchMode in status', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        const chunk = createTestChunk(
          'Test document content',
          '/test/doc.txt',
          0,
          createNormalizedVector(1)
        )
        await store.insertChunks([chunk])

        const status = await store.getStatus()
        expect(status).toHaveProperty('searchMode')
        expect(['hybrid', 'vector-only']).toContain(status.searchMode)
      })
    })

    describe('Fallback behavior', () => {
      it('should continue working even if FTS index creation fails', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        // Insert data
        const chunk = createTestChunk(
          'Fallback test document',
          '/test/fallback.txt',
          0,
          createNormalizedVector(1)
        )
        await store.insertChunks([chunk])

        // Search should still work (vector-only) and return the inserted document
        const results = await store.search(createNormalizedVector(1), {
          queryText: 'test query',
          limit: 10,
        })
        expect(results).toHaveLength(1)
        expect(results[0]?.filePath).toBe('/test/fallback.txt')
        expect(results[0]?.text).toBe('Fallback test document')
      })
    })
  })

  describe('Phase 2: Hybrid Search', () => {
    describe('Search with query text', () => {
      it('should accept query text parameter for hybrid search', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        // Insert test documents
        const chunks = [
          createTestChunk(
            'ProjectLifetimeScope is a VContainer concept for dependency injection',
            '/test/vcontainer.md',
            0,
            createNormalizedVector(1)
          ),
          createTestChunk(
            'Profile Analyzer is a Unity tool for performance profiling',
            '/test/profiler.md',
            0,
            createNormalizedVector(2)
          ),
          createTestChunk(
            'Game patterns include Manager classes and LifetimeScope',
            '/test/patterns.md',
            0,
            createNormalizedVector(3)
          ),
        ]

        for (const chunk of chunks) {
          await store.insertChunks([chunk])
        }

        // Search with exact keyword match
        const queryVector = createNormalizedVector(1)
        const results = await store.search(queryVector, {
          queryText: 'ProjectLifetimeScope',
          limit: 10,
        })

        // All 3 documents should be returned
        expect(results).toHaveLength(3)

        // With hybrid search, exact keyword match should rank higher
        // The first result MUST contain "ProjectLifetimeScope"
        expect(results[0]).toBeDefined()
        expect(results[0]!.text).toContain('ProjectLifetimeScope')
        expect(results[0]!.filePath).toBe('/test/vcontainer.md')
      })

      it('should fall back to vector-only search when query text is empty', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        const chunk = createTestChunk(
          'Test document for vector search',
          '/test/doc.txt',
          0,
          createNormalizedVector(1)
        )
        await store.insertChunks([chunk])

        // Search with empty query text (should use vector-only)
        const results = await store.search(createNormalizedVector(1), { queryText: '', limit: 10 })

        // Should return the inserted document via vector-only search
        expect(results).toHaveLength(1)
        expect(results[0]?.filePath).toBe('/test/doc.txt')
        expect(results[0]?.text).toBe('Test document for vector search')
      })

      it('should maintain backward compatibility with vector-only search', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        const chunk = createTestChunk(
          'Backward compatibility test',
          '/test/compat.txt',
          0,
          createNormalizedVector(1)
        )
        await store.insertChunks([chunk])

        // Original search signature should still work (queryText = undefined)
        const results = await store.search(createNormalizedVector(1), { limit: 10 })

        // Should return the inserted document
        expect(results).toHaveLength(1)
        expect(results[0]?.filePath).toBe('/test/compat.txt')
        expect(results[0]?.text).toBe('Backward compatibility test')
      })
    })

    describe('Japanese text support', () => {
      it('should find Japanese documents with ngram tokenizer', async () => {
        const store = new VectorStore({
          dbPath: testDbPath,
          tableName: 'chunks',
        })

        await store.initialize()

        // Doc with Japanese text (keyword: dependency injection in Japanese)
        const japaneseDoc = createTestChunk(
          '依存性注入コンテナはオブジェクトのライフサイクルを管理します',
          '/test/japanese.md',
          0,
          createNormalizedVector(10)
        )

        // Doc with English text only
        const englishDoc = createTestChunk(
          'Vector database stores embeddings for semantic search',
          '/test/english.md',
          0,
          createNormalizedVector(1)
        )

        await store.insertChunks([japaneseDoc])
        await store.insertChunks([englishDoc])

        // Search with Japanese keyword
        const queryVector = createNormalizedVector(1)
        const results = await store.search(queryVector, { queryText: '依存性注入', limit: 10 })

        // Verify Japanese document is found (ngram tokenizer works)
        const foundJapanese = results.some((r) => r.filePath === '/test/japanese.md')
        expect(foundJapanese).toBe(true)

        // Verify both documents are returned
        expect(results).toHaveLength(2)
      })
    })
  })

  describe('Search mode behavior', () => {
    /**
     * Test data design:
     * - doc1: Contains keyword "UniqueKeyword", but vector is far from query
     * - doc2: No keyword match, but vector is close to query
     *
     * Expected behavior:
     * - hybridWeight=0 (vector-only): doc2 ranks first (vector similarity)
     * - hybridWeight=1 (FTS-only): doc1 ranks first (keyword match)
     * - hybridWeight=0.6 (hybrid): doc1 ranks first (keyword match prioritized)
     */

    it('should use vector similarity order when hybridWeight=0', async () => {
      const vectorOnlyDbPath = './tmp/test-vectordb-vector-only'
      if (fs.existsSync(vectorOnlyDbPath)) {
        fs.rmSync(vectorOnlyDbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath: vectorOnlyDbPath,
          tableName: 'chunks',
          hybridWeight: 0, // Vector-only mode
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        // doc1: Has keyword, but vector is far from query
        const doc1 = createTestChunk(
          'UniqueKeyword appears in this document about something else',
          '/test/keyword-match.md',
          0,
          createNormalizedVector(100) // Far from query
        )

        // doc2: No keyword, but vector is close to query
        const doc2 = createTestChunk(
          'This document has similar semantic meaning without the special term',
          '/test/vector-match.md',
          0,
          createNormalizedVector(1) // Close to query
        )

        await store.insertChunks([doc1])
        await store.insertChunks([doc2])

        // Search with keyword that matches doc1, but query vector close to doc2
        const results = await store.search(queryVector, { queryText: 'UniqueKeyword', limit: 10 })

        expect(results).toHaveLength(2)

        // With hybridWeight=0, vector similarity should determine order
        // doc2 (vector close) should rank first
        expect(results[0]?.filePath).toBe('/test/vector-match.md')
        expect(results[1]?.filePath).toBe('/test/keyword-match.md')
      } finally {
        if (fs.existsSync(vectorOnlyDbPath)) {
          fs.rmSync(vectorOnlyDbPath, { recursive: true })
        }
      }
    })

    it('should boost keyword matches when hybridWeight=1', async () => {
      const ftsOnlyDbPath = './tmp/test-vectordb-fts-only'
      if (fs.existsSync(ftsOnlyDbPath)) {
        fs.rmSync(ftsOnlyDbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath: ftsOnlyDbPath,
          tableName: 'chunks',
          hybridWeight: 1, // Maximum keyword boost
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        // doc1: Has keyword match, but farther vector distance
        const doc1 = createTestChunk(
          'UniqueKeyword appears in this document about something else',
          '/test/keyword-match.md',
          0,
          createNormalizedVector(5)
        )

        // doc2: No keyword match, but closer vector distance
        const doc2 = createTestChunk(
          'This document has similar semantic meaning without the special term',
          '/test/vector-match.md',
          0,
          createNormalizedVector(3)
        )

        await store.insertChunks([doc1])
        await store.insertChunks([doc2])

        const results = await store.search(queryVector, { queryText: 'UniqueKeyword', limit: 10 })

        expect(results).toHaveLength(2)

        // Keyword match should boost doc1 to rank higher despite farther vector distance
        expect(results[0]?.filePath).toBe('/test/keyword-match.md')
        expect(results[1]?.filePath).toBe('/test/vector-match.md')
      } finally {
        if (fs.existsSync(ftsOnlyDbPath)) {
          fs.rmSync(ftsOnlyDbPath, { recursive: true })
        }
      }
    })

    it('should apply keyword boost with default hybridWeight=0.6', async () => {
      const hybridDbPath = './tmp/test-vectordb-hybrid'
      if (fs.existsSync(hybridDbPath)) {
        fs.rmSync(hybridDbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath: hybridDbPath,
          tableName: 'chunks',
          // hybridWeight not specified, uses default 0.6
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        // doc1: Has keyword match, but farther vector distance
        const doc1 = createTestChunk(
          'UniqueKeyword appears in this document about something else',
          '/test/keyword-match.md',
          0,
          createNormalizedVector(5)
        )

        // doc2: No keyword match, but closer vector distance
        const doc2 = createTestChunk(
          'This document has similar semantic meaning without the special term',
          '/test/vector-match.md',
          0,
          createNormalizedVector(3)
        )

        await store.insertChunks([doc1])
        await store.insertChunks([doc2])

        const results = await store.search(queryVector, { queryText: 'UniqueKeyword', limit: 10 })

        expect(results).toHaveLength(2)

        // Keyword match should boost doc1 to rank higher despite farther vector distance
        expect(results[0]?.filePath).toBe('/test/keyword-match.md')
        expect(results[1]?.filePath).toBe('/test/vector-match.md')
      } finally {
        if (fs.existsSync(hybridDbPath)) {
          fs.rmSync(hybridDbPath, { recursive: true })
        }
      }
    })
  })

  /**
   * File Filter Contract:
   *
   * Given: Search results with filePath and distance score
   *
   * Algorithm:
   * 1. Find the best (lowest) distance score per file
   * 2. Rank files by their best score (ascending)
   * 3. Keep only chunks from the top N files
   *
   * Guarantees:
   * - If maxFiles is undefined: no filtering (all results returned)
   * - If maxFiles >= unique file count: all results returned
   * - If maxFiles < unique file count: only top N files' chunks returned
   * - Chunk order within retained files is preserved
   */
  describe('File filter (maxFiles)', () => {
    it('precondition: seed distance produces expected score ordering', async () => {
      await withTempDb('maxfiles-precondition', async (store) => {
        const queryVector = createNormalizedVector(1)

        // Insert chunks with seeds 1, 2, 50 to verify distance ordering
        await store.insertChunks([
          createTestChunk('seed1', '/test/s1.txt', 0, createNormalizedVector(1)),
        ])
        await store.insertChunks([
          createTestChunk('seed2', '/test/s2.txt', 0, createNormalizedVector(2)),
        ])
        await store.insertChunks([
          createTestChunk('seed50', '/test/s50.txt', 0, createNormalizedVector(50)),
        ])

        const results = await store.search(queryVector, { queryText: '', limit: 10 })

        // Verify: seed 1 < seed 2 < seed 50 in distance
        const score1 = results.find((r) => r.filePath === '/test/s1.txt')?.score ?? 999
        const score2 = results.find((r) => r.filePath === '/test/s2.txt')?.score ?? 999
        const score50 = results.find((r) => r.filePath === '/test/s50.txt')?.score ?? 999
        expect(score1).toBeLessThan(score2)
        expect(score2).toBeLessThan(score50)
      })
    })

    it('returns only chunks from best-scoring file when maxFiles=1', async () => {
      const dbPath = './tmp/test-vectordb-maxfiles-1'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath,
          tableName: 'chunks',
          maxFiles: 1,
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        // File A: 2 chunks, close to query vector
        const fileAChunk0 = createTestChunk(
          'File A chunk 0',
          '/test/fileA.txt',
          0,
          createNormalizedVector(1) // Close to query
        )
        const fileAChunk1 = createTestChunk(
          'File A chunk 1',
          '/test/fileA.txt',
          1,
          createNormalizedVector(2)
        )

        // File B: 2 chunks, far from query vector
        const fileBChunk0 = createTestChunk(
          'File B chunk 0',
          '/test/fileB.txt',
          0,
          createNormalizedVector(50) // Far from query
        )
        const fileBChunk1 = createTestChunk(
          'File B chunk 1',
          '/test/fileB.txt',
          1,
          createNormalizedVector(60)
        )

        await store.insertChunks([fileAChunk0, fileAChunk1])
        await store.insertChunks([fileBChunk0, fileBChunk1])

        const results = await store.search(queryVector, { queryText: '', limit: 10 })

        // Only File A chunks should remain (2 chunks inserted)
        expect(results).toHaveLength(2)
        expect(results.every((r) => r.filePath === '/test/fileA.txt')).toBe(true)
        expect(results.some((r) => r.filePath === '/test/fileB.txt')).toBe(false)

        // Chunk order within retained file is preserved
        expect(results[0]?.chunkIndex).toBe(0)
        expect(results[1]?.chunkIndex).toBe(1)
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })

    it('returns chunks from top 2 files when maxFiles=2', async () => {
      const dbPath = './tmp/test-vectordb-maxfiles-2'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath,
          tableName: 'chunks',
          maxFiles: 2,
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        // File A: close to query (seed=1, distance~0)
        await store.insertChunks([
          createTestChunk('File A chunk', '/test/fileA.txt', 0, createNormalizedVector(1)),
        ])

        // File B: medium distance (seed=2, distance~0.46)
        await store.insertChunks([
          createTestChunk('File B chunk', '/test/fileB.txt', 0, createNormalizedVector(2)),
        ])

        // File C: far from query (seed=3, distance~1.41)
        await store.insertChunks([
          createTestChunk('File C chunk', '/test/fileC.txt', 0, createNormalizedVector(3)),
        ])

        const results = await store.search(queryVector, { queryText: '', limit: 10 })

        // File A and File B should remain, File C excluded
        expect(results.length).toBe(2)
        const filePaths = results.map((r) => r.filePath)
        expect(filePaths).toContain('/test/fileA.txt')
        expect(filePaths).toContain('/test/fileB.txt')
        expect(filePaths).not.toContain('/test/fileC.txt')
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })

    it('returns all results when maxFiles is not set', async () => {
      const dbPath = './tmp/test-vectordb-maxfiles-unset'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath,
          tableName: 'chunks',
          // maxFiles not set
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        await store.insertChunks([
          createTestChunk('File A chunk', '/test/fileA.txt', 0, createNormalizedVector(1)),
        ])
        await store.insertChunks([
          createTestChunk('File B chunk', '/test/fileB.txt', 0, createNormalizedVector(10)),
        ])
        await store.insertChunks([
          createTestChunk('File C chunk', '/test/fileC.txt', 0, createNormalizedVector(50)),
        ])

        const results = await store.search(queryVector, { queryText: '', limit: 10 })

        // All 3 files should be returned
        expect(results).toHaveLength(3)
        const filePaths = results.map((r) => r.filePath)
        expect(filePaths).toContain('/test/fileA.txt')
        expect(filePaths).toContain('/test/fileB.txt')
        expect(filePaths).toContain('/test/fileC.txt')
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })

    it('returns all results when maxFiles >= unique file count', async () => {
      const dbPath = './tmp/test-vectordb-maxfiles-exceeds'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath,
          tableName: 'chunks',
          maxFiles: 5, // More than the 2 files we'll insert
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        await store.insertChunks([
          createTestChunk('File A chunk', '/test/fileA.txt', 0, createNormalizedVector(1)),
        ])
        await store.insertChunks([
          createTestChunk('File B chunk', '/test/fileB.txt', 0, createNormalizedVector(10)),
        ])

        const results = await store.search(queryVector, { queryText: '', limit: 10 })

        // All files returned since maxFiles > unique files
        expect(results).toHaveLength(2)
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })

    it('composes correctly with grouping (grouping reduces, then maxFiles further filters)', async () => {
      const dbPath = './tmp/test-vectordb-grouping-maxfiles'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath,
          tableName: 'chunks',
          grouping: 'similar', // Cuts at first boundary
          maxFiles: 1, // Then keep only 1 file
        })
        await store.initialize()

        const queryVector = createNormalizedVector(1)

        // Group 1: 2 files, both close to query (identical vectors = same group)
        await store.insertChunks([
          createTestChunk('File A in group 1', '/test/fileA.txt', 0, createNormalizedVector(1)),
        ])
        await store.insertChunks([
          createTestChunk('File B in group 1', '/test/fileB.txt', 0, createNormalizedVector(1)),
        ])

        // Group 2: far from query (creates clear boundary)
        await store.insertChunks([
          createTestChunk('File C in group 2', '/test/fileC.txt', 0, createNormalizedVector(200)),
        ])

        const results = await store.search(queryVector, { queryText: '', limit: 10 })

        // Grouping should remove File C (group 2), then maxFiles=1 keeps only 1 file from group 1
        expect(results).toHaveLength(1)
        expect(results[0]?.filePath).not.toBe('/test/fileC.txt')
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })
  })

  /**
   * Grouping Algorithm Contract:
   *
   * Given: Search results sorted by distance score (ascending)
   *
   * Algorithm:
   * 1. Calculate gaps between consecutive results
   * 2. Find "significant gaps" using threshold: mean(gaps) + 1.5 * std(gaps)
   * 3. Cut at boundaries based on mode:
   *    - 'similar': Cut at first boundary (return first group only)
   *    - 'related': Cut at second boundary (return up to 2 groups)
   *
   * Guarantees:
   * - If results <= 1: return as-is
   * - If no significant gaps: return all results
   * - 'similar' with 1+ boundaries: return first group
   * - 'related' with 1 boundary: return all results
   * - 'related' with 2+ boundaries: return first 2 groups
   */
  describe('Grouping algorithm (statistical threshold)', () => {
    describe('Contract guarantees', () => {
      it('returns single result as-is without grouping', async () => {
        const contractDbPath1 = './tmp/test-vectordb-contract-single'
        if (fs.existsSync(contractDbPath1)) {
          fs.rmSync(contractDbPath1, { recursive: true })
        }

        try {
          const store = new VectorStore({
            dbPath: contractDbPath1,
            tableName: 'chunks',
            grouping: 'similar',
          })
          await store.initialize()

          const chunk = createTestChunk(
            'Only document',
            '/test/only.txt',
            0,
            createNormalizedVector(1)
          )
          await store.insertChunks([chunk])

          const results = await store.search(createNormalizedVector(1), {
            queryText: '',
            limit: 10,
          })

          // Contract: Single result returned as-is
          expect(results).toHaveLength(1)
          expect(results[0]?.text).toBe('Only document')
        } finally {
          if (fs.existsSync(contractDbPath1)) {
            fs.rmSync(contractDbPath1, { recursive: true })
          }
        }
      })

      it('returns all results when no significant gaps exist', async () => {
        const contractDbPath2 = './tmp/test-vectordb-contract-no-gaps'
        if (fs.existsSync(contractDbPath2)) {
          fs.rmSync(contractDbPath2, { recursive: true })
        }

        try {
          const store = new VectorStore({
            dbPath: contractDbPath2,
            tableName: 'chunks',
            grouping: 'similar',
          })
          await store.initialize()

          const baseVector = createNormalizedVector(1)

          // All documents use identical vectors = all gaps are 0 = no significant gaps
          for (let i = 0; i < 4; i++) {
            const chunk = createTestChunk(`Doc ${i}`, `/test/doc${i}.txt`, 0, baseVector)
            await store.insertChunks([chunk])
          }

          const results = await store.search(baseVector, { queryText: '', limit: 10 })

          // Contract: No significant gaps → return all results
          expect(results).toHaveLength(4)
        } finally {
          if (fs.existsSync(contractDbPath2)) {
            fs.rmSync(contractDbPath2, { recursive: true })
          }
        }
      })
    })

    describe('Similar mode behavior', () => {
      it('returns first group only when clear boundary exists', async () => {
        const similarDbPath = './tmp/test-vectordb-similar-boundary'
        if (fs.existsSync(similarDbPath)) {
          fs.rmSync(similarDbPath, { recursive: true })
        }

        try {
          const store = new VectorStore({
            dbPath: similarDbPath,
            tableName: 'chunks',
            grouping: 'similar',
          })
          await store.initialize()

          const baseVector = createNormalizedVector(1)

          // Group 1: 3 documents with identical vectors (distance ~0)
          for (let i = 0; i < 3; i++) {
            const chunk = createTestChunk(`Group1 Doc ${i}`, `/test/group1-${i}.txt`, 0, baseVector)
            await store.insertChunks([chunk])
          }

          // Group 2: 2 documents with very different vectors (large gap from Group 1)
          const farVector = createNormalizedVector(100)
          for (let i = 0; i < 2; i++) {
            const chunk = createTestChunk(`Group2 Doc ${i}`, `/test/group2-${i}.txt`, 0, farVector)
            await store.insertChunks([chunk])
          }

          const results = await store.search(baseVector, { queryText: '', limit: 10 })

          // Contract: 'similar' mode cuts at first boundary
          // Only Group 1 should be returned
          expect(results).toHaveLength(3)
          expect(results.every((r) => r.text.includes('Group1'))).toBe(true)
          expect(results.some((r) => r.text.includes('Group2'))).toBe(false)
        } finally {
          if (fs.existsSync(similarDbPath)) {
            fs.rmSync(similarDbPath, { recursive: true })
          }
        }
      })
    })

    describe('Related mode behavior', () => {
      it('returns all results when only one boundary exists', async () => {
        const relatedDbPath = './tmp/test-vectordb-related-one-boundary'
        if (fs.existsSync(relatedDbPath)) {
          fs.rmSync(relatedDbPath, { recursive: true })
        }

        try {
          const store = new VectorStore({
            dbPath: relatedDbPath,
            tableName: 'chunks',
            grouping: 'related',
          })
          await store.initialize()

          const baseVector = createNormalizedVector(1)

          // Group 1: 3 documents with identical vectors
          for (let i = 0; i < 3; i++) {
            const chunk = createTestChunk(`Group1 Doc ${i}`, `/test/group1-${i}.txt`, 0, baseVector)
            await store.insertChunks([chunk])
          }

          // Group 2: 2 documents with very different vectors (creates ONE boundary)
          const farVector = createNormalizedVector(100)
          for (let i = 0; i < 2; i++) {
            const chunk = createTestChunk(`Group2 Doc ${i}`, `/test/group2-${i}.txt`, 0, farVector)
            await store.insertChunks([chunk])
          }

          const results = await store.search(baseVector, { queryText: '', limit: 10 })

          // Contract: 'related' mode with only 1 boundary → return all results
          expect(results).toHaveLength(5)
          expect(results.filter((r) => r.text.includes('Group1'))).toHaveLength(3)
          expect(results.filter((r) => r.text.includes('Group2'))).toHaveLength(2)
        } finally {
          if (fs.existsSync(relatedDbPath)) {
            fs.rmSync(relatedDbPath, { recursive: true })
          }
        }
      })
    })

    describe('Similar vs Related comparison', () => {
      it('related mode returns same or more results than similar mode with identical data', async () => {
        const similarDbPath = './tmp/test-vectordb-similar-compare'
        const relatedDbPath = './tmp/test-vectordb-related-compare'

        if (fs.existsSync(similarDbPath)) {
          fs.rmSync(similarDbPath, { recursive: true })
        }
        if (fs.existsSync(relatedDbPath)) {
          fs.rmSync(relatedDbPath, { recursive: true })
        }

        try {
          const baseVector = createNormalizedVector(1)

          // Create test data with VERY clear group structure
          // Group 1: 3 docs with identical vectors (seed 1) - gaps within group = 0
          // Group 2: 2 docs with very different vectors (seed 200) - large gap from Group 1
          // This ensures statistical threshold (mean + 1.5*std) clearly detects the boundary
          const testChunks = [
            createTestChunk('Group1 Doc 0', '/test/g1-0.txt', 0, createNormalizedVector(1)),
            createTestChunk('Group1 Doc 1', '/test/g1-1.txt', 0, createNormalizedVector(1)),
            createTestChunk('Group1 Doc 2', '/test/g1-2.txt', 0, createNormalizedVector(1)),
            createTestChunk('Group2 Doc 0', '/test/g2-0.txt', 0, createNormalizedVector(200)),
            createTestChunk('Group2 Doc 1', '/test/g2-1.txt', 0, createNormalizedVector(200)),
          ]

          // Test with similar mode
          const similarStore = new VectorStore({
            dbPath: similarDbPath,
            tableName: 'chunks',
            grouping: 'similar',
          })
          await similarStore.initialize()
          for (const chunk of testChunks) {
            await similarStore.insertChunks([chunk])
          }
          const similarResults = await similarStore.search(baseVector, { queryText: '', limit: 10 })

          // Test with related mode
          const relatedStore = new VectorStore({
            dbPath: relatedDbPath,
            tableName: 'chunks',
            grouping: 'related',
          })
          await relatedStore.initialize()
          for (const chunk of testChunks) {
            await relatedStore.insertChunks([chunk])
          }
          const relatedResults = await relatedStore.search(baseVector, { queryText: '', limit: 10 })

          // Contract: 'similar' cuts at first boundary, 'related' at second (or returns all if only 1)
          // Therefore: relatedResults.length >= similarResults.length
          expect(relatedResults.length).toBeGreaterThanOrEqual(similarResults.length)

          // Verify both modes return at least 1 result
          expect(similarResults.length).toBeGreaterThanOrEqual(1)
          expect(relatedResults.length).toBeGreaterThanOrEqual(1)

          // Verify Group1 is always prioritized (appears first in both modes)
          const similarGroup1Count = similarResults.filter((r) => r.text.includes('Group1')).length
          const relatedGroup1Count = relatedResults.filter((r) => r.text.includes('Group1')).length

          // Both modes should include all Group1 results at minimum
          expect(similarGroup1Count).toBeGreaterThanOrEqual(1)
          expect(relatedGroup1Count).toBeGreaterThanOrEqual(similarGroup1Count)
        } finally {
          if (fs.existsSync(similarDbPath)) {
            fs.rmSync(similarDbPath, { recursive: true })
          }
          if (fs.existsSync(relatedDbPath)) {
            fs.rmSync(relatedDbPath, { recursive: true })
          }
        }
      })
    })
  })

  describe('fileTitle support', () => {
    describe('toSearchResult fileTitle handling', () => {
      it('should include fileTitle when present in raw result', () => {
        const raw = {
          filePath: '/test/doc.md',
          chunkIndex: 0,
          text: 'Test content',
          metadata: { fileName: 'doc.md', fileSize: 100, fileType: 'md' },
          _distance: 0.5,
          fileTitle: 'My Document',
        }

        const result = toSearchResult(raw)
        expect(result.fileTitle).toBe('My Document')
      })

      it('should default fileTitle to null when not present in raw result', () => {
        const raw = {
          filePath: '/test/doc.md',
          chunkIndex: 0,
          text: 'Test content',
          metadata: { fileName: 'doc.md', fileSize: 100, fileType: 'md' },
          _distance: 0.5,
        }

        const result = toSearchResult(raw)
        expect(result.fileTitle).toBe(null)
      })
    })

    describe('isLanceDBRawResult backward compatibility', () => {
      it('should accept results without fileTitle (regression guard)', () => {
        const rawWithoutTitle = {
          filePath: '/test/doc.md',
          chunkIndex: 0,
          text: 'Test content',
          metadata: { fileName: 'doc.md', fileSize: 100, fileType: 'md' },
          _distance: 0.5,
        }

        expect(isLanceDBRawResult(rawWithoutTitle)).toBe(true)
      })

      it('should accept results with fileTitle', () => {
        const rawWithTitle = {
          filePath: '/test/doc.md',
          chunkIndex: 0,
          text: 'Test content',
          metadata: { fileName: 'doc.md', fileSize: 100, fileType: 'md' },
          _distance: 0.5,
          fileTitle: 'My Document',
        }

        expect(isLanceDBRawResult(rawWithTitle)).toBe(true)
      })
    })

    describe('Schema migration (ensureSchemaVersion)', () => {
      it('should add fileTitle column when missing from existing table', async () => {
        const dbPath = './tmp/test-vectordb-schema-migration'
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }

        try {
          // Step 1: Create a LanceDB table WITHOUT fileTitle column
          // (simulates a database created before the fileTitle feature)
          const { connect: lanceConnect } = await import('@lancedb/lancedb')
          const db = await lanceConnect(dbPath)
          const oldRecord = {
            id: randomUUID(),
            filePath: '/test/old-doc.txt',
            chunkIndex: 0,
            text: 'Old document without fileTitle',
            vector: createNormalizedVector(1),
            metadata: {
              fileName: 'old-doc.txt',
              fileSize: 100,
              fileType: 'txt',
            },
            timestamp: new Date().toISOString(),
            // NOTE: No fileTitle field -- simulates pre-migration schema
          }
          await db.createTable('chunks', [oldRecord])

          // Step 2: Create a VectorStore that will run migration on initialize()
          const newStore = new VectorStore({
            dbPath,
            tableName: 'chunks',
          })
          await newStore.initialize()

          // Step 3: Insert a new chunk WITH fileTitle -- should succeed after migration
          const newChunk: VectorChunk = {
            id: randomUUID(),
            filePath: '/test/new-doc.txt',
            chunkIndex: 0,
            text: 'New document with fileTitle',
            vector: createNormalizedVector(2),
            metadata: {
              fileName: 'new-doc.txt',
              fileSize: 100,
              fileType: 'txt',
            },
            fileTitle: 'New Document Title',
            timestamp: new Date().toISOString(),
          }
          await newStore.insertChunks([newChunk])

          // Step 4: Verify search returns results with fileTitle field
          const results = await newStore.search(createNormalizedVector(2), {
            queryText: '',
            limit: 10,
          })
          expect(results.length).toBeGreaterThanOrEqual(1)

          // The new document should have fileTitle
          const newDocResult = results.find((r) => r.filePath === '/test/new-doc.txt')
          expect(newDocResult).toBeDefined()
          expect(newDocResult!.fileTitle).toBe('New Document Title')

          // The old document should have fileTitle = null (migrated default)
          const oldDocResult = results.find((r) => r.filePath === '/test/old-doc.txt')
          expect(oldDocResult).toBeDefined()
          expect(oldDocResult!.fileTitle).toBe(null)
        } finally {
          if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { recursive: true })
          }
        }
      })

      it('should be idempotent (running migration twice does nothing on second call)', async () => {
        const dbPath = './tmp/test-vectordb-schema-idempotent'
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }

        try {
          // First initialization with data
          const store1 = new VectorStore({
            dbPath,
            tableName: 'chunks',
          })
          await store1.initialize()

          const chunk = createTestChunk(
            'Test document',
            '/test/doc.txt',
            0,
            createNormalizedVector(1)
          )
          await store1.insertChunks([chunk])

          // Second initialization (should not throw)
          const store2 = new VectorStore({
            dbPath,
            tableName: 'chunks',
          })
          await store2.initialize()

          // Third initialization (should still not throw)
          const store3 = new VectorStore({
            dbPath,
            tableName: 'chunks',
          })
          await store3.initialize()

          // Search should still work
          const results = await store3.search(createNormalizedVector(1), {
            queryText: '',
            limit: 10,
          })
          expect(results).toHaveLength(1)
          expect(results[0]?.filePath).toBe('/test/doc.txt')
        } finally {
          if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { recursive: true })
          }
        }
      })
    })
  })

  /**
   * contentHash — SHA-256 of the source file bytes, the storage half of sync
   * content identity. Covers a freshly created schema, a schema migrated from a
   * table that predates the column, '' → absent read normalization, and the
   * hashless / conflicting per-file states a later sync step classifies as dirty.
   */
  describe('contentHash support', () => {
    // Literal SHA-256 hex digests, independent of any production hashing code.
    const HASH_ONE = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    const HASH_TWO = '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752'

    /** Read the persisted Arrow schema through a separate read-only connection. */
    async function schemaFieldNames(dbPath: string): Promise<string[]> {
      const { connect: lanceConnect } = await import('@lancedb/lancedb')
      const db = await lanceConnect(dbPath)
      const table = await db.openTable('chunks')
      const schema = await table.schema()
      const names = schema.fields.map((field: { name: string }) => field.name)
      await db.close()
      return names
    }

    const byChunkIndex = (chunks: VectorChunk[]): VectorChunk[] =>
      [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)

    it('should expose a contentHash column and round-trip a hex digest on a freshly created table', async () => {
      await withTempDb('content-hash-fresh', async (store, dbPath) => {
        const filePath = '/test/hashed.md'
        await store.insertChunks([
          {
            ...createTestChunk('body', filePath, 0, createNormalizedVector(1)),
            contentHash: HASH_ONE,
          },
        ])

        expect(await schemaFieldNames(dbPath)).toContain('contentHash')

        const stored = await store.getChunksByFilePath(filePath)
        expect(stored).toHaveLength(1)
        expect(stored[0]?.contentHash).toBe(HASH_ONE)
      })
    })

    it('should read back an omitted contentHash as absent so the create-path seed never leaks a fake hash', async () => {
      await withTempDb('content-hash-absent', async (store) => {
        const filePath = '/test/unhashed.md'
        await store.insertChunks([createTestChunk('body', filePath, 0, createNormalizedVector(1))])

        const stored = await store.getChunksByFilePath(filePath)
        expect(stored).toHaveLength(1)
        expect(stored[0]).not.toHaveProperty('contentHash')
      })
    })

    it('should accept a chunk with no contentHash through the existing-table add branch', async () => {
      await withTempDb('content-hash-add-branch', async (store) => {
        // First insert creates the table; the second goes through table.add,
        // which passes records straight to LanceDB without the create-path seed.
        await store.insertChunks([
          {
            ...createTestChunk('body', '/test/first.md', 0, createNormalizedVector(1)),
            contentHash: HASH_ONE,
          },
        ])
        await store.insertChunks([
          createTestChunk('body', '/test/second.md', 0, createNormalizedVector(2)),
        ])

        const stored = await store.getChunksByFilePath('/test/second.md')
        expect(stored).toHaveLength(1)
        expect(stored[0]).not.toHaveProperty('contentHash')
      })
    })

    it('should normalize a stored empty-string contentHash to absent on read', async () => {
      await withTempDb('content-hash-empty-string', async (store) => {
        const filePath = '/test/empty-hash.md'
        await store.insertChunks([
          { ...createTestChunk('body', filePath, 0, createNormalizedVector(1)), contentHash: '' },
        ])

        const stored = await store.getChunksByFilePath(filePath)
        expect(stored).toHaveLength(1)
        expect(stored[0]).not.toHaveProperty('contentHash')
      })
    })

    it('should add the contentHash column to a table created before the column existed', async () => {
      const dbPath = './tmp/test-vectordb-content-hash-migration'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const { connect: lanceConnect } = await import('@lancedb/lancedb')
        const legacyDb = await lanceConnect(dbPath)
        await legacyDb.createTable('chunks', [
          {
            id: randomUUID(),
            filePath: '/test/legacy.md',
            chunkIndex: 0,
            text: 'Row stored before contentHash existed',
            vector: createNormalizedVector(1),
            metadata: { fileName: 'legacy.md', fileSize: 100, fileType: 'md' },
            fileTitle: 'Legacy Document',
            timestamp: new Date().toISOString(),
            // NOTE: no contentHash field -- simulates the pre-migration schema
          },
        ])
        await legacyDb.close()

        const store = new VectorStore({ dbPath, tableName: 'chunks' })
        await store.initialize()

        expect(await schemaFieldNames(dbPath)).toContain('contentHash')

        const legacyRows = await store.getChunksByFilePath('/test/legacy.md')
        expect(legacyRows).toHaveLength(1)
        expect(legacyRows[0]).not.toHaveProperty('contentHash')

        // The migrated table must still accept a hashed insert (table.add branch)
        await store.insertChunks([
          {
            ...createTestChunk('new body', '/test/migrated.md', 0, createNormalizedVector(2)),
            contentHash: HASH_ONE,
          },
        ])
        const migratedRows = await store.getChunksByFilePath('/test/migrated.md')
        expect(migratedRows).toHaveLength(1)
        expect(migratedRows[0]?.contentHash).toBe(HASH_ONE)
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })

    it('should keep the contentHash migration idempotent across repeated initialize calls', async () => {
      const dbPath = './tmp/test-vectordb-content-hash-idempotent'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const first = new VectorStore({ dbPath, tableName: 'chunks' })
        await first.initialize()
        await first.insertChunks([
          {
            ...createTestChunk('body', '/test/idempotent.md', 0, createNormalizedVector(1)),
            contentHash: HASH_ONE,
          },
        ])

        const second = new VectorStore({ dbPath, tableName: 'chunks' })
        await second.initialize()
        const third = new VectorStore({ dbPath, tableName: 'chunks' })
        await third.initialize()

        const names = await schemaFieldNames(dbPath)
        expect(names.filter((name) => name === 'contentHash')).toHaveLength(1)

        const rows = await third.getChunksByFilePath('/test/idempotent.md')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.contentHash).toBe(HASH_ONE)
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
    })

    it('should store every chunk of one file without a hash (hashless file)', async () => {
      await withTempDb('content-hash-hashless', async (store) => {
        const filePath = '/test/hashless.md'
        await store.insertChunks([
          createTestChunk('one', filePath, 0, createNormalizedVector(1)),
          createTestChunk('two', filePath, 1, createNormalizedVector(2)),
          createTestChunk('three', filePath, 2, createNormalizedVector(3)),
        ])

        const rows = byChunkIndex(await store.getChunksByFilePath(filePath))
        expect(rows.map((row) => row.chunkIndex)).toEqual([0, 1, 2])
        expect(rows.map((row) => row.contentHash)).toEqual([undefined, undefined, undefined])
      })
    })

    it('should store different and missing per-chunk hashes for one file (conflicting hashes)', async () => {
      await withTempDb('content-hash-conflicting', async (store) => {
        const filePath = '/test/conflicting.md'
        await store.insertChunks([
          {
            ...createTestChunk('one', filePath, 0, createNormalizedVector(1)),
            contentHash: HASH_ONE,
          },
          {
            ...createTestChunk('two', filePath, 1, createNormalizedVector(2)),
            contentHash: HASH_TWO,
          },
          createTestChunk('three', filePath, 2, createNormalizedVector(3)),
        ])

        const rows = byChunkIndex(await store.getChunksByFilePath(filePath))
        expect(rows.map((row) => row.contentHash)).toEqual([HASH_ONE, HASH_TWO, undefined])
      })
    })

    /**
     * `listChunkHashes` is the DB-manifest projection sync reconciles against.
     * It must preserve verbatim stored spellings (they are the deletion keys),
     * emit one entry per chunk row (so a conflicting-hash file is detectable),
     * and report a hashless row as `null` rather than the create-path `''` seed.
     */
    describe('listChunkHashes projection', () => {
      // Row order is not a storage contract, so compare as a code-point-sorted
      // list (hashless entries first) rather than asserting insertion order.
      const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
      const sortEntries = <T extends { filePath: string; contentHash: string | null }>(
        entries: T[]
      ): T[] =>
        [...entries].sort(
          (a, b) =>
            compare(a.filePath, b.filePath) || compare(a.contentHash ?? '', b.contentHash ?? '')
        )

      it('returns one verbatim-spelled entry per chunk row', async () => {
        await withTempDb('list-chunk-hashes-per-row', async (store) => {
          await store.insertChunks([
            {
              ...createTestChunk('one', '/test/a.md', 0, createNormalizedVector(1)),
              contentHash: HASH_ONE,
            },
            {
              ...createTestChunk('two', '/test/a.md', 1, createNormalizedVector(2)),
              contentHash: HASH_ONE,
            },
            {
              ...createTestChunk('three', '/test/B.md', 0, createNormalizedVector(3)),
              contentHash: HASH_TWO,
            },
          ])

          expect(sortEntries(await store.listChunkHashes())).toEqual([
            { filePath: '/test/B.md', contentHash: HASH_TWO },
            { filePath: '/test/a.md', contentHash: HASH_ONE },
            { filePath: '/test/a.md', contentHash: HASH_ONE },
          ])
        })
      })

      it('reports a hashless row as null so it is never read as a real hash', async () => {
        await withTempDb('list-chunk-hashes-hashless', async (store) => {
          await store.insertChunks([
            {
              ...createTestChunk('hashed', '/test/hashed.md', 0, createNormalizedVector(1)),
              contentHash: HASH_ONE,
            },
            createTestChunk('hashless', '/test/hashless.md', 0, createNormalizedVector(2)),
          ])

          expect(sortEntries(await store.listChunkHashes())).toEqual([
            { filePath: '/test/hashed.md', contentHash: HASH_ONE },
            { filePath: '/test/hashless.md', contentHash: null },
          ])
        })
      })

      it('exposes per-chunk hash disagreement for one file', async () => {
        await withTempDb('list-chunk-hashes-conflicting', async (store) => {
          const filePath = '/test/conflicting.md'
          await store.insertChunks([
            {
              ...createTestChunk('one', filePath, 0, createNormalizedVector(1)),
              contentHash: HASH_ONE,
            },
            {
              ...createTestChunk('two', filePath, 1, createNormalizedVector(2)),
              contentHash: HASH_TWO,
            },
            createTestChunk('three', filePath, 2, createNormalizedVector(3)),
          ])

          expect(sortEntries(await store.listChunkHashes())).toEqual([
            { filePath, contentHash: null },
            { filePath, contentHash: HASH_TWO },
            { filePath, contentHash: HASH_ONE },
          ])
        })
      })

      it('returns an empty manifest when the backing table does not exist yet', async () => {
        await withTempDb('list-chunk-hashes-lazy', async (store) => {
          expect(await store.listChunkHashes()).toEqual([])
        })
      })
    })
  })

  /**
   * contentHash production — the ingestion half of sync content identity.
   *
   * Storage (above) proves the column round-trips. These tests prove the value
   * actually written by filesystem ingestion: one shared SHA-256 of the raw
   * file bytes on every chunk of a file, and vector construction completing
   * before the destructive delete so a construction failure cannot empty a
   * file's rows.
   *
   * The embedder/chunker/parser are deterministic stubs (external ML I/O is
   * slow and non-deterministic); the store is real because value round-tripping
   * is the subject.
   */
  describe('contentHash production during ingestion', () => {
    // SHA-256 of the 5 bytes "hello" (`printf 'hello' | shasum -a 256`), an
    // oracle independent of computeContentHash, so a drift in the digest, the
    // encoding, or the hashed input fails here.
    const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

    const byChunkIndex = (chunks: VectorChunk[]): VectorChunk[] =>
      [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)

    const textChunks = (count: number): TextChunk[] =>
      Array.from({ length: count }, (_, index) => ({ text: `chunk ${index}`, index }))

    /**
     * Stubs for `ingestSingleFile`'s injected collaborators. `parsedText` is
     * deliberately unrelated to the bytes on disk: the hash must come from the
     * file, not from the parser output. `embeddingCount` below the chunk count
     * reproduces the missing-embedding construction failure.
     */
    function ingestCollaborators(options: {
      parsedText: string
      chunkCount: number
      embeddingCount?: number
    }) {
      const chunks = textChunks(options.chunkCount)
      const embeddings = Array.from(
        { length: options.embeddingCount ?? options.chunkCount },
        (_, i) => createNormalizedVector(i + 1)
      )
      return {
        parser: {
          parseFile: async () => ({ content: options.parsedText, title: 'Stub Title' }),
        } as unknown as Parameters<typeof ingestSingleFile>[1],
        chunker: {
          chunkText: async () => chunks,
        } as unknown as Parameters<typeof ingestSingleFile>[2],
        embedder: {
          embedBatch: async () => embeddings,
        } as unknown as Parameters<typeof ingestSingleFile>[3],
      }
    }

    /** Write `content` to a fresh temp file and return its absolute path. */
    function writeSourceFile(name: string, content: string): string {
      const dir = path.resolve('./tmp/test-ingest-hash')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, name)
      fs.writeFileSync(filePath, content)
      return filePath
    }

    afterEach(() => {
      const dir = path.resolve('./tmp/test-ingest-hash')
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true })
      }
    })

    it('should compute the lowercase SHA-256 hex of the given bytes', () => {
      expect(computeContentHash(Buffer.from('hello', 'utf-8'))).toBe(HELLO_SHA256)
    })

    it('should set the same contentHash on every chunk it builds', () => {
      const built = buildVectorChunks({
        filePath: '/test/shared-hash.md',
        chunks: textChunks(3),
        embeddings: [
          createNormalizedVector(1),
          createNormalizedVector(2),
          createNormalizedVector(3),
        ],
        fileSize: 42,
        fileTitle: null,
        contentHash: HELLO_SHA256,
      })

      expect(built).toHaveLength(3)
      expect(built.map((chunk) => chunk.contentHash)).toEqual([
        HELLO_SHA256,
        HELLO_SHA256,
        HELLO_SHA256,
      ])
    })

    it('should omit contentHash on every chunk when no source hash is available', () => {
      const built = buildVectorChunks({
        filePath: '/test/hashless.md',
        chunks: textChunks(2),
        embeddings: [createNormalizedVector(1), createNormalizedVector(2)],
        fileSize: 42,
        fileTitle: null,
        contentHash: null,
      })

      expect(built).toHaveLength(2)
      for (const chunk of built) {
        expect(chunk).not.toHaveProperty('contentHash')
      }
    })

    it('should store one identical hash of the file bytes on every chunk of an ingested file', async () => {
      await withTempDb('ingest-content-hash', async (store) => {
        const filePath = writeSourceFile('hello.md', 'hello')
        const { parser, chunker, embedder } = ingestCollaborators({
          parsedText: 'parsed text that is deliberately not the file bytes',
          chunkCount: 3,
        })

        const inserted = await ingestSingleFile(filePath, parser, chunker, embedder, store)
        expect(inserted).toBe(3)

        const rows = byChunkIndex(await store.getChunksByFilePath(filePath))
        expect(rows.map((row) => row.chunkIndex)).toEqual([0, 1, 2])
        expect(rows.map((row) => row.contentHash)).toEqual([
          HELLO_SHA256,
          HELLO_SHA256,
          HELLO_SHA256,
        ])
        expect(new Set(rows.map((row) => row.contentHash)).size).toBe(1)
      })
    })

    it('should keep previously stored rows when vector construction fails during re-ingest', async () => {
      await withTempDb('ingest-construct-before-delete', async (store) => {
        const filePath = writeSourceFile('kept.md', 'hello')
        await store.insertChunks([
          createTestChunk('stored one', filePath, 0, createNormalizedVector(1)),
          createTestChunk('stored two', filePath, 1, createNormalizedVector(2)),
        ])

        // One embedding short of the chunk count: buildVectorChunks throws.
        const { parser, chunker, embedder } = ingestCollaborators({
          parsedText: 'replacement text',
          chunkCount: 2,
          embeddingCount: 1,
        })

        await expect(ingestSingleFile(filePath, parser, chunker, embedder, store)).rejects.toThrow(
          'Missing embedding for chunk 1'
        )

        const rows = byChunkIndex(await store.getChunksByFilePath(filePath))
        expect(rows.map((row) => row.text)).toEqual(['stored one', 'stored two'])
      })
    })
  })

  /**
   * VectorStore.getChunksByRange — range-read primitive for read_chunk_neighbors.
   *
   * This describe block is the PROBE GATE for LanceDB numeric-predicate
   * viability (chunkIndex >= N AND chunkIndex <= M). The first test is
   * the Design Doc Early Verification Point. If it fails with a LanceDB
   * SQL error, switch the primitive in src/vectordb/index.ts to the
   * documented fallback (fetch-all + in-memory filter) and update the
   * Design Doc Limitation note with the observed error text.
   */
  describe('getChunksByRange', () => {
    it('should return chunks in range [2, 5] in order when seeding 10 contiguous chunks (Early Verification Point)', async () => {
      await withTempDb('range-probe', async (store) => {
        const filePath = '/test/contiguous.md'

        // Seed 10 contiguous chunks with chunkIndex 0..9 in ascending insertion order
        const chunks: VectorChunk[] = []
        for (let i = 0; i < 10; i++) {
          chunks.push(
            createTestChunk(`Chunk ${i} body`, filePath, i, createNormalizedVector(i + 1))
          )
        }
        await store.insertChunks(chunks)

        const result = await store.getChunksByRange(filePath, 2, 5)

        // Success criteria (Design Doc §Early Verification Point):
        expect(result).toHaveLength(4)
        expect(result.map((row) => row.chunkIndex)).toEqual([2, 3, 4, 5])
        expect(result.every((row) => row.filePath === filePath)).toBe(true)

        // ChunkRow shape: no score, no metadata keys present on any row
        for (const row of result) {
          expect(row).not.toHaveProperty('score')
          expect(row).not.toHaveProperty('metadata')
          expect(Object.keys(row).sort()).toEqual(['chunkIndex', 'filePath', 'fileTitle', 'text'])
        }
      })
    })

    it('should sort ascending even when chunks are inserted in descending order (AC-018 contract)', async () => {
      await withTempDb('range-sort', async (store) => {
        const filePath = '/test/descending.md'

        // Insert chunks with chunkIndex 9,8,7,6,5,4,3,2,1,0 in that order
        // (not ascending) so that ascending sort is a contract, not coincidence.
        const insertionOrder = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
        for (const idx of insertionOrder) {
          await store.insertChunks([
            createTestChunk(`Chunk ${idx}`, filePath, idx, createNormalizedVector(idx + 1)),
          ])
        }

        const result = await store.getChunksByRange(filePath, 0, 9)

        expect(result).toHaveLength(10)
        expect(result.map((row) => row.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      })
    })

    it('should return empty array when backing table has not been initialized (lazy-table)', async () => {
      await withTempDb('range-lazy-table', async (store) => {
        // Do not insert anything; this leaves the table null
        // (createTable is deferred to first insertChunks call, per index.ts).
        const result = await store.getChunksByRange('/any/path.md', 0, 10)

        expect(result).toEqual([])
      })
    })

    it('should throw DatabaseError with "Failed to read chunks by range" on simulated LanceDB failure', async () => {
      await withTempDb('range-db-error', async (store) => {
        // Seed a single chunk so the table is created
        await store.insertChunks([
          createTestChunk('seed', '/test/error-probe.md', 0, createNormalizedVector(1)),
        ])

        // Deliberate fault injection. The ASSERTED behavior is the public
        // getChunksByRange rejection (observable): a LanceDB query failure must
        // be wrapped as DatabaseError('Failed to read chunks by range'). There
        // is no public seam to induce a LanceDB query failure, so replacing the
        // private `table` handle with a stub whose query() throws is the
        // pragmatic mechanism to exercise that wrapping. The coupling to the
        // private field is intentional, not an oversight; do not rewrite to an
        // external mock.
        const brokenTable = {
          query: () => {
            throw new Error('simulated LanceDB failure')
          },
        }
        ;(store as unknown as { table: typeof brokenTable }).table = brokenTable

        await expect(store.getChunksByRange('/test/error-probe.md', 0, 5)).rejects.toThrow(
          DatabaseError
        )
        await expect(store.getChunksByRange('/test/error-probe.md', 0, 5)).rejects.toThrow(
          /Failed to read chunks by range/
        )
      })
    })

    it('should throw DatabaseError when minIdx is NaN or a float (precondition guard)', async () => {
      await withTempDb('range-precondition', async (store) => {
        // Seed a single chunk so the table is created
        await store.insertChunks([
          createTestChunk('seed', '/test/precondition.md', 0, createNormalizedVector(1)),
        ])

        // NaN minIdx
        await expect(
          store.getChunksByRange('/test/precondition.md', Number.NaN, 5)
        ).rejects.toThrow(DatabaseError)
        await expect(
          store.getChunksByRange('/test/precondition.md', Number.NaN, 5)
        ).rejects.toThrow(/non-negative integer range bounds/)

        // Float minIdx
        await expect(store.getChunksByRange('/test/precondition.md', 1.5, 5)).rejects.toThrow(
          DatabaseError
        )

        // maxIdx < minIdx
        await expect(store.getChunksByRange('/test/precondition.md', 5, 2)).rejects.toThrow(
          DatabaseError
        )
      })
    })

    it('should normalize empty-string fileTitle to null and omit score/metadata keys (ChunkRow shape)', async () => {
      await withTempDb('range-chunkrow-shape', async (store) => {
        const filePath = '/test/shape.md'

        // Seed a chunk where fileTitle is empty string (insertChunks stores ''
        // verbatim when provided; toChunkRow normalizes '' → null on read).
        const chunk: VectorChunk = {
          ...createTestChunk('Body text', filePath, 0, createNormalizedVector(1)),
          fileTitle: '',
        }
        await store.insertChunks([chunk])

        const result: ChunkRow[] = await store.getChunksByRange(filePath, 0, 0)

        expect(result).toHaveLength(1)
        const row = result[0]
        expect(row).toBeDefined()
        expect(row!.fileTitle).toBeNull()
        expect(row).not.toHaveProperty('score')
        expect(row).not.toHaveProperty('metadata')
        // The only keys on a ChunkRow are the four Design Doc fields
        expect(Object.keys(row!).sort()).toEqual(['chunkIndex', 'filePath', 'fileTitle', 'text'])
      })
    })
  })

  describe('close', () => {
    it('is idempotent and resets status to defaults', async () => {
      await withTempDb('close-idempotent', async (store) => {
        // Seed data so the table exists and status reflects real counts.
        await store.insertChunks([
          createTestChunk('body', '/test/close.txt', 0, createNormalizedVector(1)),
        ])

        // First close releases the connection.
        await store.close()

        // Second close must be a no-op, not throw.
        await expect(store.close()).resolves.toBeUndefined()

        // After close the table handle is gone, so getStatus returns the
        // empty/default status without touching the database.
        const status = await store.getStatus()
        expect(status.documentCount).toBe(0)
        expect(status.chunkCount).toBe(0)
        expect(status.ftsIndexEnabled).toBe(false)
      })
    })
  })

  describe('listFiles / getStatus aggregation', () => {
    it('aggregates per-file chunkCount and most-recent timestamp across files', async () => {
      await withTempDb('aggregation', async (store) => {
        // File A: 2 chunks with differing timestamps; the later one must win.
        const earlier = '2020-01-01T00:00:00.000Z'
        const later = '2024-06-01T12:00:00.000Z'
        const fileAChunk0: VectorChunk = {
          ...createTestChunk('A chunk 0', '/test/fileA.txt', 0, createNormalizedVector(1)),
          timestamp: earlier,
        }
        const fileAChunk1: VectorChunk = {
          ...createTestChunk('A chunk 1', '/test/fileA.txt', 1, createNormalizedVector(2)),
          timestamp: later,
        }
        // File B: single chunk.
        const fileBChunk0: VectorChunk = {
          ...createTestChunk('B chunk 0', '/test/fileB.txt', 0, createNormalizedVector(3)),
          timestamp: '2022-03-03T03:03:03.000Z',
        }

        await store.insertChunks([fileAChunk0, fileAChunk1, fileBChunk0])

        const files = await store.listFiles()
        expect(files).toHaveLength(2)

        const fileA = files.find((f) => f.filePath === '/test/fileA.txt')
        expect(fileA).toBeDefined()
        expect(fileA!.chunkCount).toBe(2)
        // Most recent timestamp across File A's chunks.
        expect(fileA!.timestamp).toBe(later)

        const fileB = files.find((f) => f.filePath === '/test/fileB.txt')
        expect(fileB).toBeDefined()
        expect(fileB!.chunkCount).toBe(1)

        const status = await store.getStatus()
        expect(status.documentCount).toBe(2)
        expect(status.chunkCount).toBe(3)
      })
    })
  })

  /**
   * search({ scope }) — scope prefix prefilter applied as a .where() on
   * vectorSearch. Real-LanceDB integration (mocks cannot verify query/filter
   * correctness). Discharges proof obligations AC3/AC5 (boundary-safe
   * exact-or-descendant), AC6 (escaping), AC9 (separator from prefix).
   *
   * Helper: seed a corpus, search with scope, collect the distinct in-scope
   * filePaths. A fixed all-ones vector against fixed normalized seeds returns
   * every chunk as a candidate (limit*2), so the scope .where() prefilter is
   * the only thing that restricts the result set.
   */
  describe('search scope prefilter', () => {
    /** Collect the distinct filePaths returned by a scoped search. */
    async function scopedFilePaths(store: VectorStore, scope: string[]): Promise<string[]> {
      const results = await store.search(createNormalizedVector(1), { scope, limit: 20 })
      return [...new Set(results.map((r) => r.filePath))].sort()
    }

    it('restricts results to descendants of a directory prefix and excludes the boundary sibling', async () => {
      await withTempDb('scope-boundary', async (store) => {
        await store.insertChunks([
          createTestChunk('inside one', '/a/b/x.md', 0, createNormalizedVector(1)),
          createTestChunk('inside two', '/a/b/sub/y.md', 0, createNormalizedVector(2)),
          createTestChunk('boundary sibling', '/a/bc.md', 0, createNormalizedVector(3)),
          createTestChunk('other corpus', '/foo/bar.md', 0, createNormalizedVector(4)),
        ])

        const paths = await scopedFilePaths(store, ['/a/b'])

        // /a/b matches descendants but NOT /a/bc.md (boundary) or /foo/bar.md.
        expect(paths).toEqual(['/a/b/sub/y.md', '/a/b/x.md'])
      })
    })

    it('matches an exact file scope to that file only (exact-or-descendant)', async () => {
      await withTempDb('scope-exact-file', async (store) => {
        await store.insertChunks([
          createTestChunk('the file', '/foo/bar.md', 0, createNormalizedVector(1)),
          createTestChunk(
            'descendant-looking sibling',
            '/foo/bar.md.bak',
            0,
            createNormalizedVector(2)
          ),
          createTestChunk('other', '/foo/baz.md', 0, createNormalizedVector(3)),
        ])

        const paths = await scopedFilePaths(store, ['/foo/bar.md'])

        // Exact file scope matches the file itself; /foo/bar.md.bak is NOT a
        // descendant (no separator boundary) and must be excluded.
        expect(paths).toEqual(['/foo/bar.md'])
      })
    })

    it('treats /a/b, /a/b/ and /a/b// as equivalent (trailing-separator normalization)', async () => {
      await withTempDb('scope-normalize', async (store) => {
        await store.insertChunks([
          createTestChunk('inside', '/a/b/x.md', 0, createNormalizedVector(1)),
          createTestChunk('exact dir', '/a/b', 0, createNormalizedVector(2)),
          createTestChunk('boundary', '/a/bc.md', 0, createNormalizedVector(3)),
        ])

        const plain = await scopedFilePaths(store, ['/a/b'])
        const oneSlash = await scopedFilePaths(store, ['/a/b/'])
        const twoSlash = await scopedFilePaths(store, ['/a/b//'])

        expect(plain).toEqual(['/a/b', '/a/b/x.md'])
        expect(oneSlash).toEqual(plain)
        expect(twoSlash).toEqual(plain)
      })
    })

    it('matches everything under a root scope without doubling the separator', async () => {
      await withTempDb('scope-root', async (store) => {
        await store.insertChunks([
          createTestChunk('top-level', '/a.md', 0, createNormalizedVector(1)),
          createTestChunk('nested', '/deep/nested.md', 0, createNormalizedVector(2)),
        ])

        // Root scope '/' must become LIKE '/%' (not '//%'), matching every
        // posix path; the root itself is not normalized away to empty.
        const paths = await scopedFilePaths(store, ['/'])

        expect(paths).toEqual(['/a.md', '/deep/nested.md'])
      })
    })

    it('unions results across multiple prefixes', async () => {
      await withTempDb('scope-multi', async (store) => {
        await store.insertChunks([
          createTestChunk('corpus a', '/a/x.md', 0, createNormalizedVector(1)),
          createTestChunk('corpus b', '/b/y.md', 0, createNormalizedVector(2)),
          createTestChunk('corpus c', '/c/z.md', 0, createNormalizedVector(3)),
        ])

        const paths = await scopedFilePaths(store, ['/a', '/b'])

        // Union across prefixes: /a and /b in, /c out.
        expect(paths).toEqual(['/a/x.md', '/b/y.md'])
      })
    })

    it('derives the boundary separator from a backslash-style prefix', async () => {
      await withTempDb('scope-backslash', async (store) => {
        await store.insertChunks([
          createTestChunk('win inside', 'C:\\docs\\a.md', 0, createNormalizedVector(1)),
          createTestChunk('win boundary', 'C:\\docsX\\b.md', 0, createNormalizedVector(2)),
        ])

        // Prefix contains '\' so the boundary separator is '\', not path.sep.
        // 'C:\\docs' matches 'C:\\docs\\a.md' but not 'C:\\docsX\\b.md'.
        const paths = await scopedFilePaths(store, ['C:\\docs'])

        expect(paths).toEqual(['C:\\docs\\a.md'])
      })
    })

    it('treats backslash as a legal character inside a slash-style scope', async () => {
      await withTempDb('scope-posix-backslash-name', async (store) => {
        await store.insertChunks([
          createTestChunk('inside', '/docs/a\\b/in.md', 0, createNormalizedVector(1)),
          createTestChunk('boundary', '/docs/a\\bc/out.md', 0, createNormalizedVector(2)),
        ])

        const paths = await scopedFilePaths(store, ['/docs/a\\b'])
        expect(paths).toEqual(['/docs/a\\b/in.md'])
      })
    })

    it('matches everything under a backslash root scope (C:\\) without doubling', async () => {
      await withTempDb('scope-backslash-root', async (store) => {
        await store.insertChunks([
          createTestChunk('win doc', 'C:\\docs\\a.md', 0, createNormalizedVector(1)),
          createTestChunk('win other', 'C:\\other\\b.md', 0, createNormalizedVector(2)),
        ])

        // 'C:\\' is a root: LIKE 'C:\\%' (escaped backslash), matching all.
        const paths = await scopedFilePaths(store, ['C:\\'])

        expect(paths).toEqual(['C:\\docs\\a.md', 'C:\\other\\b.md'])
      })
    })

    it('neutralizes an injection prefix containing quote/%/_ (LIKE metacharacters)', async () => {
      await withTempDb('scope-injection', async (store) => {
        // A posix directory whose name contains a single quote and the LIKE
        // wildcards % and _. The descendant child must match literally; %/_
        // must NOT behave as wildcards and the quote must not break the
        // predicate. (Backslash escaping is covered by the backslash-prefix
        // tests; mixing separator styles in one prefix is outside the caller
        // contract, which is single-separator-style per host OS.)
        const trickyDir = "/danger/o'_%dir"
        await store.insertChunks([
          createTestChunk('inside tricky', `${trickyDir}/child.md`, 0, createNormalizedVector(1)),
          // Decoy: if % and _ matched as wildcards, 'oX_Ydir' / 'oA_BCdir' would
          // be caught by the unescaped pattern. They must be excluded.
          createTestChunk(
            'wildcard decoy',
            '/danger/oXY_ZZZdir/child.md',
            0,
            createNormalizedVector(2)
          ),
          createTestChunk('unrelated', '/safe/file.md', 0, createNormalizedVector(3)),
        ])

        const paths = await scopedFilePaths(store, [trickyDir])

        // Only the literal descendant; the decoy (where % / _ would have matched
        // as wildcards) must be excluded, proving the chars are escaped.
        expect(paths).toEqual([`${trickyDir}/child.md`])
      })
    })

    it('leaves results unchanged when scope is absent (backward compatible)', async () => {
      await withTempDb('scope-absent', async (store) => {
        await store.insertChunks([
          createTestChunk('a', '/a/x.md', 0, createNormalizedVector(1)),
          createTestChunk('b', '/b/y.md', 0, createNormalizedVector(2)),
        ])

        const results = await store.search(createNormalizedVector(1), { limit: 20 })
        const paths = [...new Set(results.map((r) => r.filePath))].sort()

        // No scope → no .where() prefilter → every corpus surfaces.
        expect(paths).toEqual(['/a/x.md', '/b/y.md'])
      })
    })
  })

  /**
   * search({ scope, queryText }) — the FTS / keyword-boost branch (Step 3 of
   * search()). Distinct from the vector-only `search scope prefilter` block:
   * every search here passes a non-empty queryText so the FTS branch is active
   * (ftsEnabled is true after insertChunks creates the index). Real-LanceDB
   * integration (mocks cannot verify the FTS `filePath IN (...)` / scope
   * interaction). Discharges AC4 (FTS stays in-scope; skip on zero hits) and
   * AC7 (scope-absent hybrid unchanged).
   */
  describe('search scope prefilter (FTS/hybrid branch)', () => {
    /** Distinct filePaths from a scoped hybrid (queryText present) search. */
    async function scopedHybridFilePaths(
      store: VectorStore,
      scope: string[],
      queryText: string
    ): Promise<string[]> {
      const results = await store.search(createNormalizedVector(1), { scope, queryText, limit: 20 })
      return [...new Set(results.map((r) => r.filePath))].sort()
    }

    it('restricts hybrid (queryText present) results to in-scope files only', async () => {
      await withTempDb('fts-scope-boundary', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha keyword inside', '/a/b/x.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha keyword nested', '/a/b/sub/y.md', 0, createNormalizedVector(2)),
          createTestChunk('alpha keyword boundary', '/a/bc.md', 0, createNormalizedVector(3)),
          createTestChunk('alpha keyword other', '/foo/bar.md', 0, createNormalizedVector(4)),
        ])

        // queryText 'alpha' matches every doc's text via FTS; only scope must
        // restrict the set. /a/bc.md (boundary) and /foo/bar.md (other) excluded.
        const paths = await scopedHybridFilePaths(store, ['/a/b'], 'alpha')

        expect(paths).toEqual(['/a/b/sub/y.md', '/a/b/x.md'])
      })
    })

    it('skips the FTS branch entirely when scope matches no stored path (no IN ())', async () => {
      await withTempDb('fts-scope-empty', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha keyword one', '/a/x.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha keyword two', '/b/y.md', 0, createNormalizedVector(2)),
        ])

        // Scope matches nothing → scoped vector step returns zero hits. The FTS
        // branch must be skipped before building a predicate, so table.search
        // (the FTS query) is never invoked — otherwise it builds a malformed
        // `filePath IN ()` that LanceDB rejects. Asserting the call count turns
        // this red under the defect (where the catch swallows the parse error
        // and the result is empty either way).
        const table = (store as unknown as { table: { search: (...args: unknown[]) => unknown } })
          .table
        const ftsSpy = vi.spyOn(table, 'search')

        const results = await store.search(createNormalizedVector(1), {
          scope: ['/nonexistent'],
          queryText: 'alpha',
          limit: 20,
        })

        expect(results).toEqual([])
        expect(ftsSpy).not.toHaveBeenCalled()
        ftsSpy.mockRestore()
      })
    })

    it('keeps scope-absent hybrid results unchanged (backward compatible)', async () => {
      await withTempDb('fts-scope-absent', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha keyword a', '/a/x.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha keyword b', '/b/y.md', 0, createNormalizedVector(2)),
        ])

        const results = await store.search(createNormalizedVector(1), {
          queryText: 'alpha',
          limit: 20,
        })
        const paths = [...new Set(results.map((r) => r.filePath))].sort()

        // No scope → FTS branch runs over all vector hits → every corpus surfaces.
        expect(paths).toEqual(['/a/x.md', '/b/y.md'])
      })
    })

    it('inherits scope on the FTS branch for backslash-style stored paths', async () => {
      await withTempDb('fts-scope-backslash', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha win inside', 'C:\\docs\\a.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha win boundary', 'C:\\docsX\\b.md', 0, createNormalizedVector(2)),
        ])

        const paths = await scopedHybridFilePaths(store, ['C:\\docs'], 'alpha')

        expect(paths).toEqual(['C:\\docs\\a.md'])
      })
    })

    it('matches an exact file scope on the FTS branch (exact-or-descendant)', async () => {
      await withTempDb('fts-scope-exact-file', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha the file', '/foo/bar.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha sibling', '/foo/bar.md.bak', 0, createNormalizedVector(2)),
        ])

        const paths = await scopedHybridFilePaths(store, ['/foo/bar.md'], 'alpha')

        // Exact file scope matches the file itself; the .bak sibling is excluded.
        expect(paths).toEqual(['/foo/bar.md'])
      })
    })

    it('matches everything under a root scope on the FTS branch without doubling', async () => {
      await withTempDb('fts-scope-root', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha top', '/a.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha nested', '/deep/nested.md', 0, createNormalizedVector(2)),
        ])

        const paths = await scopedHybridFilePaths(store, ['/'], 'alpha')

        expect(paths).toEqual(['/a.md', '/deep/nested.md'])
      })
    })

    it('unions multiple prefixes on the FTS branch', async () => {
      await withTempDb('fts-scope-multi', async (store) => {
        await store.insertChunks([
          createTestChunk('alpha corpus a', '/a/x.md', 0, createNormalizedVector(1)),
          createTestChunk('alpha corpus b', '/b/y.md', 0, createNormalizedVector(2)),
          createTestChunk('alpha corpus c', '/c/z.md', 0, createNormalizedVector(3)),
        ])

        const paths = await scopedHybridFilePaths(store, ['/a', '/b'], 'alpha')

        expect(paths).toEqual(['/a/x.md', '/b/y.md'])
      })
    })

    it('neutralizes an injection prefix on the FTS branch (quote/%/_)', async () => {
      await withTempDb('fts-scope-injection', async (store) => {
        const trickyDir = "/danger/o'_%dir"
        await store.insertChunks([
          createTestChunk(
            'alpha inside tricky',
            `${trickyDir}/child.md`,
            0,
            createNormalizedVector(1)
          ),
          createTestChunk(
            'alpha wildcard decoy',
            '/danger/oXY_ZZZdir/child.md',
            0,
            createNormalizedVector(2)
          ),
          createTestChunk('alpha unrelated', '/safe/file.md', 0, createNormalizedVector(3)),
        ])

        const paths = await scopedHybridFilePaths(store, [trickyDir], 'alpha')

        // Only the literal descendant; %/_ must not act as wildcards and the
        // quote must not break the predicate even through the FTS branch.
        expect(paths).toEqual([`${trickyDir}/child.md`])
      })
    })
  })
})
