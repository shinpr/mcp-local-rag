import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SemanticChunker } from '../../chunker/index.js'
import type { EmbedderInterface } from '../../chunker/semantic-chunker.js'
import type { DocumentParser } from '../../parser/index.js'

const tmpDir = resolve('./tmp/test-ingest-default-mode')
const fixturePath = resolve(tmpDir, 'document.pdf')
const mockedPath = '../../pdf-visual/index.js'
let visualBarrelLoaded = false
let prepareFileForIngest: typeof import('../../ingest/file.js').prepareFileForIngest
let buildPreparedFileVectorChunks: typeof import('../../ingest/file.js').buildPreparedFileVectorChunks

beforeAll(async () => {
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(fixturePath, 'fixture PDF bytes')
  vi.resetModules()
  vi.doMock(mockedPath, () => {
    visualBarrelLoaded = true
    return {
      detectVisualRegions: () => [],
      createCaptioner: () => ({ caption: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) }),
      processVisualRegions: async () => [],
    }
  })
  ;({ prepareFileForIngest, buildPreparedFileVectorChunks } = await import('../../ingest/file.js'))
})

afterAll(() => {
  vi.doUnmock(mockedPath)
  vi.resetModules()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('default PDF ingestion', () => {
  it('keeps the VLM barrel unloaded unless captioning is requested', async () => {
    const destroy = vi.fn()
    const parser = {
      validateFilePath: vi.fn().mockResolvedValue(undefined),
      validateFileSize: vi.fn(),
      parsePdf: vi.fn().mockResolvedValue({ content: 'Default PDF text', title: 'Title' }),
      parsePdfPages: vi.fn().mockResolvedValue({
        doc: { destroy },
        title: 'Title',
        pages: [
          { pageNum: 1, text: 'Visual PDF text', textFragments: [], stextJson: { blocks: [] } },
        ],
      }),
    } as unknown as DocumentParser
    const chunker = {
      chunkText: vi
        .fn()
        .mockImplementation(async (text: string) => [
          { text, index: 0, sourceStart: 0, sourceEnd: text.length },
        ]),
    } as unknown as SemanticChunker
    const embedder = {
      embedBatch: vi.fn().mockResolvedValue([[1, 0]]),
    } as EmbedderInterface

    const defaultResult = await prepareFileForIngest(fixturePath, parser, chunker, embedder, {
      images: false,
    })

    expect(buildPreparedFileVectorChunks(defaultResult)[0]?.text).toBe('Default PDF text')
    expect(visualBarrelLoaded).toBe(false)

    await prepareFileForIngest(fixturePath, parser, chunker, embedder, {
      images: false,
      captioner: { profile: 'fast', cacheDir: tmpDir },
    })

    expect(visualBarrelLoaded).toBe(true)
    expect(destroy).toHaveBeenCalledOnce()
  })
})
