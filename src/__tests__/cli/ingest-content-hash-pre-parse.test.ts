// Test Type: Integration — real filesystem fixture under the gitignored
// project-root `tmp/`, `ingestSingleFile` wired to structural stubs, a real
// `DocumentParser` for the boundary cases, and the real sync core (`runSync`)
// deciding what a later sync does with the stored hash.
//
// Why this file exists: `contentHash` used to come from a second read taken after
// parsing, chunking, and embedding, while the chunks came from the parser's read.
// Embedding a document takes seconds, so an editor saving inside that window left
// the index serving the old content under the new content's hash — and the next
// sync then saw `disk hash == stored hash`, skipped the file, and the index stayed
// wrong permanently. The hash is now taken before the parse, so a modification
// during ingestion makes the stored hash OLDER than the disk bytes and the next
// sync re-ingests: fail dirty, never fail clean. Being first also means nothing
// else guards that read any more, so the checks that must precede it — containment
// and size — are pinned here as well.
//
// Mock isolation: `node:fs/promises` is imported across the codebase, so the
// wrapper is installed with `vi.doMock` in `beforeAll` and removed with
// `vi.doUnmock` + `vi.resetModules` in `afterAll`, with the production modules
// imported dynamically afterwards (see `.claude/skills/project-context/SKILL.md`
// § Test Environment Constraints). It delegates every call to the real module and
// only records which paths `readFile` was given, which is how "no byte read
// happened" becomes observable. This file's own fixture I/O uses `node:fs`, so it
// never enters that record.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SemanticChunker } from '../../chunker/index.js'
import type { Embedder } from '../../embedder/index.js'
import type { SyncCollaborators } from '../../features/sync.js'
import type { DocumentParser } from '../../parser/index.js'
import type { VectorChunk, VectorStore } from '../../vectordb/index.js'

// ============================================
// Mock setup (scoped doMock — see header)
// ============================================

/** Every path handed to the production `readFile`, in call order. */
const readPaths: string[] = []

const fsPromisesFactory = async (
  importOriginal: () => Promise<typeof import('node:fs/promises')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readPaths.push(String(args[0]))
      return actual.readFile(...args)
    },
  }
}

const MOCKED_PATHS = ['node:fs/promises'] as const

let ingestSingleFile: typeof import('../../cli/ingest.js').ingestSingleFile
let runSync: typeof import('../../features/sync.js').runSync
let DocumentParserClass: typeof import('../../parser/index.js').DocumentParser

// ============================================
// Fixtures
// ============================================

const TMP_ROOT = resolve('./tmp/test-ingest-content-hash-pre-parse')
const DOCS_DIR = join(TMP_ROOT, 'docs')
const REPORT_PATH = join(DOCS_DIR, 'report.md')

/** Bytes on disk when ingestion starts, and what the chunks are built from. */
const CONTENT_BEFORE = 'Content as the parser read it.\n'
/** Bytes an editor writes while the embeddings are being computed. */
const CONTENT_AFTER = 'Content saved by an editor while the embeddings were being computed.\n'

// Literal SHA-256 hex digests of the two fixture contents, computed outside this
// codebase so no production hashing code participates in the oracle.
const HASH_BEFORE = '75e9e43b593c277cb3b9550ae74c059fa596f9fa7a8abea5091a7a8116e0ba04'
const HASH_AFTER = 'd81c99f614d793cb111431a2852d16593929a924e751b2e3034d57d6ed5c266f'

// ============================================
// Structural stubs
// ============================================

/**
 * A parser that rewrites the file as a side effect of reading it: the stand-in
 * for an editor saving during the parse/chunk/embed window. It returns the text
 * it "read" (the pre-modification content), so the chunks belong to
 * {@link CONTENT_BEFORE} while the disk already holds {@link CONTENT_AFTER}.
 *
 * `validateFilePath` / `validateFileSize` are recording spies standing in for the
 * real parser's boundary checks; the cases that pin those two decisions use a real
 * `DocumentParser` instead of this stub.
 */
function racingParser(): DocumentParser {
  return {
    validateFilePath: vi.fn().mockResolvedValue(undefined),
    validateFileSize: vi.fn(),
    parseFile: async (filePath: string) => {
      writeFileSync(filePath, CONTENT_AFTER)
      return { content: CONTENT_BEFORE, title: 'Report' }
    },
  } as unknown as DocumentParser
}

const singleChunkChunker = (): SemanticChunker =>
  ({
    chunkText: async () => [{ index: 0, text: 'one chunk of the pre-modification text' }],
  }) as unknown as SemanticChunker

const fixedEmbedder = (): Embedder =>
  ({
    embedBatch: async () => [[0.1, 0.2, 0.3]],
  }) as unknown as Embedder

/** Captures what persistence received, which is where `contentHash` is observable. */
function capturingStore(): { store: VectorStore; inserted: VectorChunk[] } {
  const inserted: VectorChunk[] = []
  const store = {
    deleteChunks: async () => 0,
    insertChunks: async (chunks: VectorChunk[]) => {
      inserted.push(...chunks)
    },
  } as unknown as VectorStore
  return { store, inserted }
}

