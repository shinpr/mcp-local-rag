// RAG MCP Server Integration Test - File Title & Meta JSON Sidecar
// Split from: rag-server.integration.test.ts (File Title Extraction, Meta JSON Sidecar)

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMetaJsonPath, generateRawDataPath } from '../../utils/raw-data-utils.js'
import { RAGServer } from '../index.js'

describe('File Title Extraction Pipeline', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-title')
  const localTestDataDir = resolve('./tmp/test-data-title')

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

  // T-3: Verify ingest_data HTML → fileTitle end-to-end pipeline
  it('ingest_data with HTML content preserves fileTitle in query results', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>RAG Architecture Guide</title></head>
        <body>
          <article>
            <h1>RAG Architecture Guide</h1>
            <p>Retrieval-Augmented Generation combines information retrieval with language model generation to produce accurate and grounded responses.</p>
            <p>This approach helps reduce hallucinations by providing relevant context from a knowledge base.</p>
          </article>
        </body>
      </html>
    `

    // Ingest HTML via ingest_data
    const ingestResult = await localRagServer.handleIngestData({
      content: html,
      metadata: {
        source: 'https://example.com/rag-guide',
        format: 'html',
      },
    })

    const ingestData = JSON.parse(ingestResult.content[0].text)
    expect(ingestData.chunkCount).toBeGreaterThan(0)
    expect(ingestData.fileTitle).toBe('RAG Architecture Guide')

    // Query and verify fileTitle appears in results
    const queryResult = await localRagServer.handleQueryDocuments({
      query: 'RAG retrieval augmented generation',
      limit: 5,
    })

    const results = JSON.parse(queryResult.content[0].text)
    expect(results.length).toBeGreaterThan(0)

    // Verify fileTitle has the exact expected value in search results
    const relevantResult = results.find(
      (r: { fileTitle?: string | null }) => r.fileTitle === 'RAG Architecture Guide'
    )
    expect(relevantResult).toBeDefined()
  })
})

describe('Meta JSON Sidecar Pipeline', () => {
  let localRagServer: RAGServer
  const localTestDbPath = resolve('./tmp/test-lancedb-meta-json')
  const localTestDataDir = resolve('./tmp/test-data-meta-json')

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

  // Test 1: ingest_data HTML creates .meta.json with correct title and format
  it('ingest_data HTML creates .meta.json with correct title and format', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Meta JSON Test Page</title></head>
        <body>
          <article>
            <h1>Meta JSON Test Page</h1>
            <p>This article describes how meta JSON sidecar files work in the RAG pipeline for preserving document metadata.</p>
            <p>The sidecar approach decouples metadata storage from the raw content, enabling clean separation of concerns.</p>
          </article>
        </body>
      </html>
    `

    const ingestResult = await localRagServer.handleIngestData({
      content: html,
      metadata: {
        source: 'https://example.com/meta-json-test',
        format: 'html',
      },
    })

    const ingestData = JSON.parse(ingestResult.content[0].text)
    expect(ingestData.chunkCount).toBeGreaterThan(0)

    // Derive the raw-data .md path and .meta.json path
    const rawDataPath = generateRawDataPath(
      localTestDbPath,
      'https://example.com/meta-json-test',
      'markdown'
    )
    const metaJsonPath = generateMetaJsonPath(rawDataPath)

    // Verify .meta.json exists and has correct content (read raw file, not via loadMetaJson)
    expect(existsSync(metaJsonPath)).toBe(true)
    const metaRaw = JSON.parse(await readFile(metaJsonPath, 'utf-8'))
    expect(metaRaw.title).toBe('Meta JSON Test Page')
    expect(metaRaw.format).toBe('html')
    expect(metaRaw.source).toBe('https://example.com/meta-json-test')
  })

  // Test 2: ingest_data markdown creates .meta.json with title from H1
  it('ingest_data markdown creates .meta.json with title from H1', async () => {
    const markdownContent = [
      '# My Markdown Title',
      '',
      'This is a detailed markdown document that explains the concept of semantic chunking.',
      'Semantic chunking splits text at natural boundaries like paragraphs and sentences.',
      'It produces higher quality chunks than fixed-size approaches.',
    ].join('\n')

    await localRagServer.handleIngestData({
      content: markdownContent,
      metadata: {
        source: 'https://example.com/markdown-meta-test',
        format: 'markdown',
      },
    })

    // Verify .meta.json (read raw file, not via loadMetaJson)
    const rawDataPath = generateRawDataPath(
      localTestDbPath,
      'https://example.com/markdown-meta-test',
      'markdown'
    )
    const metaJsonPath = generateMetaJsonPath(rawDataPath)
    const metaRaw = JSON.parse(await readFile(metaJsonPath, 'utf-8'))
    expect(metaRaw.title).toBe('My Markdown Title')
    expect(metaRaw.format).toBe('markdown')
  })

  // Test 3: ingest_data text creates .meta.json with title from first line
  it('ingest_data text creates .meta.json with title from first line', async () => {
    const textContent = [
      'My Text Document Title',
      '',
      'This is the body of the text document that contains useful information.',
      'The first line followed by a blank line serves as the document title.',
      'This pattern is commonly used in plain text documents.',
    ].join('\n')

    await localRagServer.handleIngestData({
      content: textContent,
      metadata: {
        source: 'https://example.com/text-meta-test',
        format: 'text',
      },
    })

    // Verify .meta.json (read raw file, not via loadMetaJson)
    const rawDataPath = generateRawDataPath(
      localTestDbPath,
      'https://example.com/text-meta-test',
      'markdown'
    )
    const metaJsonPath = generateMetaJsonPath(rawDataPath)
    const metaRaw = JSON.parse(await readFile(metaJsonPath, 'utf-8'))
    expect(metaRaw.title).toBe('My Text Document Title')
    expect(metaRaw.format).toBe('text')
  })

  // Test 4: ingest_data HTML -> query returns correct fileTitle without H1 duplication
  it('ingest_data HTML -> query returns correct fileTitle without H1 duplication', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Duplication Check Title</title></head>
        <body>
          <article>
            <h1>Duplication Check Title</h1>
            <p>Vector embeddings are numerical representations of text that capture semantic meaning in high-dimensional space.</p>
            <p>These embeddings enable efficient similarity search across large document collections.</p>
          </article>
        </body>
      </html>
    `

    await localRagServer.handleIngestData({
      content: html,
      metadata: {
        source: 'https://example.com/duplication-check',
        format: 'html',
      },
    })

    // Query for the content
    const queryResult = await localRagServer.handleQueryDocuments({
      query: 'vector embeddings semantic meaning',
      limit: 5,
    })

    const results = JSON.parse(queryResult.content[0].text)
    expect(results.length).toBeGreaterThan(0)

    // Find results from this specific source
    const rawDataPath = generateRawDataPath(
      localTestDbPath,
      'https://example.com/duplication-check',
      'markdown'
    )
    const relevantResults = results.filter((r: { filePath: string }) => r.filePath === rawDataPath)
    expect(relevantResults.length).toBeGreaterThan(0)

    // Verify fileTitle is set correctly
    for (const result of relevantResults) {
      expect(result.fileTitle).toBe('Duplication Check Title')
      // Verify chunk text does NOT start with "# Duplication Check Title"
      expect(result.text.startsWith('# Duplication Check Title')).toBe(false)
    }

    // Also verify the .md file on disk does not start with "# title\n\n"
    const mdContent = await readFile(rawDataPath, 'utf-8')
    expect(mdContent.startsWith('# Duplication Check Title\n\n')).toBe(false)
  })

  // Test 5: delete_file with source removes both .md and .meta.json
  it('delete_file with source removes both .md and .meta.json', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Delete Test Page</title></head>
        <body>
          <article>
            <h1>Delete Test Page</h1>
            <p>This document will be ingested and then deleted to verify cleanup of sidecar files.</p>
            <p>Both the raw markdown file and the meta JSON sidecar should be removed.</p>
          </article>
        </body>
      </html>
    `

    // Ingest the content
    await localRagServer.handleIngestData({
      content: html,
      metadata: {
        source: 'https://example.com/delete-meta-test',
        format: 'html',
      },
    })

    // Verify files exist before deletion
    const rawDataPath = generateRawDataPath(
      localTestDbPath,
      'https://example.com/delete-meta-test',
      'markdown'
    )
    const metaJsonPath = generateMetaJsonPath(rawDataPath)

    expect(existsSync(rawDataPath)).toBe(true)
    expect(existsSync(metaJsonPath)).toBe(true)

    // Delete by source
    await localRagServer.handleDeleteFile({
      source: 'https://example.com/delete-meta-test',
    })

    // Verify both files are deleted
    expect(existsSync(rawDataPath)).toBe(false)
    expect(existsSync(metaJsonPath)).toBe(false)
  })
})
