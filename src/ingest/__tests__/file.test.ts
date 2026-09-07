import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asDouble } from '../../__tests__/test-doubles.js'
import type { SemanticChunker } from '../../chunker/index.js'
import type { EmbedderInterface } from '../../chunker/semantic-chunker.js'
import type { DocumentParser } from '../../parser/index.js'
import { buildPreparedFileVectorChunks, prepareFileForIngest } from '../file.js'

const tmpDir = resolve('./tmp/test-prepare-file-for-ingest')
const fixturePath = resolve(tmpDir, 'document.md')

function parserReturning(content: string, title: string | null): DocumentParser {
  return asDouble<DocumentParser>({
    validateFilePath: vi.fn().mockResolvedValue(undefined),
    validateFileSize: vi.fn(),
    parseFile: vi.fn().mockResolvedValue({ content, title: title ?? '' }),
  })
}

function chunkerReturning(texts: readonly string[]): SemanticChunker {
  return asDouble<SemanticChunker>({
    chunkText: vi.fn().mockResolvedValue(
      texts.map((text, index) => ({
        text,
        index,
        sourceStart: index * 10,
        sourceEnd: index * 10 + text.length,
      }))
    ),
  })
}

function embedderReturning(vectors: number[][]): EmbedderInterface {
  return { embedBatch: vi.fn().mockResolvedValue(vectors) }
}

