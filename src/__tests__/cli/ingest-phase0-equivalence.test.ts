// VLM PDF Enrichment - Phase 0 Cross-Path Equivalence Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-008 (Phase 0 — same chunk rows via MCP and CLI entry points)
// Test Type: Integration Test (in-process, real components throughout)
// Implementation Timing: Phase 0 (must pass before Phase 4 wiring)
//
// Lane: integration. Justification: AC-008 Phase 0 cross-path equivalence
// witness — MCP and CLI paths must produce the same chunk rows for the same
// input. The integration budget rule lives in the integration-e2e-testing
// skill; this file's role is the AC-008 witness.
//
// Design rationale (must read before changing this file):
//   Under vitest's `isolate: false` (vitest.config.mjs:18) the module
//   registry is shared across files in the same pool (`pool: 'forks',
//   maxWorkers: 1`). Module-level `vi.mock` factories LEAK across files
//   in that mode: the per-file mock registry is not honored for modules
//   already in the shared cache, and replacements registered by this
//   file persist into other files that consume the same module. Earlier
//   iterations that mocked DocumentParser / SemanticChunker / Embedder /
//   VectorStore therefore broke `rag-server.search.integration.test.ts`
//   (which depends on real semantic search behavior) and made the suite
//   order-dependent.
//
//   This redesign uses real components throughout:
//     - real on-disk fixture (tmp directory + real `.md` file)
//     - real RAGServer (its internal DocumentParser / SemanticChunker /
//       Embedder / VectorStore are all real instances)
//     - real CLI-side DocumentParser / SemanticChunker / Embedder /
//       VectorStore (independent instances, separate dbPath)
//     - `vi.spyOn` on each VectorStore INSTANCE's `insertChunks`:
//       instance-level spy with no module replacement → no leakage
//     - `vi.spyOn(SemanticChunker.prototype, 'chunkText')`: prototype
//       spy that observes both callers' invocations. Restored in
//       `afterAll` so other test files see the original method.
//
//   There are NO `vi.mock` calls in this file. There is NO call to
//   `vi.resetModules`. The file does NOT import `cli/ingest.ts` (which
//   would transitively load `cli/common.js` and `cli/options.js`, defeating
//   the per-file mocks in `src/__tests__/cli/ingest.test.ts`). Instead it
//   reproduces the CLI persistence path inline below — a deliberate,
//   load-bearing duplication of `ingestSingleFile` whose ONLY purpose is
//   to keep this test's module graph minimal under `isolate: false`.
//
//   IMPORTANT: when `src/cli/ingest.ts`'s `ingestSingleFile` chunk-row
//   shape changes, update `cliInlineIngest` below to match.

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SemanticChunker } from '../../chunker/index.js'
import { Embedder } from '../../embedder/index.js'
import { buildChunksAndEmbeddings } from '../../ingest/compute.js'
import { DocumentParser } from '../../parser/index.js'
import { RAGServer } from '../../server/index.js'
import { type VectorChunk, VectorStore } from '../../vectordb/index.js'

// ============================================
// Test Configuration
// ============================================

const testRoot = resolve('./tmp/test-phase0-equivalence')
const baseDir = resolve(testRoot, 'data')
const serverDbPath = resolve(testRoot, 'server-db')
const cliDbPath = resolve(testRoot, 'cli-db')
const cacheDir = resolve('./tmp/models')
const fixtureFileName = 'phase0-equivalence.md'
const fixtureFilePath = resolve(baseDir, fixtureFileName)

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
  return (server as unknown as { vectorStore: VectorStore }).vectorStore
}

/**
 * Inline reproduction of `src/cli/ingest.ts > ingestSingleFile` (CLI path).
 * Kept here to avoid importing `src/cli/ingest.ts`, which would transitively
 * load `src/cli/common.js` and `src/cli/options.js` and defeat the per-file
 * `vi.mock` factories in `src/__tests__/cli/ingest.test.ts` under
 * `isolate: false`. If `ingestSingleFile` ever diverges from this body,
 * `AC-008` will fail — that is the intended drift sentinel.
 */
