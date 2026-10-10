import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '@lancedb/lancedb'
import { expect, it } from 'vitest'
import { buildDocxFixture, headingXml, paragraphXml } from '../../__tests__/docx-fixture.js'
import { buildPdfReadingOrderFixture } from '../../__tests__/pdf-reading-order-fixture.js'
import { SemanticChunker } from '../../chunker/index.js'
import { DocumentParser } from '../../parser/index.js'
import { VectorStore } from '../../vectordb/index.js'
import { buildPreparedFileVectorChunks, prepareFileForIngest } from '../file.js'

it('round-trips MD/DOCX context through legacy migration, search, neighbors and rollback rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-context-'))
  const dbPath = join(dir, 'db')
  const text = 'A sufficiently long sentence about deployment and operational monitoring.'
  const md = join(dir, 'guide.md')
  const docx = join(dir, 'guide.docx')
  const parser = new DocumentParser({ baseDir: dir, maxFileSize: 1_000_000 })
  const embedder = { embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]) }
  const chunker = new SemanticChunker()
  const store = new VectorStore({ dbPath, tableName: 'chunks' })
  try {
    await writeFile(md, `# Guide\n\n## Deployment\n${text}\n`)
    await writeFile(
      docx,
      await buildDocxFixture({ bodyXml: headingXml('Deployment') + paragraphXml(text) })
    )
    const prepared = await prepareFileForIngest(
      md,
      { parser, chunker, embedder },
      { images: false }
    )
    const rows = buildPreparedFileVectorChunks(prepared)
    const first = rows[0]
    if (!first) {
      throw new Error('No chunks')
    }
    const { sourceContext: _context, ...legacy } = first
    const connection = await connect(dbPath)
    const table = await connection.createTable('chunks', [
      { ...legacy, contentHash: '', visualProfile: '' },
    ])
    table.close()
    connection.close()
    await store.initialize()
    expect((await store.getChunksByRange(md, 0, 100))[0]?.sourceContext).toBeUndefined()
    await store.deleteChunks(md)
    await store.insertChunks(rows)
    const neighbors = await store.getChunksByRange(md, 0, 100)
    expect(neighbors[0]?.sourceContext).toEqual({
      startLine: 1,
      endLine: 4,
      headingPaths: [['Guide'], ['Guide', 'Deployment']],
    })
    expect((await store.search([1, 0, 0]))[0]?.sourceContext).toEqual(neighbors[0]?.sourceContext)
    const backup = await store.getChunksByFilePath(md)
    await store.deleteChunks(md)
    await store.insertChunks(backup)
    expect((await store.getChunksByRange(md, 0, 100))[0]?.sourceContext).toEqual(
      neighbors[0]?.sourceContext
    )
    const word = await prepareFileForIngest(docx, { parser, chunker, embedder }, { images: false })
    await store.insertChunks(buildPreparedFileVectorChunks(word))
    expect((await store.getChunksByRange(docx, 0, 100))[0]?.sourceContext).toEqual({
      headingPaths: [['Deployment']],
    })
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it('persists PDF page and heading context through the shared ingestion path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-source-context-'))
  const pdf = join(dir, 'reading-order.pdf')
  const parser = new DocumentParser({ baseDir: dir, maxFileSize: 1_000_000 })
  const embedder = { embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]) }
  const store = new VectorStore({ dbPath: join(dir, 'db'), tableName: 'chunks' })
  try {
    await writeFile(
      pdf,
      buildPdfReadingOrderFixture({ pageCount: 1, layout: 'two-column', repeatedBoundaries: false })
    )
    const prepared = await prepareFileForIngest(
      pdf,
      { parser, chunker: new SemanticChunker(), embedder },
      { images: false }
    )
    const passageChunk = prepared.chunks.find((chunk) => chunk.text.includes('Left page 1 begins'))
    expect(passageChunk?.sourceContext).toEqual({
      headingPaths: [['Section 1 Reading Order']],
      startPage: 1,
      endPage: 1,
    })

    const rows = buildPreparedFileVectorChunks(prepared)
    const passageRow = rows.find((row) => row.text.includes('Left page 1 begins'))
    expect(passageRow?.sourceContext).toBeDefined()
    await store.initialize()
    await store.insertChunks(rows)
    const stored = await store.getChunksByFilePath(pdf)
    expect(stored.find((row) => row.text.includes('Left page 1 begins'))?.sourceContext).toEqual(
      passageRow?.sourceContext
    )
    expect((await store.search([1, 0, 0]))[0]?.sourceContext).toBeDefined()
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
