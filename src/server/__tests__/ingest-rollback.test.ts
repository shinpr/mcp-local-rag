// Ingest Rollback Tests
// Test Type: Unit Test (spy-based, compatible with isolate: false)
// Tests rollback behavior when insertChunks fails during re-ingestion

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MockInstance } from 'vitest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import { expectError, expectRecord, privateMembers } from '../../__tests__/test-doubles.js'
import * as rawDataUtils from '../../utils/raw-data-utils.js'
import type { VectorChunk, VectorStore } from '../../vectordb/index.js'
import { DatabaseError } from '../../vectordb/types.js'
import { RAGServer } from '../index.js'

/**
 * Reach the server's private `VectorStore` so persistence failures can be
 * simulated. Rollback is only observable through the store, and exposing it
 * publicly would widen the production API for a test. The cast is confined to
 * this one helper.
 */
function privateVectorStore(server: RAGServer): VectorStore {
  return privateMembers<{ vectorStore: VectorStore }>(server).vectorStore
}

describe('Ingest Rollback', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-rollback')
  const testDataDir = resolve('./tmp/test-data-rollback')

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
    vi.restoreAllMocks()
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it.each([false, true])(
    'removes partially inserted rows before restoring existing=%s',
    async (existing) => {
      const filePath = resolve(testDataDir, `partial-insert-${existing}.txt`)
      const store = privateMembers<{ vectorStore: VectorStore }>(ragServer).vectorStore
      if (existing) {
        writeFileSync(filePath, 'Prior material for partial insert. '.repeat(20))
        await ragServer.handleIngestFile({ filePath })
      }
      const originalRows = await store.getChunksByFilePath(filePath)
      const insert = store.insertChunks.bind(store)
      const spy = vi.spyOn(store, 'insertChunks').mockImplementationOnce(async (rows) => {
        await insert(rows)
        throw new Error('Post-insert setup failed')
      })
      try {
        writeFileSync(filePath, 'Replacement material for partial insert. '.repeat(20))
        await expect(ragServer.handleIngestFile({ filePath })).rejects.toThrow(
          'Post-insert setup failed'
        )
        expect(await store.getChunksByFilePath(filePath)).toEqual(originalRows)
      } finally {
        spy.mockRestore()
      }
    }
  )

  it('keeps only committed replacement rows when optimization fails', async () => {
    const filePath = resolve(testDataDir, 'post-commit.txt')
    writeFileSync(filePath, 'Original material for optimization test. '.repeat(20))
    await ragServer.handleIngestFile({ filePath })
    const store = privateMembers<{ vectorStore: VectorStore }>(ragServer).vectorStore
    const optimize = vi
      .spyOn(store, 'optimize')
      .mockRejectedValueOnce(new Error('Optimization failed'))
    try {
      writeFileSync(filePath, 'Replacement material for optimization test. '.repeat(20))
      await expect(ragServer.handleIngestFile({ filePath })).rejects.toThrow('Optimization failed')
      const rows = await store.getChunksByFilePath(filePath)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.text.includes('Replacement material'))).toBe(true)
      expect(new Set(rows.map((row) => row.chunkIndex)).size).toBe(rows.length)
    } finally {
      optimize.mockRestore()
    }
  })

  it.each(['empty', 'insert', 'sidecar', 'optimize'] as const)(
    'preserves coherent source artifacts and rows after a replacement %s failure',
    async (failure) => {
      const source = `audit-replacement-${failure}`
      const metadata = { source, format: 'markdown' as const }
      const original = `# Original title\n\n${'Original content for source preservation. '.repeat(15)}`
      const replacement = `# Replacement title\n\n${'Replacement content for source preservation. '.repeat(15)}`
      await ragServer.handleIngestData({ content: original, metadata })
      const filePath = rawDataUtils.generateRawDataPath(testDbPath, source)
      const metaPath = rawDataUtils.generateMetaJsonPath(filePath)
      const originalMeta = readFileSync(metaPath, 'utf8')
      const store = privateMembers<{ vectorStore: VectorStore }>(ragServer).vectorStore
      const originalRows = await store.getChunksByFilePath(filePath)
      const saveMeta = rawDataUtils.saveMetaJson
      function installFailure(): MockInstance | undefined {
        switch (failure) {
          case 'insert':
            return vi.spyOn(store, 'insertChunks').mockRejectedValueOnce(new Error('Insert failed'))
          case 'optimize':
            return vi
              .spyOn(store, 'optimize')
              .mockRejectedValueOnce(new Error('Optimization failed'))
          case 'sidecar':
            return vi
              .spyOn(rawDataUtils, 'saveMetaJson')
              .mockImplementationOnce(async (...args) => {
                await saveMeta(...args)
                throw new Error('Sidecar write failed')
              })
          default:
            return undefined
        }
      }
      const spy = installFailure()
      try {
        await expect(
          ragServer.handleIngestData({
            content: failure === 'empty' ? '   ' : replacement,
            metadata,
          })
        ).rejects.toThrow()
        const rows = await store.getChunksByFilePath(filePath)
        if (failure === 'optimize') {
          expect(readFileSync(filePath, 'utf8')).toBe(replacement)
          expect(JSON.parse(readFileSync(metaPath, 'utf8')).title).toBe('Replacement title')
          expect(rows.length).toBeGreaterThan(0)
          expect(rows.every((row) => row.text.includes('Replacement'))).toBe(true)
          expect(new Set(rows.map((row) => row.chunkIndex)).size).toBe(rows.length)
        } else {
          expect(readFileSync(filePath, 'utf8')).toBe(original)
          expect(readFileSync(metaPath, 'utf8')).toBe(originalMeta)
          expect(rows).toEqual(originalRows)
        }
      } finally {
        spy?.mockRestore()
      }
    }
  )

  it('removes both newly created artifacts if sidecar saving fails', async () => {
    const source = 'audit-first-sidecar-failure'
    const filePath = rawDataUtils.generateRawDataPath(testDbPath, source)
    const saveMeta = rawDataUtils.saveMetaJson
    const spy = vi.spyOn(rawDataUtils, 'saveMetaJson').mockImplementationOnce(async (...args) => {
      await saveMeta(...args)
      throw new Error('Sidecar write failed')
    })
    try {
      await expect(
        ragServer.handleIngestData({
          content: 'New source content. '.repeat(20),
          metadata: { source, format: 'text' },
        })
      ).rejects.toThrow('Sidecar write failed')
      expect(existsSync(filePath)).toBe(false)
      expect(existsSync(rawDataUtils.generateMetaJsonPath(filePath))).toBe(false)
      const store = privateMembers<{ vectorStore: VectorStore }>(ragServer).vectorStore
      expect(await store.getChunksByFilePath(filePath)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  // Rollback-restores-original is verified observably below ('restores the full
  // original chunk set with real vectors on rollback').

  it('surfaces a distinct DatabaseError (cause = insert error) when rollback also fails', async () => {
    // Arrange: Ingest a file normally first
    const testFile = resolve(testDataDir, 'rollback-double-fail.txt')
    writeFileSync(testFile, 'Content for double failure test. '.repeat(50))

    await ragServer.handleIngestFile({ filePath: testFile })

    const vectorStore = privateVectorStore(ragServer)

    // Both insert calls fail (new data insert + rollback restore): the prior
    // data is now gone. The handler surfaces a distinct DatabaseError that says
    // so, preserving the original insert error as `.cause`.
    const insertError = new Error('Insert failed')
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(insertError)
      .mockRejectedValueOnce(new Error('Rollback also failed'))

    vi.spyOn(vectorStore, 'optimize').mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    writeFileSync(testFile, 'Updated content for double failure. '.repeat(30))

    let thrown: unknown
    try {
      await ragServer.handleIngestFile({ filePath: testFile })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(DatabaseError)
    expect(expectError(thrown).message).toContain('rollback failed')
    expect(expectError(thrown).message).toContain('may not have been restored')
    expect(expectRecord(thrown)['cause']).toBe(insertError)

    // The rollback failure is still recorded on stderr for diagnostics.
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Rollback failed')

    insertSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('restores the full original chunk set with real vectors on rollback (TD-7/BR-4)', async () => {
    // Arrange: ingest real content, capture the stored chunks (real vectors).
    const testFile = resolve(testDataDir, 'rollback-real-vectors.txt')
    writeFileSync(testFile, 'Alpha beta gamma delta epsilon. '.repeat(80))
    await ragServer.handleIngestFile({ filePath: testFile })

    const vectorStore = privateVectorStore(ragServer)
    const original: VectorChunk[] = await vectorStore.getChunksByFilePath(testFile)
    expect(original.length).toBeGreaterThan(0)

    // Fail the new-data insert, then let the rollback restore run for REAL
    // (not mocked) so we can verify what actually lands back in the DB.
    const origInsert = vectorStore.insertChunks.bind(vectorStore)
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Simulated insertion failure'))
      .mockImplementationOnce((chunks: VectorChunk[]) => origInsert(chunks))
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

    const vectorStore = privateVectorStore(ragServer)

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
