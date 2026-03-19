// Ingest Rollback Tests
// Test Type: Unit Test (spy-based, compatible with isolate: false)
// Tests rollback behavior when insertChunks fails during re-ingestion

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

  afterAll(() => {
    vi.restoreAllMocks()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('restores backup chunks when insertChunks fails on re-ingestion', async () => {
    // Arrange: Ingest a file normally first (creates real data)
    const testFile = resolve(testDataDir, 'rollback-test.txt')
    writeFileSync(testFile, 'Original content for rollback testing. '.repeat(50))

    const result1 = await ragServer.handleIngestFile({ filePath: testFile })
    const ingest1 = JSON.parse(result1.content[0].text)
    const originalChunkCount = ingest1.chunkCount
    expect(originalChunkCount).toBeGreaterThan(0)

    // Access the private vectorStore to spy on insertChunks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore

    // Spy on insertChunks: fail on next call (the new data insert), then succeed (rollback restore)
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Simulated insertion failure'))
      .mockImplementationOnce(async () => {
        // Rollback call: just succeed (restore backup)
        return undefined
      })

    const optimizeSpy = vi.spyOn(vectorStore, 'optimize').mockResolvedValue(undefined)

    // Act: Re-ingest the file (should fail on insert, then rollback)
    writeFileSync(testFile, 'Updated content that triggers rollback. '.repeat(30))

    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Simulated insertion failure'
    )

    // Assert: insertChunks called twice (1st: new data fails, 2nd: rollback restore)
    expect(insertSpy).toHaveBeenCalledTimes(2)

    // Verify the rollback call contained backup data with the original file path
    const rollbackCall = insertSpy.mock.calls[1]
    const rollbackChunks = rollbackCall[0] as Array<{ filePath: string; text: string }>
    expect(rollbackChunks.length).toBeGreaterThan(0)
    expect(rollbackChunks[0].filePath).toBe(testFile)

    // Verify optimize was called during rollback
    expect(optimizeSpy).toHaveBeenCalled()

    // Cleanup spies for next test
    insertSpy.mockRestore()
    optimizeSpy.mockRestore()
  })

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

  it('does not attempt rollback for new file ingestion (no backup exists)', async () => {
    // Arrange: New file (no prior ingestion)
    const testFile = resolve(testDataDir, 'rollback-new-file.txt')
    writeFileSync(testFile, 'New file content. '.repeat(50))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore

    // insertChunks fails on first call
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Insert failed for new file'))

    // Act: Should throw the insert error directly (no rollback attempt)
    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Insert failed for new file'
    )

    // Assert: insertChunks called only once (no rollback call since no backup)
    expect(insertSpy).toHaveBeenCalledTimes(1)

    insertSpy.mockRestore()
  })
})
