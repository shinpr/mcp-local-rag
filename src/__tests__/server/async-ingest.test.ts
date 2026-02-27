// Async Ingestion Test
// Test Type: Integration Test
// Tests that ingest_file and ingest_data return immediately and that progress
// can be monitored via list_files.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../../server/index.js'
import type { FileEntry, SourceEntry } from '../../server/types.js'
import { isFailedFileEntry } from '../helpers/type-guards.js'

// ============================================
// Test Configuration
// ============================================

const testDbPath = resolve('./tmp/test-async-ingest-db')
const testBaseDir = resolve('./tmp/test-async-ingest-data')
const testConfig = {
  dbPath: testDbPath,
  modelName: 'Xenova/all-MiniLM-L6-v2',
  cacheDir: './tmp/test-model-cache',
  baseDir: testBaseDir,
  maxFileSize: 10 * 1024 * 1024,
}

const SUFFICIENT_TEXT =
  'This is test content for async ingestion. ' +
  'It contains enough text to produce at least one chunk. ' +
  'The semantic chunker requires substantial input to process properly.'

// ============================================
// Tests
// ============================================

describe('Async Ingestion', () => {
  let server: RAGServer

  beforeAll(async () => {
    await mkdir(testDbPath, { recursive: true })
    await mkdir(testBaseDir, { recursive: true })
    await mkdir(testConfig.cacheDir, { recursive: true })
    server = new RAGServer(testConfig)
    await server.initialize()
  }, 120000) // 2 minutes for model download

  afterAll(async () => {
    await rm(testDbPath, { recursive: true, force: true })
    await rm(testBaseDir, { recursive: true, force: true })
  })

  // --------------------------------------------
  // ingest_file — immediate response
  // --------------------------------------------
  describe('ingest_file immediate response', () => {
    it('returns status "started" without waiting for ingestion to complete', async () => {
      const filePath = resolve(testBaseDir, 'async-test.txt')
      await writeFile(filePath, SUFFICIENT_TEXT)

      const result = await server.handleIngestFile({ filePath })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.status).toBe('started')
      expect(parsed.filePath).toBe(filePath)
      expect(parsed.startedAt).toBeDefined()
      expect(parsed.message).toContain('list_files')

      // Wait for background job to finish before the next test
      await server.waitForIngestion(filePath)
    })

    it('returns status "in_progress" when the same file is submitted again while already ingesting', async () => {
      const filePath = resolve(testBaseDir, 'in-progress-test.txt')
      await writeFile(filePath, SUFFICIENT_TEXT)

      // First call — starts background job
      await server.handleIngestFile({ filePath })

      // Second call — job still running
      const result = await server.handleIngestFile({ filePath })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.status).toBe('in_progress')
      expect(parsed.filePath).toBe(filePath)
      expect(parsed.startedAt).toBeDefined()

      await server.waitForIngestion(filePath)
    })
  })

  // --------------------------------------------
  // list_files — progress monitoring
  // --------------------------------------------
  describe('list_files progress monitoring', () => {
    it('shows ingesting: true while a background job is active', async () => {
      const filePath = resolve(testBaseDir, 'progress-monitor-test.txt')
      await writeFile(filePath, SUFFICIENT_TEXT)

      // Start background ingestion
      await server.handleIngestFile({ filePath })

      // list_files immediately after starting should show ingesting: true
      const listResult = await server.handleListFiles()
      const { files } = JSON.parse(listResult.content[0].text)
      const entry = files.find((f: FileEntry) => f.filePath === filePath)

      expect(entry).toBeDefined()
      expect(entry.ingesting).toBe(true)
      expect(entry.startedAt).toBeDefined()

      await server.waitForIngestion(filePath)
    })

    it('shows ingested: true with chunkCount after ingestion completes', async () => {
      const filePath = resolve(testBaseDir, 'completion-test.txt')
      await writeFile(filePath, SUFFICIENT_TEXT)

      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      const listResult = await server.handleListFiles()
      const { files } = JSON.parse(listResult.content[0].text)
      const entry = files.find((f: FileEntry) => f.filePath === filePath)

      expect(entry).toBeDefined()
      expect(entry.ingested).toBe(true)
      expect(entry.chunkCount).toBeGreaterThan(0)
      expect(entry.timestamp).toBeDefined()
      // No longer ingesting
      expect((entry as { ingesting?: unknown }).ingesting).toBeUndefined()
    })

    it('shows failed: true with error message after a failed ingestion', async () => {
      // An empty file produces zero chunks → ingestion fails
      const filePath = resolve(testBaseDir, 'empty-fail-test.txt')
      await writeFile(filePath, '') // empty

      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      const listResult = await server.handleListFiles()
      const { files } = JSON.parse(listResult.content[0].text)
      const entry = files.find((f: FileEntry) => f.filePath === filePath)

      expect(entry).toBeDefined()
      expect(entry.ingested).toBe(false)
      expect(isFailedFileEntry(entry)).toBe(true)
      if (isFailedFileEntry(entry)) {
        expect(entry.error).toBeDefined()
      }
    })

    it('clears failed state and starts fresh when ingesting a previously-failed file again', async () => {
      const filePath = resolve(testBaseDir, 'retry-test.txt')

      // First attempt — empty file, will fail
      await writeFile(filePath, '')
      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      // Write proper content and retry
      await writeFile(filePath, SUFFICIENT_TEXT)
      const retryResult = await server.handleIngestFile({ filePath })
      const parsed = JSON.parse(retryResult.content[0].text)
      expect(parsed.status).toBe('started')

      await server.waitForIngestion(filePath)

      const listResult = await server.handleListFiles()
      const { files } = JSON.parse(listResult.content[0].text)
      const entry = files.find((f: FileEntry) => f.filePath === filePath)

      expect(entry.ingested).toBe(true)
      expect(entry.chunkCount).toBeGreaterThan(0)
    })
  })

  // --------------------------------------------
  // ingest_data — immediate response
  // --------------------------------------------
  describe('ingest_data immediate response', () => {
    it('returns status "started" without waiting for ingestion to complete', async () => {
      const source = 'test://async-ingest-data-test'

      const result = await server.handleIngestData({
        content: SUFFICIENT_TEXT,
        metadata: { source, format: 'text' },
      })
      const parsed = JSON.parse(result.content[0].text)

      expect(parsed.status).toBe('started')
      expect(parsed.filePath).toContain('raw-data')
      expect(parsed.startedAt).toBeDefined()
      expect(parsed.message).toContain(source)

      await server.waitForIngestion(parsed.filePath)
    })

    it('returns status "in_progress" when the same source is submitted again while ingesting', async () => {
      const source = 'test://async-ingest-data-in-progress'

      const first = await server.handleIngestData({
        content: SUFFICIENT_TEXT,
        metadata: { source, format: 'text' },
      })
      const firstParsed = JSON.parse(first.content[0].text)

      // Second call before background job completes
      const second = await server.handleIngestData({
        content: SUFFICIENT_TEXT,
        metadata: { source, format: 'text' },
      })
      const secondParsed = JSON.parse(second.content[0].text)

      expect(secondParsed.status).toBe('in_progress')
      expect(secondParsed.startedAt).toBe(firstParsed.startedAt)

      await server.waitForIngestion(firstParsed.filePath)
    })

    it('appears in list_files sources after ingestion completes', async () => {
      const source = 'https://example.com/async-ingest-list-test'

      const startResult = await server.handleIngestData({
        content: SUFFICIENT_TEXT,
        metadata: { source, format: 'text' },
      })
      const { filePath } = JSON.parse(startResult.content[0].text)

      await server.waitForIngestion(filePath)

      const listResult = await server.handleListFiles()
      const { sources } = JSON.parse(listResult.content[0].text)
      const entry = sources.find((s: SourceEntry) => 'source' in s && s.source === source)

      expect(entry).toBeDefined()
      expect((entry as { chunkCount?: number }).chunkCount).toBeGreaterThan(0)
    })

    it('shows source with ingesting: true in list_files while background job is active', async () => {
      const source = 'test://async-source-progress'

      const startResult = await server.handleIngestData({
        content: SUFFICIENT_TEXT,
        metadata: { source, format: 'text' },
      })
      const { filePath } = JSON.parse(startResult.content[0].text)

      // Check list_files before job completes
      const listResult = await server.handleListFiles()
      const { sources } = JSON.parse(listResult.content[0].text)
      const entry = sources.find(
        (s: SourceEntry) => 'source' in s && (s as { source: string }).source === source
      )

      expect(entry).toBeDefined()
      expect((entry as { ingesting?: boolean }).ingesting).toBe(true)

      await server.waitForIngestion(filePath)
    })
  })

  // --------------------------------------------
  // delete_file — guard against active ingestion
  // --------------------------------------------
  describe('delete_file during active ingestion', () => {
    it('rejects deletion while ingestion is in progress', async () => {
      const filePath = resolve(testBaseDir, 'delete-guard-test.txt')
      await writeFile(filePath, SUFFICIENT_TEXT)

      // Start background ingestion
      await server.handleIngestFile({ filePath })

      // Attempt to delete while still ingesting — should throw
      await expect(server.handleDeleteFile({ filePath })).rejects.toThrow(/in progress/)

      await server.waitForIngestion(filePath)
    })

    it('allows deletion after ingestion completes', async () => {
      const filePath = resolve(testBaseDir, 'delete-after-ingest-test.txt')
      await writeFile(filePath, SUFFICIENT_TEXT)

      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      // Deletion should succeed now
      const deleteResult = await server.handleDeleteFile({ filePath })
      const parsed = JSON.parse(deleteResult.content[0].text)
      expect(parsed.deleted).toBe(true)
    })

    it('clears failed job state on deletion', async () => {
      const filePath = resolve(testBaseDir, 'delete-failed-job-test.txt')

      // Create an empty file so ingestion fails (0 chunks)
      await writeFile(filePath, '')
      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      // Verify it shows as failed
      const listBefore = await server.handleListFiles()
      const filesBefore = JSON.parse(listBefore.content[0].text).files
      const entryBefore = filesBefore.find((f: FileEntry) => f.filePath === filePath)
      expect(isFailedFileEntry(entryBefore)).toBe(true)

      // Delete should succeed and clear the failed job
      await server.handleDeleteFile({ filePath })

      // After deletion, the file should show as not ingested (no failed state)
      const listAfter = await server.handleListFiles()
      const filesAfter = JSON.parse(listAfter.content[0].text).files
      const entryAfter = filesAfter.find((f: FileEntry) => f.filePath === filePath)
      expect(entryAfter).toBeDefined()
      expect(entryAfter.ingested).toBe(false)
      expect(isFailedFileEntry(entryAfter)).toBe(false)
    })
  })

  // --------------------------------------------
  // Re-ingestion failure visibility
  // --------------------------------------------
  describe('re-ingestion failure visibility', () => {
    it('shows failed: true with existing data preserved when re-ingestion fails', async () => {
      const filePath = resolve(testBaseDir, 'reingest-fail-test.txt')

      // First ingestion — succeeds
      await writeFile(filePath, SUFFICIENT_TEXT)
      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      const listBefore = await server.handleListFiles()
      const filesBefore = JSON.parse(listBefore.content[0].text).files
      const entryBefore = filesBefore.find((f: FileEntry) => f.filePath === filePath)
      expect(entryBefore.ingested).toBe(true)
      const originalChunkCount = entryBefore.chunkCount

      // Re-ingest with empty content — background job will fail (0 chunks)
      await writeFile(filePath, '')
      await server.handleIngestFile({ filePath })
      await server.waitForIngestion(filePath)

      // list_files should show ingested: true (data preserved) + failed: true
      const listAfter = await server.handleListFiles()
      const filesAfter = JSON.parse(listAfter.content[0].text).files
      const entryAfter = filesAfter.find((f: FileEntry) => f.filePath === filePath)
      expect(entryAfter).toBeDefined()
      expect(entryAfter.ingested).toBe(true)
      expect(entryAfter.chunkCount).toBe(originalChunkCount)
      expect((entryAfter as { failed?: boolean }).failed).toBe(true)
      expect((entryAfter as { error?: string }).error).toContain('No chunks')
    })
  })

  // --------------------------------------------
  // Failed ingest_data visibility in sources
  // --------------------------------------------
  describe('failed ingest_data visibility in sources', () => {
    it('shows failed source entry in list_files when ingest_data content produces 0 chunks', async () => {
      // ingest_data with content too short to chunk — the raw-data file gets written,
      // but the background ingestion fails because no chunks are produced.
      // Use a very short string that passes HTML/readability but fails chunking.
      const source = 'test://failed-source-visibility'
      const result = await server.handleIngestData({
        content: 'x', // too short for chunking
        metadata: { source, format: 'text' },
      })
      const { filePath } = JSON.parse(result.content[0].text)
      await server.waitForIngestion(filePath)

      const listResult = await server.handleListFiles()
      const { sources } = JSON.parse(listResult.content[0].text)
      const entry = sources.find(
        (s: SourceEntry) => 'source' in s && (s as { source: string }).source === source
      )

      expect(entry).toBeDefined()
      expect((entry as { failed?: boolean }).failed).toBe(true)
      expect((entry as { error?: string }).error).toBeDefined()
    })
  })
})