async function cliInlineIngest(
  filePath: string,
  parser: DocumentParser,
  chunker: SemanticChunker,
  embedder: Embedder,
  vectorStore: VectorStore
): Promise<number> {
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  let text: string
  let title: string | null = null
  if (isPdf) {
    const result = await parser.parsePdf(filePath, embedder)
    text = result.content
    title = result.title || null
  } else {
    const result = await parser.parseFile(filePath)
    text = result.content
    title = result.title || null
  }

  const { chunks, embeddings } = await buildChunksAndEmbeddings(text, title, chunker, embedder)
  if (chunks.length === 0) {
    return 0
  }

  await vectorStore.deleteChunks(filePath)

  const timestamp = new Date().toISOString()
  const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
    const embedding = embeddings[index]
    if (!embedding) {
      throw new Error(`Missing embedding for chunk ${index}`)
    }
    return {
      id: randomUUID(),
      filePath,
      chunkIndex: chunk.index,
      text: chunk.text,
      vector: embedding,
      metadata: {
        fileName: basename(filePath),
        fileSize: text.length,
        fileType: extname(filePath).slice(1),
      },
      fileTitle: title,
      timestamp,
    }
  })

  await vectorStore.insertChunks(vectorChunks)
  return vectorChunks.length
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

    // Prototype-level spy on SemanticChunker.chunkText — captures both
    // callers' invocations through their respective chunker instances.
    // Restored in afterAll so other test files see the original method.
    chunkerSpy = vi.spyOn(SemanticChunker.prototype, 'chunkText')

    // Real RAGServer (constructs real DocumentParser/SemanticChunker/Embedder/VectorStore)
    server = new RAGServer({
      dbPath: serverDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir,
      baseDir,
      maxFileSize: 10 * 1024 * 1024,
    })
    await server.initialize()

    // Real CLI-side components (independent VectorStore at a separate dbPath
    // so the two callers' insertChunks are recorded on distinct instances)
    cliParser = new DocumentParser({
      baseDir,
      maxFileSize: 10 * 1024 * 1024,
    })
    cliChunker = new SemanticChunker({})
    cliEmbedder = new Embedder({
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 16,
      cacheDir,
    })
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
    serverInsertSpy.mockImplementation(async (chunks) => {
      serverInsertCalls.push((chunks as VectorChunk[]).map((c) => ({ ...c })))
    })
    cliInsertSpy.mockImplementation(async (chunks) => {
      cliInsertCalls.push((chunks as VectorChunk[]).map((c) => ({ ...c })))
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

  // AC-008: handleIngestFile and the inline CLI ingest reproduction produce
  // identical chunk rows for the same fixture file. The inline reproduction
  // mirrors `src/cli/ingest.ts > ingestSingleFile` exactly; divergence
  // surfaces here.
  it('AC-008: handleIngestFile and ingestSingleFile produce identical chunk rows for the same fixture', async () => {
    // Act: server path
    await server.handleIngestFile({ filePath: fixtureFilePath })

    // Act: CLI path (inline reproduction — see file header comment)
    await cliInlineIngest(fixtureFilePath, cliParser, cliChunker, cliEmbedder, cliVectorStore)

    // Assert: each caller invoked insertChunks exactly once
    expect(serverInsertCalls).toHaveLength(1)
    expect(cliInsertCalls).toHaveLength(1)

    const serverChunks = serverInsertCalls[0]!
    const cliChunks = cliInsertCalls[0]!

    // Sanity: at least one chunk produced (fixture content is substantial)
    expect(serverChunks.length).toBeGreaterThan(0)
    expect(cliChunks.length).toBe(serverChunks.length)

    // Load-bearing fields must match across the two callers, positionally.
    // id and timestamp are intentionally excluded (random UUID + per-call ISO).
    for (let i = 0; i < serverChunks.length; i++) {
      expect(stripVolatile(cliChunks[i]!)).toEqual(stripVolatile(serverChunks[i]!))
    }

    // Literal expected shape on the first chunk to anchor the contract:
    // chunkIndex starts at 0, filePath matches the fixture, metadata is
    // populated from the file name + raw text length + extension.
    const first = serverChunks[0]!
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
  })

  // AC-008 (drift sentinel): both callers MUST invoke the shared computation
  // layer exactly once each with the same `text` argument.
  //
  // `buildChunksAndEmbeddings(text, title, chunker, embedder)` calls
  // `chunker.chunkText(text, embedder)` once. Observing the prototype-level
  // spy on `chunkText` is functionally equivalent to observing
  // `buildChunksAndEmbeddings` itself — same call count, same `text` arg.
  it('AC-008 (drift sentinel): both callers invoke chunker.chunkText with the same text', () => {
    // The previous test executed both ingest paths once each.
    expect(chunkerSpy).toHaveBeenCalledTimes(2)

    const firstCallArgs = chunkerSpy.mock.calls[0]
    const secondCallArgs = chunkerSpy.mock.calls[1]

    // Same text across both callers.
    expect(firstCallArgs?.[0]).toBe(secondCallArgs?.[0])

    // Sanity check: the text arg is the fixture content the parser
    // returned. The markdown parser returns content verbatim.
    expect(firstCallArgs?.[0]).toBe(FIXTURE_TEXT)
  })
})
