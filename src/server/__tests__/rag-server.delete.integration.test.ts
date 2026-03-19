// RAG MCP Server Integration Test - File Deletion
// Split from: rag-server.integration.test.ts (AC-010)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../index.js'

describe('AC-010: File Deletion', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac010')
  const localTestDataDir = resolve('./tmp/test-data-ac010')

  beforeAll(async () => {
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
  })

  afterAll(async () => {
    rmSync(localTestDbPath, { recursive: true, force: true })
    rmSync(localTestDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Functional requirement] Deleted file no longer appears in list_files
  // Validation: Delete ingested file, verify it no longer appears in list_files
  it('Deleted file no longer appears in list_files', async () => {
    const testFile = resolve(localTestDataDir, 'test-delete.txt')
    writeFileSync(testFile, 'This file will be deleted. '.repeat(50))
    await localRagServer.handleIngestFile({ filePath: testFile })

    // Verify file exists before deletion
    const listBefore = await localRagServer.handleListFiles()
    const filesBefore = JSON.parse(listBefore.content[0].text)
    expect(filesBefore.files.some((f: { filePath: string }) => f.filePath === testFile)).toBe(true)

    // Execute deletion
    await localRagServer.handleDeleteFile({ filePath: testFile })

    // Verify file is no longer ingested after deletion (still on disk, but ingested: false)
    const listAfter = await localRagServer.handleListFiles()
    const filesAfter = JSON.parse(listAfter.content[0].text)
    expect(
      filesAfter.files.some(
        (f: { filePath: string; ingested: boolean }) => f.filePath === testFile && f.ingested
      )
    ).toBe(false)
  })

  // AC interpretation: [Functional requirement] Deleted file content does not appear in search results
  // Validation: Delete file, verify its content is not returned in search results
  it('Deleted file content does not appear in search results', async () => {
    const testFile = resolve(localTestDataDir, 'test-search-delete.txt')
    writeFileSync(testFile, 'Unique keyword XYZABC123 for deletion test. '.repeat(30))
    await localRagServer.handleIngestFile({ filePath: testFile })

    // Search before deletion
    const searchBefore = await localRagServer.handleQueryDocuments({
      query: 'XYZABC123',
      limit: 5,
    })
    const resultsBefore = JSON.parse(searchBefore.content[0].text)
    expect(resultsBefore.length).toBeGreaterThan(0)

    // Execute deletion
    await localRagServer.handleDeleteFile({ filePath: testFile })

    // Search after deletion
    const searchAfter = await localRagServer.handleQueryDocuments({
      query: 'XYZABC123',
      limit: 5,
    })
    const resultsAfter = JSON.parse(searchAfter.content[0].text)
    expect(resultsAfter.length).toBe(0)
  })

  // AC interpretation: [Functional requirement] Deleting non-existent file is idempotent
  // Validation: Delete non-existent file, operation completes without error
  it('Deleting non-existent file completes without error (idempotent)', async () => {
    const nonExistentFile = resolve(localTestDataDir, 'non-existent.txt')

    await expect(
      localRagServer.handleDeleteFile({ filePath: nonExistentFile })
    ).resolves.toBeDefined()
  })

  // AC interpretation: [Security] Relative path deletion is rejected (S-002)
  // Validation: Attempt deletion with relative path, ValidationError is returned
  it('Relative path deletion rejected with error (S-002 security)', async () => {
    await expect(
      localRagServer.handleDeleteFile({ filePath: '../../../etc/passwd' })
    ).rejects.toThrow('absolute path')
  })
})
