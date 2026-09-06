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
})
