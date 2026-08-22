import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { validateVisualAttachment } from '../../pdf-visual/renderer.js'
import type { VisualAttachment } from '../../pdf-visual/types.js'
import { buildPdfWithImageBytes } from '../pdf-image-fixture.js'

type RunIngest = typeof import('../../cli/ingest.js').runIngest
type VectorStoreCtor = typeof import('../../vectordb/index.js').VectorStore
type StoredRows = Awaited<ReturnType<InstanceType<VectorStoreCtor>['getChunksByFilePath']>>

const testRoot = resolve('./tmp/test-cli-ingest-images-persistence')
const dbPath = resolve(testRoot, 'db')
const cacheDir = resolve(testRoot, 'cache')
const pdfPath = resolve(testRoot, 'image-fixture.pdf')

function deterministicEmbeddings(texts: string[]): number[][] {
  return texts.map((_text, index) => {
    const vector = new Array<number>(384).fill(0)
    vector[index % vector.length] = 1
    return vector
  })
}

const cliCommonFactory = async () => {
  const actual = await vi.importActual<typeof import('../../cli/common.js')>('../../cli/common.js')
  return {
    ...actual,
    createEmbedder: vi.fn(() => ({
      embed: vi.fn(async () => deterministicEmbeddings(['query'])[0]),
      embedBatch: vi.fn(async (texts: string[]) => deterministicEmbeddings(texts)),
      dispose: vi.fn(async () => undefined),
    })),
  }
}

let runIngest: RunIngest
let VectorStore: VectorStoreCtor

async function readRows(): Promise<StoredRows> {
  const store = new VectorStore({ dbPath, tableName: 'chunks' })
  await store.initialize()
  try {
    return await store.getChunksByFilePath(pdfPath)
  } finally {
    await store.close()
  }
}

describe('CLI ingest image persistence', () => {
  beforeAll(async () => {
    rmSync(testRoot, { recursive: true, force: true })
    mkdirSync(testRoot, { recursive: true })
    writeFileSync(pdfPath, buildPdfWithImageBytes())

    vi.resetModules()
    vi.doMock('../../cli/common.js', cliCommonFactory)
    ;({ runIngest } = await import('../../cli/ingest.js'))
    ;({ VectorStore } = await import('../../vectordb/index.js'))
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true })
    vi.doUnmock('../../cli/common.js')
    vi.resetModules()
  })

  it('persists ordered image attachments and omission replaces the same PDF request-locally', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await runIngest(['--images', '--base-dir', testRoot, pdfPath], {
        dbPath,
        cacheDir,
        modelName: 'deterministic-test-embedder',
      })

      const enabledRows = await readRows()
      expect(enabledRows.length).toBeGreaterThan(0)
      expect(enabledRows.every((row) => row.imageStorageVersion === 'pdf-images-v1')).toBe(true)
      const attachmentRows = enabledRows
        .filter((row) => row.visualAttachments !== null)
        .map((row) => JSON.parse(row.visualAttachments as string) as VisualAttachment[])
      expect(attachmentRows.length).toBeGreaterThan(0)
      for (const attachments of attachmentRows) {
        expect(attachments.length).toBeGreaterThan(0)
        expect(attachments.map((attachment) => attachment.visualIndex)).toEqual(
          attachments
            .map((attachment) => attachment.visualIndex)
            .sort((left, right) => left - right)
        )
        expect(attachments.every(validateVisualAttachment)).toBe(true)
      }

      await runIngest(['--base-dir', testRoot, pdfPath], {
        dbPath,
        cacheDir,
        modelName: 'deterministic-test-embedder',
      })

      const disabledRows = await readRows()
      expect(disabledRows.length).toBeGreaterThan(0)
      expect(disabledRows.every((row) => row.imageStorageVersion === 'none')).toBe(true)
      expect(disabledRows.every((row) => row.visualAttachments === null)).toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })
})
