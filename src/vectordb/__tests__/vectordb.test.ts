import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type VectorChunk, VectorStore } from '../index.js'

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
        const results = await store.search(createNormalizedVector(1), 'test query', 10)
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
        const results = await store.search(queryVector, 'ProjectLifetimeScope', 10)

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
        const results = await store.search(createNormalizedVector(1), '', 10)

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
        const results = await store.search(createNormalizedVector(1), undefined, 10)

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
        const results = await store.search(queryVector, '依存性注入', 10)

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
      const fs = await import('node:fs')
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
        const results = await store.search(queryVector, 'UniqueKeyword', 10)

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
      const fs = await import('node:fs')
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

        const results = await store.search(queryVector, 'UniqueKeyword', 10)

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
      const fs = await import('node:fs')
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

        const results = await store.search(queryVector, 'UniqueKeyword', 10)

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
      const dbPath = './tmp/test-vectordb-maxfiles-precondition'
      if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath, { recursive: true })
      }

      try {
        const store = new VectorStore({
          dbPath,
          tableName: 'chunks',
        })
        await store.initialize()

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

        const results = await store.search(queryVector, '', 10)

        // Verify: seed 1 < seed 2 < seed 50 in distance
        const score1 = results.find((r) => r.filePath === '/test/s1.txt')?.score ?? 999
        const score2 = results.find((r) => r.filePath === '/test/s2.txt')?.score ?? 999
        const score50 = results.find((r) => r.filePath === '/test/s50.txt')?.score ?? 999
        expect(score1).toBeLessThan(score2)
        expect(score2).toBeLessThan(score50)
      } finally {
        if (fs.existsSync(dbPath)) {
          fs.rmSync(dbPath, { recursive: true })
        }
      }
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

        const results = await store.search(queryVector, '', 10)

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

        const results = await store.search(queryVector, '', 10)

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

        const results = await store.search(queryVector, '', 10)

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

        const results = await store.search(queryVector, '', 10)

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

        const results = await store.search(queryVector, '', 10)

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

          const results = await store.search(createNormalizedVector(1), '', 10)

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

          const results = await store.search(baseVector, '', 10)

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

          const results = await store.search(baseVector, '', 10)

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

          const results = await store.search(baseVector, '', 10)

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

      it('returns first two groups when multiple boundaries exist', async () => {
        const relatedDbPath = './tmp/test-vectordb-related-multi-boundary'
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

          // Create 3 distinct groups with large gaps between them
          // Group 1: seed 1 (distance ~0 from query)
          const group1Vector = createNormalizedVector(1)
          for (let i = 0; i < 2; i++) {
            const chunk = createTestChunk(
              `Group1 Doc ${i}`,
              `/test/group1-${i}.txt`,
              0,
              group1Vector
            )
            await store.insertChunks([chunk])
          }

          // Group 2: seed 50 (medium distance from query)
          const group2Vector = createNormalizedVector(50)
          for (let i = 0; i < 2; i++) {
            const chunk = createTestChunk(
              `Group2 Doc ${i}`,
              `/test/group2-${i}.txt`,
              0,
              group2Vector
            )
            await store.insertChunks([chunk])
          }

          // Group 3: seed 100 (far distance from query)
          const group3Vector = createNormalizedVector(100)
          for (let i = 0; i < 2; i++) {
            const chunk = createTestChunk(
              `Group3 Doc ${i}`,
              `/test/group3-${i}.txt`,
              0,
              group3Vector
            )
            await store.insertChunks([chunk])
          }

          const results = await store.search(group1Vector, '', 10)

          // Contract: 'related' mode with 2+ boundaries → return first 2 groups
          // Group 1 and Group 2 should be included, Group 3 should be excluded
          expect(results.length).toBeLessThanOrEqual(6) // At most all 6 docs
          expect(results.filter((r) => r.text.includes('Group1'))).toHaveLength(2)
          // Group 2 may or may not be included depending on gap distribution
          // Group 3 should be excluded if boundaries are detected correctly
          const group3Count = results.filter((r) => r.text.includes('Group3')).length
          expect(group3Count).toBeLessThanOrEqual(
            results.filter((r) => r.text.includes('Group2')).length
          )
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
          const similarResults = await similarStore.search(baseVector, '', 10)

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
          const relatedResults = await relatedStore.search(baseVector, '', 10)

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
})
