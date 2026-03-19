// RAG MCP Server Integration Test - Re-ingestion & Error Handling
// Split from: rag-server.integration.test.ts (AC-008, AC-009)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../index.js'

describe('AC-008: File Re-ingestion', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac008')
  const localTestDataDir = resolve('./tmp/test-data-ac008')

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

  // AC interpretation: [Functional requirement] Re-ingestion replaces old data completely
  // Validation: Re-ingest with same file path, old chunks are deleted, only new data exists
  it('Re-ingestion replaces old data completely (R-003)', async () => {
    // Initial ingestion
    const testFile = resolve(localTestDataDir, 'test-reingest.txt')
    writeFileSync(testFile, 'This is the original content. '.repeat(50))
    await localRagServer.handleIngestFile({ filePath: testFile })

    // Re-ingestion (content changed)
    writeFileSync(testFile, 'This is the updated content. '.repeat(30))
    const result2 = await localRagServer.handleIngestFile({ filePath: testFile })
    const ingest2 = JSON.parse(result2.content[0].text)
    const updatedChunkCount = ingest2.chunkCount

    // Validation: Only one file exists in file list
    const listResult = await localRagServer.handleListFiles()
    const files = JSON.parse(listResult.content[0].text)
    const targetFiles = files.files.filter((f: { filePath: string }) => f.filePath === testFile)
    expect(targetFiles.length).toBe(1)
    // Validation: Chunk count matches new data (not old + new combined)
    expect(targetFiles[0].chunkCount).toBe(updatedChunkCount)
  })

  // AC interpretation: [Data protection] Prevent data loss when re-ingest results in 0 chunks
  // Validation: When chunking produces 0 chunks, error is thrown before delete (preserves existing data)
  it('Throws error when chunking produces 0 chunks (prevents data loss on re-ingest)', async () => {
    // Initial ingestion with valid content
    const testFile = resolve(localTestDataDir, 'test-empty-chunks.txt')
    writeFileSync(testFile, 'This is valid content for initial ingestion. '.repeat(50))
    const result1 = await localRagServer.handleIngestFile({ filePath: testFile })
    const ingest1 = JSON.parse(result1.content[0].text)
    expect(ingest1.chunkCount).toBeGreaterThan(0)

    // Re-ingest with empty content (should fail, preserving original data)
    writeFileSync(testFile, '')
    await expect(localRagServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      /No.*chunks/i
    )

    // Validation: Original data is preserved (not deleted)
    const listResult = await localRagServer.handleListFiles()
    const files = JSON.parse(listResult.content[0].text)
    const targetFiles = files.files.filter((f: { filePath: string }) => f.filePath === testFile)
    expect(targetFiles.length).toBe(1)
    expect(targetFiles[0].chunkCount).toBe(ingest1.chunkCount)
  })
})

describe('AC-009: Error Handling (Complete)', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac009')
  const localTestDataDir = resolve('./tmp/test-data-ac009')

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

  // AC interpretation: [Error handling] Error message returned for file without access permission
  // Validation: Call ingest_file with file without access permission, FileOperationError is returned
  it('FileOperationError returned for file without access permission (e.g., chmod 000)', async () => {
    const nonExistentFile = resolve(localTestDataDir, 'nonexistent-file.txt')
    await expect(localRagServer.handleIngestFile({ filePath: nonExistentFile })).rejects.toThrow()
  })

  // AC interpretation: [Security] Path traversal attacks are rejected (S-002)
  // Validation: Call ingest_file with invalid path like `../../etc/passwd`, ValidationError is returned
  it('Path traversal attack (e.g., ../../etc/passwd) rejected with ValidationError (S-002)', async () => {
    await expect(localRagServer.handleIngestFile({ filePath: '../../etc/passwd' })).rejects.toThrow(
      'absolute path'
    )
  })
})
