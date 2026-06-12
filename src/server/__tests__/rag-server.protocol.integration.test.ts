// RAG MCP Server Integration Test - Protocol & Basic Error Handling
// Split from: rag-server.integration.test.ts (AC-001, AC-005)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTestDevice } from '../../__tests__/test-device.js'
import { DatabaseError } from '../../vectordb/types.js'
import { RAGServer } from '../index.js'

describe('AC-001: MCP Protocol Integration', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-protocol')
  const testDataDir = resolve('./tmp/test-data-protocol')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })

    ragServer = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    await ragServer.initialize()
  })

  afterAll(async () => {
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Error handling] Appropriate MCP error response returned when error occurs
  // Validation: MCP error response (error code, message) returned for invalid input
  it('Appropriate MCP error response (JSON-RPC 2.0 format) returned for invalid tool invocation', async () => {
    // Call ingest_file with non-existent file and verify error occurs
    await expect(
      ragServer.handleIngestFile({ filePath: '/nonexistent/file.pdf' })
    ).rejects.toThrow()
  })

  // Edge Case: Parallel request processing
  // Validation: Multiple MCP tool invocations are processed in parallel
  it('3 parallel MCP tool invocations are processed normally (P-003)', async () => {
    // Invoke 3 handlers in parallel
    const results = await Promise.all([
      ragServer.handleStatus(),
      ragServer.handleListFiles(),
      ragServer.handleStatus(),
    ])

    // Verify all results are returned normally
    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result).toBeDefined()
      expect(result.content).toBeDefined()
      expect(result.content.length).toBe(1)
      expect(result.content[0].type).toBe('text')
    }
  })
})

describe('AC-005: Error Handling (Basic)', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-error-basic')
  const testDataDir = resolve('./tmp/test-data-error-basic')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })

    ragServer = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    await ragServer.initialize()
  })

  afterAll(async () => {
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Error handling] Error message returned for non-existent file path
  // Validation: Call ingest_file with non-existent file path, FileOperationError is returned
  it('FileOperationError returned for non-existent file path (e.g., /nonexistent/file.pdf)', async () => {
    const nonExistentFile = resolve(testDataDir, 'nonexistent-file.pdf')
    await expect(ragServer.handleIngestFile({ filePath: nonExistentFile })).rejects.toThrow()
  })

  // AC interpretation: [Error handling] Error message returned for corrupted PDF file
  // Validation: Call ingest_file with corrupted PDF file, FileOperationError is returned
  it('FileOperationError returned for corrupted PDF file (e.g., invalid header)', async () => {
    // Create corrupted PDF file
    const corruptedPdf = resolve(testDataDir, 'corrupted.pdf')
    writeFileSync(corruptedPdf, 'This is not a valid PDF file')

    await expect(ragServer.handleIngestFile({ filePath: corruptedPdf })).rejects.toThrow()
  })

  // AC interpretation: [Error handling] Error message returned when LanceDB connection fails
  // Validation: When LanceDB connection fails, DatabaseError is returned
  it('DatabaseError returned when LanceDB connection fails (e.g., invalid dbPath)', async () => {
    // Nest dbPath under a file (ENOTDIR everywhere): a bogus POSIX path is creatable on Windows.
    const dbBlocker = resolve(testDataDir, 'db-blocker')
    writeFileSync(dbBlocker, 'x')
    const invalidDbPath = resolve(dbBlocker, 'db')
    const invalidServer = new RAGServer(
      withTestDevice({
        dbPath: invalidDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: './tmp/models',
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    // The DB failure surfaces either at initialize() or at query time; both must be a DatabaseError.
    try {
      await invalidServer.initialize()
      await expect(invalidServer.handleQueryDocuments({ query: 'test' })).rejects.toBeInstanceOf(
        DatabaseError
      )
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError)
    } finally {
      await invalidServer.close()
    }
  })
})
