// ingest_data Tool Test
// Test Type: Integration Test
// Tests handleIngestData functionality including HTML parsing and raw-data storage

import { mkdir, readFile, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../../server/index.js'

// ============================================
// Test Configuration
// ============================================

const testDbPath = './tmp/test-ingest-data-db'
const testConfig = {
  dbPath: testDbPath,
  modelName: 'Xenova/all-MiniLM-L6-v2',
  cacheDir: './tmp/test-model-cache',
  baseDir: '.',
  maxFileSize: 10 * 1024 * 1024,
}

// ============================================
// Tests
// ============================================

describe('ingest_data Tool', () => {
  let server: RAGServer

  beforeAll(async () => {
    await mkdir(testDbPath, { recursive: true })
    await mkdir(testConfig.cacheDir, { recursive: true })
    server = new RAGServer(testConfig)
    await server.initialize()
  }, 120000) // 2 minutes for model download

  afterAll(async () => {
    await rm(testDbPath, { recursive: true, force: true })
  })

  // --------------------------------------------
  // Text Format Ingestion
  // --------------------------------------------
  describe('Text Format Ingestion', () => {
    it('ingests plain text content', async () => {
      const content = 'This is plain text content for testing the ingest_data tool.'
      const source = 'test://plain-text-test'

      const result = await server.handleIngestData({
        content,
        metadata: {
          source,
          format: 'text',
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.chunkCount).toBeGreaterThan(0)
      expect(parsed.filePath).toContain('raw-data')
      expect(parsed.filePath).toMatch(/\.md$/) // All formats use .md extension
    })

    it('saves raw text to raw-data directory', async () => {
      const content = 'Content to verify file saving functionality.'
      const source = 'test://file-save-test'

      const result = await server.handleIngestData({
        content,
        metadata: {
          source,
          format: 'text',
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      const savedContent = await readFile(parsed.filePath, 'utf-8')
      expect(savedContent).toBe(content)
    })
  })

  // --------------------------------------------
  // Markdown Format Ingestion
  // --------------------------------------------
  describe('Markdown Format Ingestion', () => {
    it('ingests markdown content', async () => {
      const content = `# Heading

This is markdown content with **bold** and _italic_ text.

## Subheading

- List item 1
- List item 2
`
      const source = 'test://markdown-test'

      const result = await server.handleIngestData({
        content,
        metadata: {
          source,
          format: 'markdown',
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.chunkCount).toBeGreaterThan(0)
      expect(parsed.filePath).toMatch(/\.md$/)
    })
  })

  // --------------------------------------------
  // HTML Format Ingestion
  // --------------------------------------------
  describe('HTML Format Ingestion', () => {
    it('ingests HTML content and converts to markdown', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <h1>Test Article</h1>
              <p>This is the main content of the test article. It contains enough text for Readability to extract properly.</p>
            </article>
          </body>
        </html>
      `
      const source = 'https://example.com/test-article'

      const result = await server.handleIngestData({
        content: html,
        metadata: {
          source,
          format: 'html',
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.chunkCount).toBeGreaterThan(0)
      // HTML is converted to markdown, so saved as .md
      expect(parsed.filePath).toMatch(/\.md$/)
    })

    it('extracts main content from HTML and removes noise', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <nav><a href="/">Home</a><a href="/about">About</a></nav>
            <article>
              <h1>Main Article Title</h1>
              <p>This is the main content that should be extracted. It needs to be long enough for Readability to identify as primary content.</p>
            </article>
            <footer><p>Copyright 2024</p></footer>
          </body>
        </html>
      `
      const source = 'https://example.com/noise-test'

      const result = await server.handleIngestData({
        content: html,
        metadata: {
          source,
          format: 'html',
        },
      })

      const parsed = JSON.parse(result.content[0].text)
      const savedContent = await readFile(parsed.filePath, 'utf-8')

      // Main content should be present
      expect(savedContent).toContain('Main Article Title')
      expect(savedContent).toContain('main content that should be extracted')
    })

    it('throws error for HTML with no extractable content', async () => {
      const html = '<html><body></body></html>'
      const source = 'https://example.com/empty-html'

      await expect(
        server.handleIngestData({
          content: html,
          metadata: {
            source,
            format: 'html',
          },
        })
      ).rejects.toThrow('Failed to extract content from HTML')
    })
  })

  // --------------------------------------------
  // Source Normalization
  // --------------------------------------------
  describe('Source Normalization', () => {
    it('normalizes URL sources (removes query string)', async () => {
      const content = 'Test content for URL normalization'
      const source1 = 'https://example.com/page?utm_source=google'
      const source2 = 'https://example.com/page?tracking=xyz'

      const result1 = await server.handleIngestData({
        content,
        metadata: { source: source1, format: 'text' },
      })
      const result2 = await server.handleIngestData({
        content: 'Updated content',
        metadata: { source: source2, format: 'text' },
      })

      const parsed1 = JSON.parse(result1.content[0].text)
      const parsed2 = JSON.parse(result2.content[0].text)

      // Same normalized source should result in same file path
      expect(parsed1.filePath).toBe(parsed2.filePath)
    })
  })

  // --------------------------------------------
  // Re-ingestion (Update)
  // --------------------------------------------
  describe('Re-ingestion', () => {
    it('updates existing content when re-ingesting same source', async () => {
      const source = 'test://update-test'

      // Initial ingestion
      await server.handleIngestData({
        content: 'Original content',
        metadata: { source, format: 'text' },
      })

      // Re-ingestion with updated content
      const result = await server.handleIngestData({
        content: 'Updated content after re-ingestion',
        metadata: { source, format: 'text' },
      })

      const parsed = JSON.parse(result.content[0].text)
      const savedContent = await readFile(parsed.filePath, 'utf-8')

      expect(savedContent).toBe('Updated content after re-ingestion')
      expect(savedContent).not.toContain('Original')
    })
  })

  // --------------------------------------------
  // List Files with Source Info
  // --------------------------------------------
  describe('List Files with Source Info', () => {
    it('list_files includes source for raw-data files', async () => {
      const source = 'https://example.com/list-files-test'
      // Content needs to be long enough to generate at least one chunk
      const content =
        'This is a longer content for testing the list files functionality. ' +
        'It needs to be substantial enough to create at least one chunk. ' +
        'The semantic chunker requires sufficient content to process properly.'

      await server.handleIngestData({
        content,
        metadata: { source, format: 'text' },
      })

      const listResult = await server.handleListFiles()
      const files = JSON.parse(listResult.content[0].text)

      // Find the specific file we just ingested by source
      const targetFile = files.find(
        (f: { filePath: string; source?: string }) => f.source === source
      )
      expect(targetFile).toBeDefined()
      expect(targetFile.filePath).toContain('raw-data')
    })

    it('list_files does not include source for regular files', async () => {
      // Regular files (not raw-data) should not have source field
      // This is tested implicitly - if filePath doesn't contain 'raw-data',
      // the source field should be undefined
      const listResult = await server.handleListFiles()
      const files = JSON.parse(listResult.content[0].text)

      for (const file of files) {
        if (!file.filePath.includes('raw-data')) {
          expect(file.source).toBeUndefined()
        }
      }
    })
  })

  // --------------------------------------------
  // Delete File with Physical File Removal
  // --------------------------------------------
  describe('Delete File with Physical File Removal', () => {
    it('delete_file removes physical raw-data file', async () => {
      const source = 'https://example.com/delete-physical-test'
      const content =
        'Content for testing physical file deletion. ' +
        'This needs to be long enough to create chunks for the test to work properly.'

      // Ingest the data
      const ingestResult = await server.handleIngestData({
        content,
        metadata: { source, format: 'text' },
      })
      const parsed = JSON.parse(ingestResult.content[0].text)
      const filePath = parsed.filePath

      // Verify file exists
      const { stat } = await import('node:fs/promises')
      await expect(stat(filePath)).resolves.toBeDefined()

      // Delete via handleDeleteFile
      await server.handleDeleteFile({ filePath })

      // Verify physical file is deleted
      await expect(stat(filePath)).rejects.toThrow('ENOENT')
    })

    it('delete_file handles missing raw-data file gracefully', async () => {
      const source = 'https://example.com/delete-missing-test'
      const content =
        'Content for testing missing file handling. ' +
        'This needs to be long enough to create chunks for the test to work properly.'

      // Ingest the data
      const ingestResult = await server.handleIngestData({
        content,
        metadata: { source, format: 'text' },
      })
      const parsed = JSON.parse(ingestResult.content[0].text)
      const filePath = parsed.filePath

      // Manually delete the file first
      const { unlink } = await import('node:fs/promises')
      await unlink(filePath)

      // Delete via handleDeleteFile should not throw
      await expect(server.handleDeleteFile({ filePath })).resolves.toBeDefined()
    })

    it('delete_file accepts source parameter to delete raw-data', async () => {
      const source = 'https://example.com/delete-by-source-test'
      const content =
        'Content for testing deletion by source parameter. ' +
        'This needs to be long enough to create chunks for the test to work properly.'

      // Ingest the data
      await server.handleIngestData({
        content,
        metadata: { source, format: 'text' },
      })

      // Verify it's in list_files
      const listBefore = await server.handleListFiles()
      const filesBefore = JSON.parse(listBefore.content[0].text)
      const targetBefore = filesBefore.find((f: { source?: string }) => f.source === source)
      expect(targetBefore).toBeDefined()

      // Delete by source
      const deleteResult = await server.handleDeleteFile({ source })
      const deleteData = JSON.parse(deleteResult.content[0].text)
      expect(deleteData.deleted).toBe(true)

      // Verify it's removed from list_files
      const listAfter = await server.handleListFiles()
      const filesAfter = JSON.parse(listAfter.content[0].text)
      const targetAfter = filesAfter.find((f: { source?: string }) => f.source === source)
      expect(targetAfter).toBeUndefined()
    })

    it('delete_file throws error when neither filePath nor source provided', async () => {
      await expect(server.handleDeleteFile({})).rejects.toThrow(
        'Either filePath or source must be provided'
      )
    })
  })

  // --------------------------------------------
  // Query Integration
  // --------------------------------------------
  describe('Query Integration', () => {
    it('ingested data is searchable via query_documents', async () => {
      const uniqueContent = 'UniqueSearchableContent12345 for integration testing'
      const source = 'test://query-integration-test'

      await server.handleIngestData({
        content: uniqueContent,
        metadata: { source, format: 'text' },
      })

      const queryResult = await server.handleQueryDocuments({
        query: 'UniqueSearchableContent12345',
        limit: 5,
      })

      const results = JSON.parse(queryResult.content[0].text)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].text).toContain('UniqueSearchableContent12345')
    })

    it('query results include source for raw-data files', async () => {
      const source = 'https://example.com/source-restoration-test'
      const content = 'SourceRestorationTestContent98765 unique marker for this test'

      await server.handleIngestData({
        content,
        metadata: { source, format: 'text' },
      })

      const queryResult = await server.handleQueryDocuments({
        query: 'SourceRestorationTestContent98765',
        limit: 10,
      })

      const results = JSON.parse(queryResult.content[0].text)
      expect(results.length).toBeGreaterThan(0)

      // Find the result that contains our specific content
      const targetResult = results.find((r: { text: string; source?: string }) =>
        r.text.includes('SourceRestorationTestContent98765')
      )
      expect(targetResult).toBeDefined()
      // Source should be restored from file path
      expect(targetResult.source).toBe(source)
    })
  })
})
