// Cross-entry integration proof for VLM enrichment AC-008. Both paths use real
// parser, chunker, embedder, and VectorStore instances; only instance methods are
// spied so the shared Vitest module registry is not replaced.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SemanticChunker } from '../../chunker/index.js'
import { ingestSingleFile } from '../../cli/ingest.js'
import { Embedder } from '../../embedder/index.js'
import { DocumentParser } from '../../parser/index.js'
import { RAGServer } from '../../server/index.js'
import { type VectorChunk, VectorStore } from '../../vectordb/index.js'
import { buildDocxFixture, headingXml, tableXml } from '../docx-fixture.js'
import { withTestDevice } from '../test-device.js'
import { expectDefined, privateMembers } from '../test-doubles.js'

// ============================================
// Test Configuration
// ============================================

const testRoot = resolve('./tmp/test-cross-path-equivalence')
const baseDir = resolve(testRoot, 'data')
const serverDbPath = resolve(testRoot, 'server-db')
const cliDbPath = resolve(testRoot, 'cli-db')
const cacheDir = resolve('./tmp/models')
const fixtureFileName = 'cross-path-equivalence.md'
const fixtureFilePath = resolve(baseDir, fixtureFileName)
const docxFixtureFileName = 'issue-176-equivalence.docx'
const docxFixtureFilePath = resolve(baseDir, docxFixtureFileName)
const DOCX_TITLE = 'DOCX Field Reference'
const DOCX_VALUES = [
  '42',
  'Retry Policy Identifier',
  'Optional',
  'Integer(11)',
  'First sentence. Second sentence.',
] as const
const DOCX_ROW_TEXT = [
  'Field No.: 42',
  'Field Name: Retry Policy Identifier',
  'Required: Optional',
  'Type: Integer(11)',
  'Description: First sentence. Second sentence.',
].join('\n')
const DOCX_EXPECTED_CONTENT = `Heading Fallback\n\n${DOCX_ROW_TEXT}`
const DOCX_EXPECTED_RANGES = [
  {
    start: 'Heading Fallback\n\n'.length,
    end: DOCX_EXPECTED_CONTENT.length,
  },
] as const

// Substantial content guarantees the SemanticChunker produces >=1 chunk
// even with the default minChunkLength (50 chars). Using the same content
// for both callers is the load-bearing equivalence condition.
const FIXTURE_TEXT = [
  '# Phase 0 Equivalence Fixture',
  '',
  'TypeScript is a strongly typed programming language that builds on JavaScript.',
  'TypeScript adds optional static typing to JavaScript at compile time.',
  'TypeScript helps catch type errors before the code runs in production.',
  'TypeScript is widely used in modern web application development today.',
  'TypeScript supports interfaces, generics, and other advanced language features.',
].join('\n')

/**
 * Strip per-call non-deterministic fields (id, timestamp) so two VectorChunk
 * arrays can be compared for equivalence on the load-bearing fields.
 */
function stripVolatile(chunk: VectorChunk): Omit<VectorChunk, 'id' | 'timestamp'> {
  const { id: _id, timestamp: _timestamp, ...rest } = chunk
  return rest
}

/**
 * Access the private vectorStore on a RAGServer instance.
 * Mirrors the pattern in `rag-server.read-neighbors.integration.test.ts`.
 */
function getServerVectorStore(server: RAGServer): VectorStore {
  return privateMembers<{ vectorStore: VectorStore }>(server).vectorStore
}

// ============================================
// Tests
// ============================================

