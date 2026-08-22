// Ingest Rollback Tests
// Test Type: Unit Test (spy-based, compatible with isolate: false)
// Tests rollback behavior when insertChunks fails during re-ingestion

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import { buildVectorChunks } from '../../ingest/compute.js'
import { type VectorChunk, VectorStore } from '../../vectordb/index.js'
import {
  DatabaseError,
  type ImageStorageVersion,
  toVectorChunk,
  type VisualAttachment,
} from '../../vectordb/types.js'
import { RAGServer } from '../index.js'

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='

function attachment(visualIndex: number): VisualAttachment {
  return {
    pageNum: 2,
    visualIndex,
    bbox: [0.1, 0.2, 0.8, 0.7],
    mimeType: 'image/png',
    pixelWidth: 1,
    pixelHeight: 1,
    data: ONE_PIXEL_PNG,
  }
}

function storedFields(chunks: VectorChunk[]): VectorChunk[] {
  return [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex)
}

describe('Ingest Rollback', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-rollback')
  const testDataDir = resolve('./tmp/test-data-rollback')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })

    ragServer = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )

    await ragServer.initialize()
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  // Rollback-restores-original is verified observably below ('restores the full
  // original chunk set with real vectors on rollback').

  it('surfaces a distinct DatabaseError (cause = insert error) when rollback also fails', async () => {
    // Arrange: Ingest a file normally first
    const testFile = resolve(testDataDir, 'rollback-double-fail.txt')
    writeFileSync(testFile, 'Content for double failure test. '.repeat(50))

    await ragServer.handleIngestFile({ filePath: testFile })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore

    // Both insert calls fail (new data insert + rollback restore): the prior
    // data is now gone. The handler surfaces a distinct DatabaseError that says
    // so, preserving the original insert error as `.cause`.
    const insertError = new Error('Insert failed')
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(insertError)
      .mockRejectedValueOnce(new Error('Rollback also failed'))

    vi.spyOn(vectorStore, 'optimize').mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    writeFileSync(testFile, 'Updated content for double failure. '.repeat(30))

    let thrown: unknown
    try {
      await ragServer.handleIngestFile({ filePath: testFile })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(DatabaseError)
    expect((thrown as Error).message).toContain('rollback failed')
    expect((thrown as Error).message).toContain('may not have been restored')
    expect((thrown as { cause?: unknown }).cause).toBe(insertError)

    // The rollback failure is still recorded on stderr for diagnostics.
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Rollback failed')

    insertSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('restores the full original chunk set with real vectors on rollback (TD-7/BR-4)', async () => {
    // Arrange: ingest real content, capture the stored chunks (real vectors).
    const testFile = resolve(testDataDir, 'rollback-real-vectors.txt')
    writeFileSync(testFile, 'Alpha beta gamma delta epsilon. '.repeat(80))
    await ragServer.handleIngestFile({ filePath: testFile })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore
    const original: VectorChunk[] = await vectorStore.getChunksByFilePath(testFile)
    expect(original.length).toBeGreaterThan(0)

    // Fail the new-data insert, then let the rollback restore run for REAL
    // (not mocked) so we can verify what actually lands back in the DB.
    const origInsert = vectorStore.insertChunks.bind(vectorStore)
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Simulated insertion failure'))
      .mockImplementationOnce((chunks: unknown) => origInsert(chunks))
    const optimizeSpy = vi.spyOn(vectorStore, 'optimize')

    // Act: re-ingest with different content (different embeddings) — the old
    // broken backup would have restored a dummy vector taken from THIS content.
    writeFileSync(testFile, 'Completely unrelated zebra yak xylophone. '.repeat(20))
    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Simulated insertion failure'
    )

    // Assert: the full original set is restored with its real stored vectors.
    const restored: VectorChunk[] = await vectorStore.getChunksByFilePath(testFile)
    const byIndex = (cs: VectorChunk[]): VectorChunk[] =>
      [...cs].sort((a, b) => a.chunkIndex - b.chunkIndex)
    const o = byIndex(original)
    const r = byIndex(restored)
    expect(r.length).toBe(o.length)
    expect(r.map((c) => c.text)).toEqual(o.map((c) => c.text))
    // Real vectors, not a single dummy: every restored vector matches the
    // original stored vector for that chunk.
    expect(r.map((c) => c.vector)).toEqual(o.map((c) => c.vector))

    insertSpy.mockRestore()
    optimizeSpy.mockRestore()
  })

  it('leaves no partial data when insert fails for a new file (no backup to roll back to)', async () => {
    // Arrange: New file (no prior ingestion)
    const testFile = resolve(testDataDir, 'rollback-new-file.txt')
    writeFileSync(testFile, 'New file content. '.repeat(50))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore

    // Force the insert to fail (the only way to exercise the failure path).
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Insert failed for new file'))

    // Act: Should surface the insert error directly.
    await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
      'Insert failed for new file'
    )

    // No backup → no rollback attempted: insertChunks called exactly once.
    // (Spy-verified; "no rollback attempted" has no observable surface.)
    expect(insertSpy).toHaveBeenCalledTimes(1)

    insertSpy.mockRestore()

    // Observable: the failed first-time insert leaks no rows.
    const persisted = await vectorStore.getChunksByFilePath(testFile)
    expect(persisted).toHaveLength(0)
  })

  it('serializes ordered same-row attachments and a non-null storage version before persistence', () => {
    const visualAttachments = new Map([[3, [attachment(7), attachment(2)]]])
    const built = buildVectorChunks({
      filePath: resolve(testDataDir, 'ordered.pdf'),
      chunks: [
        { index: 3, text: 'With images', sourceStart: 0, sourceEnd: 11 },
        { index: 4, text: 'Without images', sourceStart: 12, sourceEnd: 26 },
      ],
      embeddings: [
        [1, 0],
        [0, 1],
      ],
      fileSize: 26,
      fileTitle: 'Ordered PDF',
      contentHash: null,
      visualAttachments,
      imageStorageVersion: 'pdf-images-v1',
    })

    expect(built.map((chunk) => chunk.imageStorageVersion)).toEqual([
      'pdf-images-v1',
      'pdf-images-v1',
    ])
    expect(built[0]?.visualAttachments).toBe(JSON.stringify([attachment(2), attachment(7)]))
    expect(built[1]?.visualAttachments).toBeNull()
  })

  it('normalizes legacy no-image sentinels while preserving malformed attachment JSON', () => {
    const base = {
      id: 'legacy-row',
      filePath: '/legacy.pdf',
      chunkIndex: 0,
      text: 'legacy',
      vector: new Float32Array([1, 0]),
      metadata: { fileName: 'legacy.pdf', fileSize: 6, fileType: 'pdf' },
      fileTitle: null,
      timestamp: '2026-08-22T00:00:00.000Z',
    }

    expect(toVectorChunk(base)).toMatchObject({
      visualAttachments: null,
      imageStorageVersion: 'none',
    })
    expect(
      toVectorChunk({ ...base, visualAttachments: '', imageStorageVersion: '' })
    ).toMatchObject({ visualAttachments: null, imageStorageVersion: 'none' })
    expect(
      toVectorChunk({ ...base, visualAttachments: '[]', imageStorageVersion: null })
    ).toMatchObject({ visualAttachments: null, imageStorageVersion: 'none' })
    expect(
      toVectorChunk({
        ...base,
        visualAttachments: '{malformed',
        imageStorageVersion: 'pdf-images-v1',
      })
    ).toMatchObject({
      visualAttachments: '{malformed',
      imageStorageVersion: 'pdf-images-v1',
    })
  })

  it('creates both string columns on a fresh table and round-trips existing-table inserts', async () => {
    const dbPath = resolve('./tmp/test-lancedb-image-columns-fresh')
    rmSync(dbPath, { recursive: true, force: true })
    const store = new VectorStore({ dbPath, tableName: 'chunks' })
    await store.initialize()
    try {
      const makeChunks = (filePath: string, version: ImageStorageVersion): VectorChunk[] =>
        buildVectorChunks({
          filePath,
          chunks: [{ index: 0, text: filePath, sourceStart: 0, sourceEnd: filePath.length }],
          embeddings: [[1, 0]],
          fileSize: filePath.length,
          fileTitle: null,
          contentHash: null,
          visualAttachments:
            version === 'pdf-images-v1'
              ? new Map([[0, [attachment(0), attachment(1)]]])
              : new Map(),
          imageStorageVersion: version,
        })

      const noImagePath = '/fresh/no-image.pdf'
      await store.insertChunks(makeChunks(noImagePath, 'none'))
      const imagePath = '/fresh/image.pdf'
      await store.insertChunks(makeChunks(imagePath, 'pdf-images-v1'))

      const { connect } = await import('@lancedb/lancedb')
      const db = await connect(dbPath)
      try {
        const table = await db.openTable('chunks')
        const schema = await table.schema()
        expect(
          schema.fields.find((field) => field.name === 'visualAttachments')?.type.toString()
        ).toBe('Utf8')
        expect(
          schema.fields.find((field) => field.name === 'imageStorageVersion')?.type.toString()
        ).toBe('Utf8')
      } finally {
        await db.close()
      }

      expect(await store.getChunksByFilePath(noImagePath)).toMatchObject([
        { visualAttachments: null, imageStorageVersion: 'none' },
      ])
      expect(await store.getChunksByFilePath(imagePath)).toMatchObject([
        {
          visualAttachments: JSON.stringify([attachment(0), attachment(1)]),
          imageStorageVersion: 'pdf-images-v1',
        },
      ])
    } finally {
      await store.close()
      rmSync(dbPath, { recursive: true, force: true })
    }
  })

  it('migrates each image column independently and idempotently', async () => {
    const { connect } = await import('@lancedb/lancedb')
    const cases = [
      {
        name: 'missing-version',
        existing: { visualAttachments: '[]' },
        expected: { visualAttachments: null, imageStorageVersion: 'none' },
      },
      {
        name: 'missing-attachments',
        existing: { imageStorageVersion: 'pdf-images-v1' },
        expected: { visualAttachments: null, imageStorageVersion: 'pdf-images-v1' },
      },
    ] as const

    for (const migrationCase of cases) {
      const dbPath = resolve(`./tmp/test-lancedb-image-columns-${migrationCase.name}`)
      rmSync(dbPath, { recursive: true, force: true })
      const legacyDb = await connect(dbPath)
      await legacyDb.createTable('chunks', [
        {
          id: migrationCase.name,
          filePath: `/${migrationCase.name}.pdf`,
          chunkIndex: 0,
          text: 'legacy',
          vector: [1, 0],
          metadata: { fileName: `${migrationCase.name}.pdf`, fileSize: 6, fileType: 'pdf' },
          fileTitle: '',
          contentHash: '',
          timestamp: '2026-08-22T00:00:00.000Z',
          ...migrationCase.existing,
        },
      ])
      await legacyDb.close()

      const first = new VectorStore({ dbPath, tableName: 'chunks' })
      await first.initialize()
      await first.close()
      const second = new VectorStore({ dbPath, tableName: 'chunks' })
      await second.initialize()
      try {
        const rows = await second.getChunksByFilePath(`/${migrationCase.name}.pdf`)
        expect(rows).toMatchObject([migrationCase.expected])

        const schemaDb = await connect(dbPath)
        try {
          const schema = await (await schemaDb.openTable('chunks')).schema()
          const names = schema.fields.map((field) => field.name)
          expect(names.filter((name) => name === 'visualAttachments')).toHaveLength(1)
          expect(names.filter((name) => name === 'imageStorageVersion')).toHaveLength(1)
        } finally {
          await schemaDb.close()
        }
      } finally {
        await second.close()
        rmSync(dbPath, { recursive: true, force: true })
      }
    }
  })

  it('restores exact ordered attachment JSON and storage version after replacement failure', async () => {
    const testFile = resolve(testDataDir, 'rollback-image-state.txt')
    writeFileSync(testFile, 'Replacement source content. '.repeat(40))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = (ragServer as any).vectorStore
    const originalRows: VectorChunk[] = [
      {
        id: 'image-row-0',
        filePath: testFile,
        chunkIndex: 0,
        text: 'Original searchable text zero',
        vector: new Array(384).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
        metadata: { fileName: 'rollback-image-state.txt', fileSize: 64, fileType: 'txt' },
        fileTitle: 'Original title',
        contentHash: 'original-content-hash',
        timestamp: '2026-08-22T00:00:00.000Z',
        visualAttachments: JSON.stringify([attachment(1), attachment(4)]),
        imageStorageVersion: 'pdf-images-v1',
      },
      {
        id: 'image-row-1',
        filePath: testFile,
        chunkIndex: 1,
        text: 'Original searchable text one',
        vector: new Array(384).fill(0).map((_, index) => (index === 1 ? 1 : 0)),
        metadata: { fileName: 'rollback-image-state.txt', fileSize: 64, fileType: 'txt' },
        fileTitle: 'Original title',
        contentHash: 'original-content-hash',
        timestamp: '2026-08-22T00:00:00.000Z',
        visualAttachments: null,
        imageStorageVersion: 'pdf-images-v1',
      },
    ]
    await vectorStore.insertChunks(originalRows)
    const captured = storedFields(await vectorStore.getChunksByFilePath(testFile))

    const realInsert = vectorStore.insertChunks.bind(vectorStore)
    const insertSpy = vi
      .spyOn(vectorStore, 'insertChunks')
      .mockRejectedValueOnce(new Error('Replacement insert failed'))
      .mockImplementationOnce((chunks: unknown) => realInsert(chunks as VectorChunk[]))

    try {
      await expect(ragServer.handleIngestFile({ filePath: testFile })).rejects.toThrow(
        'Replacement insert failed'
      )

      const restored = storedFields(await vectorStore.getChunksByFilePath(testFile))
      expect(restored).toEqual(captured)
      expect(JSON.parse(restored[0]?.visualAttachments ?? '[]')).toEqual([
        attachment(1),
        attachment(4),
      ])
      expect(restored.map((row) => row.imageStorageVersion)).toEqual([
        'pdf-images-v1',
        'pdf-images-v1',
      ])
    } finally {
      insertSpy.mockRestore()
    }
  })
})
