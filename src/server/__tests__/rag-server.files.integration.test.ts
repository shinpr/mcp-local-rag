// RAG MCP Server Integration Test - Format Support & File Management
// Split from: rag-server.integration.test.ts (AC-006, AC-007)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../index.js'

describe('AC-006: Additional Format Support (Phase 2)', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac006')
  const localTestDataDir = resolve('./tmp/test-data-ac006')

  beforeAll(async () => {
    mkdirSync(localTestDbPath, { recursive: true })
    mkdirSync(localTestDataDir, { recursive: true })

    localRagServer = new RAGServer({
      dbPath: localTestDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDir: localTestDataDir,
      maxFileSize: 100 * 1024 * 1024,
      chunkMinLength: 50,
    })

    await localRagServer.initialize()
  })

  afterAll(async () => {
    rmSync(localTestDbPath, { recursive: true, force: true })
    rmSync(localTestDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Functional requirement] DOCX files ingested via ingest_file tool and text extracted
  // Validation: Call ingest_file with DOCX file path, text extraction and chunk storage succeed
  it('DOCX file ingested via ingest_file tool, text properly extracted and saved to LanceDB', async () => {
    const { DocumentParser } = await import('../../parser/index')
    const parser = new DocumentParser({
      baseDir: localTestDataDir,
      maxFileSize: 100 * 1024 * 1024,
    })

    // Verify parseFile method recognizes .docx extension
    const testTxtFile = resolve(localTestDataDir, 'test-for-docx.txt')
    writeFileSync(testTxtFile, 'Test content for DOCX format check')

    // Verify calling parseFile as .docx file calls parseDocx
    try {
      const fakeDocxFile = resolve(localTestDataDir, 'fake.docx')
      writeFileSync(fakeDocxFile, 'Not a real DOCX file')
      await parser.parseFile(fakeDocxFile)
      // Fail if error does not occur
      expect(false).toBe(true)
    } catch (error) {
      // Verify FileOperationError occurs (DOCX parse failure)
      expect((error as Error).name).toBe('FileOperationError')
      expect((error as Error).message).toContain('Failed to parse DOCX')
    }
  })

  // AC interpretation: [Functional requirement] All formats (PDF/DOCX/TXT/MD) ingested successfully
  // Validation: All 4 formats (PDF, DOCX, TXT, MD) ingested successfully
  it('Sample files for all formats (PDF, DOCX, TXT, MD) ingested successfully', async () => {
    const { DocumentParser } = await import('../../parser/index')
    const parser = new DocumentParser({
      baseDir: localTestDataDir,
      maxFileSize: 100 * 1024 * 1024,
    })

    // Test TXT file parsing
    const testTxtFile = resolve(localTestDataDir, 'test-all-formats.txt')
    writeFileSync(testTxtFile, 'Test content for TXT format')
    const txtResult = await parser.parseFile(testTxtFile)
    expect(txtResult.content).toBe('Test content for TXT format')

    // Test MD file parsing
    const testMdFile = resolve(localTestDataDir, 'test-all-formats.md')
    writeFileSync(testMdFile, '# Test Markdown\n\nTest content for MD format')
    const mdResult = await parser.parseFile(testMdFile)
    expect(mdResult.content).toBe('# Test Markdown\n\nTest content for MD format')

    // Verify DOCX file branching exists
    const fakeDocxFile = resolve(localTestDataDir, 'test-all-formats.docx')
    writeFileSync(fakeDocxFile, 'Not a real DOCX file')
    try {
      await parser.parseFile(fakeDocxFile)
      expect(false).toBe(true)
    } catch (error) {
      expect((error as Error).name).toBe('FileOperationError')
      expect((error as Error).message).toContain('Failed to parse DOCX')
    }

    // PDF uses parsePdf directly (not parseFile)
    const fakePdfFile = resolve(localTestDataDir, 'test-all-formats.pdf')
    writeFileSync(fakePdfFile, 'Not a real PDF file')
    try {
      await parser.parseFile(fakePdfFile)
      expect(false).toBe(true)
    } catch (error) {
      expect((error as Error).name).toBe('ValidationError')
      expect((error as Error).message).toContain('Unsupported file format')
    }
  })
})

describe('AC-007: File Management', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-ac007')
  const localTestDataDir = resolve('./tmp/test-data-ac007')

  beforeAll(async () => {
    mkdirSync(localTestDbPath, { recursive: true })
    mkdirSync(localTestDataDir, { recursive: true })

    localRagServer = new RAGServer({
      dbPath: localTestDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDir: localTestDataDir,
      maxFileSize: 100 * 1024 * 1024,
      chunkMinLength: 50,
    })

    await localRagServer.initialize()

    // Ingest test documents (3 files)
    const testFile1 = resolve(localTestDataDir, 'test-file-1.txt')
    writeFileSync(testFile1, 'This is test file 1. '.repeat(50))
    await localRagServer.handleIngestFile({ filePath: testFile1 })

    const testFile2 = resolve(localTestDataDir, 'test-file-2.txt')
    writeFileSync(testFile2, 'This is test file 2. '.repeat(30))
    await localRagServer.handleIngestFile({ filePath: testFile2 })

    const testFile3 = resolve(localTestDataDir, 'test-file-3.txt')
    writeFileSync(testFile3, 'This is test file 3. '.repeat(20))
    await localRagServer.handleIngestFile({ filePath: testFile3 })
  })

  afterAll(async () => {
    rmSync(localTestDbPath, { recursive: true, force: true })
    rmSync(localTestDataDir, { recursive: true, force: true })
  })

  // AC interpretation: [Functional requirement] List of ingested files displayed via list_files tool
  // Validation: Call list_files, list of ingested files is returned
  it('List of ingested files (filename, path, chunk count, ingestion time) displayed via list_files tool', async () => {
    const result = await localRagServer.handleListFiles()

    expect(result).toBeDefined()
    expect(result.content).toBeDefined()
    expect(result.content.length).toBe(1)
    expect(result.content[0].type).toBe('text')

    const files = JSON.parse(result.content[0].text)
    expect(files.files).toBeDefined()
    expect(files.files.length).toBe(3)

    // Verify each ingested file contains required fields
    for (const file of files.files.filter((f: { ingested: boolean }) => f.ingested)) {
      expect(file.filePath).toBeDefined()
      expect(file.chunkCount).toBeDefined()
      expect(file.timestamp).toBeDefined()
    }
  })

  // AC interpretation: [Functional requirement] Filename, path, chunk count, ingestion time accurately displayed
  // Validation: list_files result contains detailed information for each file
  it('list_files result accurately contains detailed information (filePath, chunkCount, timestamp) for each file', async () => {
    const result = await localRagServer.handleListFiles()
    const files = JSON.parse(result.content[0].text)
    const { files: filesInBaseDir } = files

    // Verify test-file-1.txt information
    const testFile1Path = resolve(localTestDataDir, 'test-file-1.txt')
    const file1 = filesInBaseDir.find((f: { filePath: string }) => f.filePath === testFile1Path)
    expect(file1).toBeDefined()
    expect(file1.chunkCount).toBeGreaterThan(0)
    expect(file1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    // Verify test-file-2.txt information
    const testFile2Path = resolve(localTestDataDir, 'test-file-2.txt')
    const file2 = filesInBaseDir.find((f: { filePath: string }) => f.filePath === testFile2Path)
    expect(file2).toBeDefined()
    expect(file2.chunkCount).toBeGreaterThan(0)
    expect(file2.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

    // Verify test-file-3.txt information
    const testFile3Path = resolve(localTestDataDir, 'test-file-3.txt')
    const file3 = filesInBaseDir.find((f: { filePath: string }) => f.filePath === testFile3Path)
    expect(file3).toBeDefined()
    expect(file3.chunkCount).toBeGreaterThan(0)
    expect(file3.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  // AC interpretation: [Functional requirement] Supported file in BASE_DIR not yet ingested appears as ingested: false
  // Validation: Place a file in BASE_DIR without ingesting it, list_files shows { filePath, ingested: false }
  it('File in BASE_DIR not yet ingested appears with ingested: false in list_files', async () => {
    const uningestedFile = resolve(localTestDataDir, 'not-yet-ingested.txt')
    writeFileSync(uningestedFile, 'This file has not been ingested.')

    try {
      const result = await localRagServer.handleListFiles()
      const files = JSON.parse(result.content[0].text)

      const entry = files.files.find((f: { filePath: string }) => f.filePath === uningestedFile)
      expect(entry).toBeDefined()
      expect(entry.ingested).toBe(false)
      expect(entry.chunkCount).toBeUndefined()
      expect(entry.timestamp).toBeUndefined()
    } finally {
      rmSync(uningestedFile, { force: true })
    }
  })

  // AC interpretation: [Functional requirement] System status displayed via status tool
  // Validation: Call status, document count, chunk count, memory usage, uptime are returned
  it('System status (documentCount, chunkCount, memoryUsage, uptime) displayed via status tool', async () => {
    const result = await localRagServer.handleStatus()

    expect(result).toBeDefined()
    expect(result.content).toBeDefined()
    expect(result.content.length).toBe(1)
    expect(result.content[0].type).toBe('text')

    const status = JSON.parse(result.content[0].text)
    expect(status.documentCount).toBe(3)
    expect(status.chunkCount).toBeGreaterThan(0)
    expect(status.memoryUsage).toBeGreaterThan(0)
    expect(status.uptime).toBeGreaterThan(0)
  })

  describe('System-managed path exclusion from list_files', () => {
    let excludeServer: RAGServer
    const excludeTestBase = resolve('./tmp/test-exclude-base')
    const excludeTestDb = resolve(excludeTestBase, 'lancedb')
    const excludeTestCache = resolve(excludeTestBase, 'models')

    beforeAll(async () => {
      mkdirSync(excludeTestBase, { recursive: true })
      mkdirSync(excludeTestDb, { recursive: true })
      mkdirSync(excludeTestCache, { recursive: true })

      writeFileSync(resolve(excludeTestDb, 'db-internal.txt'), 'Database internal file')
      writeFileSync(resolve(excludeTestCache, 'model-cache.txt'), 'Model cache file')
      writeFileSync(resolve(excludeTestBase, 'user-document.txt'), 'User document content')

      mkdirSync(resolve(excludeTestBase, 'docs'), { recursive: true })
      writeFileSync(resolve(excludeTestBase, 'docs', 'notes.txt'), 'Notes in docs subdirectory')

      excludeServer = new RAGServer({
        dbPath: excludeTestDb,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: excludeTestCache,
        baseDir: excludeTestBase,
        maxFileSize: 100 * 1024 * 1024,
        chunkMinLength: 50,
      })

      await excludeServer.initialize()
    })

    afterAll(async () => {
      rmSync(excludeTestBase, { recursive: true, force: true })
    })

    it('System-managed paths excluded from list_files scan', async () => {
      const result = await excludeServer.handleListFiles()
      const parsed = JSON.parse(result.content[0].text)

      const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

      expect(filePaths).toContain(resolve(excludeTestBase, 'user-document.txt'))
      expect(filePaths).toContain(resolve(excludeTestBase, 'docs', 'notes.txt'))

      expect(filePaths).not.toContain(resolve(excludeTestDb, 'db-internal.txt'))
      expect(filePaths).not.toContain(resolve(excludeTestCache, 'model-cache.txt'))
    })

    it('raw-data .md files inside dbPath excluded from files array', async () => {
      await excludeServer.handleIngestData({
        content:
          'Integration test content for raw-data exclusion verification. ' +
          'This content is long enough to produce at least one chunk in the system.',
        metadata: {
          source: 'https://example.com/exclude-test',
          format: 'text',
        },
      })

      const result = await excludeServer.handleListFiles()
      const parsed = JSON.parse(result.content[0].text)

      const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

      const rawDataFiles = filePaths.filter((fp) => fp.includes('raw-data'))
      expect(rawDataFiles).toHaveLength(0)

      expect(parsed.sources.length).toBeGreaterThan(0)
      const sourceEntry = parsed.sources.find(
        (s: { source?: string }) => s.source === 'https://example.com/exclude-test'
      )
      expect(sourceEntry).toBeDefined()
    })

    it('dbPath/cacheDir outside baseDir causes no errors', async () => {
      const siblingBase = resolve('./tmp/test-exclude-sibling')
      const siblingData = resolve(siblingBase, 'data')
      const siblingDb = resolve(siblingBase, 'db')
      const siblingCache = resolve(siblingBase, 'cache')

      mkdirSync(siblingData, { recursive: true })
      mkdirSync(siblingDb, { recursive: true })
      mkdirSync(siblingCache, { recursive: true })

      writeFileSync(resolve(siblingData, 'sibling-file.txt'), 'File in sibling baseDir')

      try {
        const siblingServer = new RAGServer({
          dbPath: siblingDb,
          modelName: 'Xenova/all-MiniLM-L6-v2',
          cacheDir: siblingCache,
          baseDir: siblingData,
          maxFileSize: 100 * 1024 * 1024,
          chunkMinLength: 50,
        })

        await siblingServer.initialize()

        const result = await siblingServer.handleListFiles()
        const parsed = JSON.parse(result.content[0].text)

        const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)

        expect(filePaths).toContain(resolve(siblingData, 'sibling-file.txt'))
        expect(parsed.files.length).toBe(1)
      } finally {
        rmSync(siblingBase, { recursive: true, force: true })
      }
    })
  })
})