describe('VLM PDF Enrichment - Phase 0 Equivalence (AC-008)', () => {
  let server: RAGServer
  let cliParser: DocumentParser
  let cliChunker: SemanticChunker
  let cliEmbedder: Embedder
  let cliVectorStore: VectorStore
  let chunkerSpy: ReturnType<typeof vi.spyOn>
  let serverInsertSpy: ReturnType<typeof vi.spyOn>
  let cliInsertSpy: ReturnType<typeof vi.spyOn>
  const serverInsertCalls: VectorChunk[][] = []
  const cliInsertCalls: VectorChunk[][] = []

  beforeAll(async () => {
    // Real filesystem fixture
    rmSync(testRoot, { recursive: true, force: true })
    mkdirSync(baseDir, { recursive: true })
    mkdirSync(serverDbPath, { recursive: true })
    mkdirSync(cliDbPath, { recursive: true })
    writeFileSync(fixtureFilePath, FIXTURE_TEXT)
    writeFileSync(
      docxFixtureFilePath,
      await buildDocxFixture({
        coreTitle: DOCX_TITLE,
        bodyXml: `${headingXml('Heading Fallback')}${tableXml([
          ['Field No.', 'Field Name', 'Required', 'Type', 'Description'],
          DOCX_VALUES,
        ])}`,
      })
    )

    // Prototype-level spy on SemanticChunker.chunkText — captures both
    // callers' invocations through their respective chunker instances.
    // Restored in afterAll so other test files see the original method.
    chunkerSpy = vi.spyOn(SemanticChunker.prototype, 'chunkText')

    // Real RAGServer (constructs real DocumentParser/SemanticChunker/Embedder/VectorStore)
    server = new RAGServer(
      withTestDevice({
        dbPath: serverDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir,
        baseDir,
        maxFileSize: 10 * 1024 * 1024,
      })
    )
    await server.initialize()

    // Real CLI-side components (independent VectorStore at a separate dbPath
    // so the two callers' insertChunks are recorded on distinct instances)
    cliParser = new DocumentParser({
      baseDir,
      maxFileSize: 10 * 1024 * 1024,
    })
    cliChunker = new SemanticChunker({})
    cliEmbedder = new Embedder(
      withTestDevice({
        modelPath: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 16,
        cacheDir,
      })
    )
    cliVectorStore = new VectorStore({
      dbPath: cliDbPath,
      tableName: 'chunks',
    })
    await cliVectorStore.initialize()

    // Instance-level spies — no module replacement, no cross-file leakage.
    // We copy the inserted-chunks payload at call time because the spy
    // records argument references and LanceDB may mutate the arrays it
    // receives.
    serverInsertSpy = vi.spyOn(getServerVectorStore(server), 'insertChunks')
    cliInsertSpy = vi.spyOn(cliVectorStore, 'insertChunks')
    serverInsertSpy.mockImplementation(async (chunks: VectorChunk[]) => {
      serverInsertCalls.push(chunks.map((c) => ({ ...c })))
    })
    cliInsertSpy.mockImplementation(async (chunks: VectorChunk[]) => {
      cliInsertCalls.push(chunks.map((c) => ({ ...c })))
    })

    // Clear any incidental chunker invocations done during construction.
    chunkerSpy.mockClear()
  }, 180_000)

  afterAll(async () => {
    chunkerSpy?.mockRestore()
    serverInsertSpy?.mockRestore()
    cliInsertSpy?.mockRestore()
    rmSync(testRoot, { recursive: true, force: true })
  })

  // AC-008: the MCP handler and actual CLI ingestion operation produce the same
  // persistable rows for the same input.
  it('AC-008: keeps Markdown chunks equivalent and preserves literal parser text', async () => {
    serverInsertCalls.length = 0
    cliInsertCalls.length = 0
    chunkerSpy.mockClear()

    // Act: server path
    await server.handleIngestFile({ filePath: fixtureFilePath })

    // Act: CLI path
    await ingestSingleFile(fixtureFilePath, {
      parser: cliParser,
      chunker: cliChunker,
      embedder: cliEmbedder,
      vectorStore: cliVectorStore,
    })

    // Assert: each caller invoked insertChunks exactly once
    expect(serverInsertCalls).toHaveLength(1)
    expect(cliInsertCalls).toHaveLength(1)

    const serverChunks = expectDefined(serverInsertCalls[0])
    const cliChunks = expectDefined(cliInsertCalls[0])

    // Sanity: at least one chunk produced (fixture content is substantial)
    expect(serverChunks.length).toBeGreaterThan(0)
    expect(cliChunks.length).toBe(serverChunks.length)

    // Load-bearing fields must match across the two callers, positionally.
    // id and timestamp are intentionally excluded (random UUID + per-call ISO).
    for (let i = 0; i < serverChunks.length; i++) {
      expect(stripVolatile(expectDefined(cliChunks[i]))).toEqual(
        stripVolatile(expectDefined(serverChunks[i]))
      )
    }

    // Literal expected shape on the first chunk to anchor the contract:
    // chunkIndex starts at 0, filePath matches the fixture, metadata is
    // populated from the file name + raw text length + extension.
    const first = expectDefined(serverChunks[0])
    expect(first.filePath).toBe(fixtureFilePath)
    expect(first.chunkIndex).toBe(0)
    expect(typeof first.text).toBe('string')
    expect(first.text.length).toBeGreaterThan(0)
    expect(Array.isArray(first.vector)).toBe(true)
    expect(first.vector.length).toBeGreaterThan(0)
    expect(first.metadata).toEqual({
      fileName: fixtureFileName,
      fileSize: FIXTURE_TEXT.length,
      fileType: 'md',
    })
    expect(typeof first.fileTitle === 'string' || first.fileTitle === null).toBe(true)

    expect(chunkerSpy).toHaveBeenCalledTimes(2)
    expect(chunkerSpy.mock.calls[0]?.[0]).toBe(FIXTURE_TEXT)
    expect(chunkerSpy.mock.calls[1]?.[0]).toBe(FIXTURE_TEXT)
  })

  it('keeps literal DOCX text, title, atomic ranges, and persisted chunks equivalent across MCP and CLI', async () => {
    serverInsertCalls.length = 0
    cliInsertCalls.length = 0
    chunkerSpy.mockClear()

    await server.handleIngestFile({ filePath: docxFixtureFilePath })
    await ingestSingleFile(docxFixtureFilePath, {
      parser: cliParser,
      chunker: cliChunker,
      embedder: cliEmbedder,
      vectorStore: cliVectorStore,
    })

    expect(serverInsertCalls).toHaveLength(1)
    expect(cliInsertCalls).toHaveLength(1)
    const serverChunks = expectDefined(serverInsertCalls[0])
    const cliChunks = expectDefined(cliInsertCalls[0])
    expect(cliChunks.map(stripVolatile)).toEqual(serverChunks.map(stripVolatile))

    const rowChunk = serverChunks.find((chunk) =>
      DOCX_VALUES.every((value) => chunk.text.includes(value))
    )
    expect(rowChunk).toBeDefined()
    expect(rowChunk?.fileTitle).toBe(DOCX_TITLE)
    expect(chunkerSpy).toHaveBeenCalledTimes(2)
    expect(chunkerSpy.mock.calls[0]?.[0]).toBe(DOCX_EXPECTED_CONTENT)
    expect(chunkerSpy.mock.calls[1]?.[0]).toBe(DOCX_EXPECTED_CONTENT)
    expect(chunkerSpy.mock.calls[0]?.[2]).toEqual(DOCX_EXPECTED_RANGES)
    expect(chunkerSpy.mock.calls[1]?.[2]).toEqual(DOCX_EXPECTED_RANGES)
  }, 180_000)
})