beforeAll(() => {
  mkdirSync(tmpDir, { recursive: true })
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('prepareFileForIngest', () => {
  it('returns persistable rows with the existing file metadata contract', async () => {
    writeFileSync(fixturePath, 'Original source bytes.\n')
    const parser = parserReturning('Parsed document text', 'Document title')

    const result = await prepareFileForIngest(
      fixturePath,
      {
        parser,
        chunker: chunkerReturning(['First chunk', 'Second chunk']),
        embedder: embedderReturning([
          [1, 0],
          [0, 1],
        ]),
      },
      { images: false }
    )
    const vectorChunks = buildPreparedFileVectorChunks(result)

    expect(result.title).toBe('Document title')
    expect(result.omittedImageCount).toBe(0)
    expect(vectorChunks).toHaveLength(2)
    expect(
      vectorChunks.map(({ filePath, chunkIndex, text, vector, metadata, fileTitle }) => ({
        filePath,
        chunkIndex,
        text,
        vector,
        metadata,
        fileTitle,
      }))
    ).toEqual([
      {
        filePath: fixturePath,
        chunkIndex: 0,
        text: 'First chunk',
        vector: [1, 0],
        metadata: { fileName: 'document.md', fileSize: 20, fileType: 'md' },
        fileTitle: 'Document title',
      },
      {
        filePath: fixturePath,
        chunkIndex: 1,
        text: 'Second chunk',
        vector: [0, 1],
        metadata: { fileName: 'document.md', fileSize: 20, fileType: 'md' },
        fileTitle: 'Document title',
      },
    ])
    expect(vectorChunks.every((chunk) => chunk.visualAttachments === '[]')).toBe(true)
  })

  it('hashes the source before parsing so a concurrent rewrite remains dirty for sync', async () => {
    writeFileSync(fixturePath, 'Original source bytes.\n')
    const parser = parserReturning('Parsed from the original bytes', null)
    vi.mocked(parser.parseFile).mockImplementation(async () => {
      writeFileSync(fixturePath, 'Rewritten while parsing.\n')
      return { content: 'Parsed from the original bytes', title: '' }
    })

    const result = await prepareFileForIngest(
      fixturePath,
      {
        parser,
        chunker: chunkerReturning(['Original chunk']),
        embedder: embedderReturning([[0.5, 0.5]]),
      },
      { images: false }
    )

    expect(buildPreparedFileVectorChunks(result)[0]?.contentHash).toBe(
      'e222403aa686e8a62968776381f955870385ff6db7f7a4ed53d7ba0709012dd1'
    )
  })

  it('returns no rows for zero chunks so each adapter retains its existing policy', async () => {
    writeFileSync(fixturePath, 'Short.\n')

    const result = await prepareFileForIngest(
      fixturePath,
      {
        parser: parserReturning('Short.', null),
        chunker: chunkerReturning([]),
        embedder: embedderReturning([]),
      },
      { images: false }
    )

    expect(result.chunks).toEqual([])
  })

  it('records no visual profile for a non-PDF and omits the row property', async () => {
    writeFileSync(fixturePath, 'Original source bytes.\n')

    const result = await prepareFileForIngest(
      fixturePath,
      {
        parser: parserReturning('Parsed document text', null),
        chunker: chunkerReturning(['First chunk']),
        embedder: embedderReturning([[1, 0]]),
      },
      { images: false }
    )

    expect(result.visualProfile).toBeNull()
    expect(buildPreparedFileVectorChunks(result).map((chunk) => 'visualProfile' in chunk)).toEqual([
      false,
    ])
  })

  it('records no visual profile for a PDF ingested without a captioner', async () => {
    const pdfPath = resolve(tmpDir, 'normal.pdf')
    writeFileSync(pdfPath, 'PDF bytes.\n')
    const parser = asDouble<DocumentParser>({
      validateFilePath: vi.fn().mockResolvedValue(undefined),
      validateFileSize: vi.fn(),
      parsePdf: vi.fn().mockResolvedValue({ content: 'Parsed PDF text', title: '' }),
    })

    const result = await prepareFileForIngest(
      pdfPath,
      {
        parser,
        chunker: chunkerReturning(['First chunk']),
        embedder: embedderReturning([[1, 0]]),
      },
      { images: false }
    )

    expect(result.visualProfile).toBeNull()
    expect(buildPreparedFileVectorChunks(result).map((chunk) => 'visualProfile' in chunk)).toEqual([
      false,
    ])
  })
})

/**
 * The requested profile is intent, not an outcome: it must reach every row even
 * when the visual pass produced no caption at all. The visual pipeline is
 * replaced so the VLM never loads, while the profile mapping under test stays
 * real. `../visual.js` is imported by other test files too, so the mock is
 * scoped per the repository's `isolate: false` rules.
 */
describe('prepareFileForIngest visual profile production', () => {
  const VISUAL_MODULE = '../visual.js'
  let prepare: typeof prepareFileForIngest
  let buildRows: typeof buildPreparedFileVectorChunks

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock(VISUAL_MODULE, () => ({
      prepareVisualPdfChunks: vi.fn().mockResolvedValue({
        // A tolerated caption failure leaves plain PDF text behind.
        chunks: [{ text: 'Plain page text', index: 0, sourceStart: 0, sourceEnd: 15 }],
        embeddings: [[1, 0]],
        title: null,
        text: 'Plain page text',
        atomicRanges: [],
        visualAttachments: new Map(),
        omittedImageCount: 0,
      }),
    }))
    const fileModule = await import('../file.js')
    prepare = fileModule.prepareFileForIngest
    buildRows = fileModule.buildPreparedFileVectorChunks
  })

  afterAll(() => {
    vi.doUnmock(VISUAL_MODULE)
    vi.resetModules()
  })

  it.each(['fast', 'quality'] as const)(
    'copies the requested %s profile to every row despite a caption fallback',
    async (profile) => {
      const pdfPath = resolve(tmpDir, `visual-${profile}.PDF`)
      writeFileSync(pdfPath, 'PDF bytes.\n')

      const result = await prepare(
        pdfPath,
        {
          parser: asDouble<DocumentParser>({
            validateFilePath: vi.fn().mockResolvedValue(undefined),
            validateFileSize: vi.fn(),
          }),
          chunker: asDouble<SemanticChunker>({}),
          embedder: { embedBatch: vi.fn() },
        },
        { images: false, captioner: { profile, cacheDir: '/tmp/cache' } }
      )

      expect(result.visualProfile).toBe(profile)
      expect(buildRows(result).map((chunk) => chunk.visualProfile)).toEqual([profile])
    }
  )
})
