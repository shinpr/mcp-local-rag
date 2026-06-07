// Ingest Rollback Tests
// Test Type: Unit Test (spy-based, compatible with isolate: false)
// Tests rollback behavior when insertChunks fails during re-ingestion

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VectorChunk } from '../../vectordb/index.js'
import { RAGServer } from '../index.js'

describe('Ingest Rollback', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-rollback')
  const testDataDir = resolve('./tmp/test-data-rollback')

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
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // Rollback-restores-original is verified observably below ('restores the full
  // original chunk set with real vectors on rollback').

  it('throws combined error when both insertChunks and rollback fail', async () => {
    // Arrange: Ingest a file normally first
    const testFile = resolve(testDataDir, 'rollback-double-fail.txt')
    writeFileSync(testFile, 'Content for double failure test. '.repeat(50))

    await ragServer.handleIngestFile({ filePath: testFile })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore

    // Both insert calls fail (new data insert + rollback restore)
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Insert failed'))
      .mockRejectedValueOnce(new Error('Rollback also failed'))

    vi.spyOn(vectorStore, 'optimize').mockResolvedValue(undefined)

    // Act: Re-ingest (should fail with combined error)
    writeFileSync(testFile, 'Updated content for double failure. '.repeat(30))

    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Failed to ingest file and rollback failed'
    )

    insertSpy.mockRestore()
  })

  it('restores the full original chunk set with real vectors on rollback (TD-7/BR-4)', async () => {
    // Arrange: ingest real content, capture the stored chunks (real vectors).
    const testFile = resolve(testDataDir, 'rollback-real-vectors.txt')
    writeFileSync(testFile, 'Alpha beta gamma delta epsilon. '.repeat(80))
    await ragServer.handleIngestFile({ filePath: testFile })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore
    const original: VectorChunk[] = await vectorStore.getChunksByFilePath(testFile)
    expect(original.length).toBeGreaterThan(0)

    // Fail the new-data insert, then let the rollback restore run for REAL
    // (not mocked) so we can verify what actually lands back in the DB.
    const origInsert = vectorStore.insertChunks.bind(vectorStore)
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Simulated insertion failure'))
      .mockImplementationOnce((chunks: unknown) => origInsert(chunks))
    const optimizeSpy = vi.spyOn(vectorStore, 'optimize')

    // Act: re-ingest with different content (different embeddings) — the old
    // broken backup would have restored a dummy vector taken from THIS content.
    writeFileSync(testFile, 'Completely unrelated zebra yak xylophone. '.repeat(20))
    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Simulated insertion failure'
    )

    // Assert: the full original set is restored with its real stored vectors.
    const restored: VectorChunk[] = await vectorStore.getChunksByFilePath(testFile)
    const byIndex = (cs: VectorChunk[]): VectorChunk[] =>
      [...cs].sort((a, b) => a.chunkIndex - b.chunkIndex)
    const o = byIndex(original)
    const r = byIndex(restored)
    expect(r.length).toBe(o.length)
    expect(r.map((c) => c.text)).toEqual(o.map((c) => c.text))
    // Real vectors, not a single dummy: every restored vector matches the
    // original stored vector for that chunk.
    expect(r.map((c) => c.vector)).toEqual(o.map((c) => c.vector))

    insertSpy.mockRestore()
    optimizeSpy.mockRestore()
  })

  it('leaves no partial data when insert fails for a new file (no backup to roll back to)', async () => {
    // Arrange: New file (no prior ingestion)
    const testFile = resolve(testDataDir, 'rollback-new-file.txt')
    writeFileSync(testFile, 'New file content. '.repeat(50))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore

    // Force the insert to fail (the only way to exercise the failure path).
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Insert failed for new file'))

    // Act: Should surface the insert error directly.
    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Insert failed for new file'
    )

    // No backup → no rollback attempted: insertChunks called exactly once.
    // (Spy-verified; "no rollback attempted" has no observable surface.)
    expect(insertSpy).toHaveBeenCalledTimes(1)

    insertSpy.mockRestore()

    // Observable: the failed first-time insert leaks no rows.
    const persisted = await vectorStore.getChunksByFilePath(testFile)
    expect(persisted).toHaveLength(0)
  })
})