/** Ingest `report.md` once while it is rewritten mid-flight; return stored rows. */
async function ingestWithMidFlightModification(): Promise<VectorChunk[]> {
  writeFileSync(REPORT_PATH, CONTENT_BEFORE)
  const { store, inserted } = capturingStore()
  await ingestSingleFile(
    REPORT_PATH,
    racingParser(),
    singleChunkChunker(),
    fixedEmbedder(),
    store,
    { visual: false }
  )
  return inserted
}

/** How many times the production `readFile` was given exactly this path. */
function readsOf(filePath: string): number {
  return readPaths.filter((path) => path === filePath).length
}

// ============================================
// Setup
// ============================================

beforeAll(async () => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
  mkdirSync(DOCS_DIR, { recursive: true })
  vi.resetModules()
  vi.doMock('node:fs/promises', fsPromisesFactory)
  ;({ ingestSingleFile } = await import('../../cli/ingest.js'))
  ;({ runSync } = await import('../../features/sync.js'))
  ;({ DocumentParser: DocumentParserClass } = await import('../../parser/index.js'))
})

afterAll(() => {
  for (const path of MOCKED_PATHS) vi.doUnmock(path)
  vi.resetModules()
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  readPaths.length = 0
  writeFileSync(REPORT_PATH, CONTENT_BEFORE)
})

// ============================================
// Tests
// ============================================

describe('ingestSingleFile — contentHash is taken before parsing', () => {
  it('stores the hash of the bytes the chunks were built from, not the bytes left on disk', async () => {
    const inserted = await ingestWithMidFlightModification()

    // The modification really happened: the parser rewrote the file mid-ingest.
    expect(readFileSync(REPORT_PATH, 'utf-8')).toBe(CONTENT_AFTER)
    expect(inserted).toHaveLength(1)
    expect(inserted[0]?.contentHash).toBe(HASH_BEFORE)
  })

  it('leaves a later sync re-ingesting the file instead of skipping it', async () => {
    const inserted = await ingestWithMidFlightModification()
    const dbRows = inserted.map((chunk) => ({
      filePath: chunk.filePath,
      contentHash: chunk.contentHash ?? null,
    }))

    const ingestedBySync: string[] = []
    const collaborators: SyncCollaborators = {
      canonicalizeRequestedPath: async (path: string) => path,
      classifyPath: async () => 'file',
      scanDir: async () => ({
        files: [],
        unreadableDirs: [],
        depthLimitedDirs: [],
        skippedSymlinks: [],
      }),
      // The adapters' own `hashFile`: the current bytes on disk, which are the
      // post-modification ones.
      hashFile: async (filePath: string) =>
        createHash('sha256').update(readFileSync(filePath)).digest('hex'),
      loadDbManifest: async () => dbRows,
      ingestFile: async (filePath: string) => {
        ingestedBySync.push(filePath)
        return 1
      },
      deleteExactPath: async () => 0,
      optimize: async () => undefined,
    }

    const result = await runSync({
      roots: [DOCS_DIR],
      canonicalRoots: [DOCS_DIR],
      dbPath: join(TMP_ROOT, 'db'),
      excludePaths: [],
      platform: process.platform,
      requestedPath: REPORT_PATH,
      collaborators,
    })

    expect(result.error).toBeNull()
    expect(result.upserted).toBe(1)
    expect(result.skipped).toBe(0)
    expect(ingestedBySync).toEqual([REPORT_PATH])
    // The disk hash sync compared against is the post-modification one, so the
    // stored hash was the older of the two — the fail-dirty direction.
    expect(dbRows[0]?.contentHash).toBe(HASH_BEFORE)
    expect(HASH_BEFORE).not.toBe(HASH_AFTER)
  })
})

// ============================================
// The pre-parse read runs behind the parser's boundary checks
// ============================================

describe('ingestSingleFile — the pre-parse read is validated first', () => {
  /** A real parser, because these cases are about its own boundary decisions. */
  const realParser = (maxFileSize: number): DocumentParser =>
    new DocumentParserClass({ baseDirs: [realpathSync(DOCS_DIR)], maxFileSize })

  it('refuses an oversized file before reading its bytes', async () => {
    const { store, inserted } = capturingStore()

    await expect(
      ingestSingleFile(REPORT_PATH, realParser(8), singleChunkChunker(), fixedEmbedder(), store, {
        visual: false,
      })
    ).rejects.toThrow(/File size exceeds limit/)

    // The bound the old post-parse read position relied on: the whole file must
    // never reach memory.
    expect(readsOf(REPORT_PATH)).toBe(0)
    expect(inserted).toEqual([])
  })

  it('refuses an absolute path outside every configured root before reading its bytes', async () => {
    const outsideDir = join(TMP_ROOT, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const outsidePath = join(outsideDir, 'secret.md')
    writeFileSync(outsidePath, 'a document outside every configured root\n')
    const { store, inserted } = capturingStore()

    await expect(
      ingestSingleFile(
        outsidePath,
        realParser(1024 * 1024),
        singleChunkChunker(),
        fixedEmbedder(),
        store,
        { visual: false }
      )
    ).rejects.toThrow(/within a configured base directory/)

    // Containment is decided before anything outside the roots is read.
    expect(readsOf(outsidePath)).toBe(0)
    expect(inserted).toEqual([])
  })
})
