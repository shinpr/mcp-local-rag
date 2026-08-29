// In-process integration coverage for complete ingest, search, and re-ingest flows.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import { RAGServer } from '../index.js'

describe('RAGServer workflow integration', () => {
  describe('text-file ingestion and search', () => {
    it('ingests a text file and retrieves it for a related query', async () => {
      // 1. Start MCP server (test case dedicated)
      const testDbPath = resolve('./tmp/e2e-lancedb-test1')
      const testDataDir = resolve('./tmp/e2e-data-test1')
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })

      const ragServer = new RAGServer(
        withTestDevice({
          dbPath: testDbPath,
          modelName: 'Xenova/all-MiniLM-L6-v2',
          cacheDir: testModelCacheDir(),
          baseDir: testDataDir,
          maxFileSize: 100 * 1024 * 1024,
        })
      )
      await ragServer.initialize()

      try {
        // 2. Ingest TXT file (using TXT for testing since PDF parser requires actual PDF)
        const txtFile = resolve(testDataDir, 'sample-pdf.txt')
        writeFileSync(
          txtFile,
          'This is a sample document for integration testing. TypeScript type safety is important. ' +
            'TypeScript provides better tooling at any scale. ' +
            'TypeScript is a strongly typed programming language.'
        )

        const ingestResult = await ragServer.handleIngestFile({ filePath: txtFile })
        const ingestData = JSON.parse(ingestResult.content[0].text)
        expect(ingestData.chunkCount).toBeGreaterThan(0)
        expect(ingestData.filePath).toBe(txtFile)

        // 3. Search with natural language query
        const queryResult = await ragServer.handleQueryDocuments({
          query: 'TypeScript type safety',
          limit: 5,
        })
        const results = JSON.parse(queryResult.content[0].text)

        // 4. Verify related document retrieval
        expect(results.length).toBeGreaterThan(0)
        expect(results[0]).toHaveProperty('filePath')
        expect(results[0]).toHaveProperty('text')
        expect(results[0]).toHaveProperty('score')
        expect(results[0]).toHaveProperty('chunkIndex')

        // 5. Verify score ordering (ascending, LanceDB uses distance scores)
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i].score).toBeLessThanOrEqual(results[i + 1].score)
        }
      } finally {
        // Cleanup
        await ragServer.close()
        rmSync(testDbPath, { recursive: true, force: true })
        rmSync(testDataDir, { recursive: true, force: true })
      }
    })
  })

  describe('DOCX ingestion and replacement', () => {
    it('ingests a DOCX file and retrieves it for a related query', async () => {
      // 1. Start MCP server (test case dedicated)
      const testDbPath = resolve('./tmp/e2e-lancedb-test2')
      const testDataDir = resolve('./tmp/e2e-data-test2')
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })

      const ragServer = new RAGServer(
        withTestDevice({
          dbPath: testDbPath,
          modelName: 'Xenova/all-MiniLM-L6-v2',
          cacheDir: testModelCacheDir(),
          baseDir: testDataDir,
          maxFileSize: 100 * 1024 * 1024,
        })
      )
      await ragServer.initialize()

      try {
        // 2. Ingest valid DOCX file from fixtures
        const fixtureDocx = resolve('./tests/fixtures/sample-e2e.docx')
        const docxFile = resolve(testDataDir, 'sample.docx')
        copyFileSync(fixtureDocx, docxFile)

        const ingestResult = await ragServer.handleIngestFile({ filePath: docxFile })
        const ingestData = JSON.parse(ingestResult.content[0].text)
        expect(ingestData.chunkCount).toBeGreaterThan(0)

        // 3. Search with natural language query
        const queryResult = await ragServer.handleQueryDocuments({
          query: 'project management',
          limit: 5,
        })
        const results = JSON.parse(queryResult.content[0].text)

        // 4. Verify related document retrieval
        expect(results.length).toBeGreaterThan(0)
        expect(results[0].filePath).toContain('sample.docx')
      } finally {
        // Cleanup
        await ragServer.close()
        rmSync(testDbPath, { recursive: true, force: true })
        rmSync(testDataDir, { recursive: true, force: true })
      }
    })

    it('replaces indexed content when the same file is ingested again', async () => {
      // 1. Start MCP server (test case dedicated)
      const testDbPath = resolve('./tmp/e2e-lancedb-test3')
      const testDataDir = resolve('./tmp/e2e-data-test3')
      mkdirSync(testDbPath, { recursive: true })
      mkdirSync(testDataDir, { recursive: true })

      const ragServer = new RAGServer(
        withTestDevice({
          dbPath: testDbPath,
          modelName: 'Xenova/all-MiniLM-L6-v2',
          cacheDir: testModelCacheDir(),
          baseDir: testDataDir,
          maxFileSize: 100 * 1024 * 1024,
        })
      )
      await ragServer.initialize()

      try {
        // 2. Initial file ingestion (old content: "TypeScript")
        const v1File = resolve(testDataDir, 'sample-v1.txt')
        writeFileSync(
          v1File,
          'TypeScript is a strongly typed programming language that builds on JavaScript. It provides better tooling at any scale.'
        )
        await ragServer.handleIngestFile({ filePath: v1File })

        // 3. Verify search with old content
        const queryResult1 = await ragServer.handleQueryDocuments({
          query: 'TypeScript',
          limit: 5,
        })
        const results1 = JSON.parse(queryResult1.content[0].text)
        expect(results1.length).toBeGreaterThan(0)

        // 4. Update file (new content: "JavaScript")
        writeFileSync(
          v1File,
          'JavaScript is a versatile programming language for web development. JavaScript provides dynamic features and flexibility.'
        )

        // 5. Re-ingest file
        await ragServer.handleIngestFile({ filePath: v1File })

        // 6. Verify search with new content
        const queryResult2 = await ragServer.handleQueryDocuments({
          query: 'JavaScript',
          limit: 5,
        })
        const results2 = JSON.parse(queryResult2.content[0].text)
        expect(results2.length).toBeGreaterThan(0)

        // 7. Verify old content not included in search results
        // Check file list to confirm sample-v1.txt exists only once (no duplicates)
        const listResult = await ragServer.handleListFiles()
        const files = JSON.parse(listResult.content[0].text)
        const targetFiles = files.files.filter((f: { filePath: string }) => f.filePath === v1File)

        // Validation: File exists only once (no duplicates)
        expect(targetFiles.length).toBe(1)

        // Validation: Chunk count exists (chunks after re-ingestion)
        expect(targetFiles[0].chunkCount).toBeGreaterThan(0)

        // 8. Search with new content and verify old content is not included
        const queryResult3 = await ragServer.handleQueryDocuments({
          query: 'JavaScript versatile programming',
          limit: 5,
        })
        const results3 = JSON.parse(queryResult3.content[0].text)

        // Verify sample-v1.txt is included in search results for new content "JavaScript is a versatile"
        expect(results3.length).toBeGreaterThan(0)
        const targetResult = results3.find((r: { filePath: string }) => r.filePath === v1File)
        expect(targetResult).toBeDefined()

        // Verify new content "JavaScript is a versatile" is included
        expect(targetResult.text).toContain('JavaScript')

        // Verify old content "TypeScript is a strongly typed" is not included
        expect(targetResult.text).not.toContain('TypeScript is a strongly typed')
      } finally {
        // Cleanup
        await ragServer.close()
        rmSync(testDbPath, { recursive: true, force: true })
        rmSync(testDataDir, { recursive: true, force: true })
      }
    })
  })
})
