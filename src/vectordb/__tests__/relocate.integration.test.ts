import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { connect, type Table } from '@lancedb/lancedb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../utils/type-guards.js'
import { type VectorChunk, VectorStore } from '../index.js'
import { type RelocationPathMapping, relocateIndexedPaths } from '../relocate.js'

const databasePaths = new Set<string>()

afterEach(() => {
  for (const databasePath of databasePaths) {
    fs.rmSync(databasePath, { recursive: true, force: true })
  }
  databasePaths.clear()
})

function createDatabasePath(label: string): string {
  const databasePath = path.resolve('./tmp', `relocate-${label}-${randomUUID()}`)
  databasePaths.add(databasePath)
  return databasePath
}

function createChunk(filePath: string, text: string, chunkIndex = 0): VectorChunk {
  return {
    id: randomUUID(),
    filePath,
    chunkIndex,
    text,
    vector: [1, 0, 0],
    metadata: {
      fileName: path.basename(filePath),
      fileSize: text.length,
      fileType: path.extname(filePath).slice(1),
    },
    fileTitle: `Title for ${path.basename(filePath)}`,
    contentHash: `hash-${chunkIndex}-${text.length}`,
    visualAttachments: '[]',
    visualProfile: 'quality',
    sourceContext: JSON.stringify({ headingPaths: [['Relocation', 'Preserved']] }),
    timestamp: '2026-10-10T00:00:00.000Z',
  }
}

function createLegacyRecord(filePath: string, id = randomUUID()): Record<string, unknown> {
  return {
    id,
    filePath,
    chunkIndex: 0,
    text: 'Legacy relocation row with a preserved vector',
    vector: [1, 0, 0],
    metadata: { fileName: 'legacy.md', fileSize: 42, fileType: 'md' },
    timestamp: '2026-10-10T00:00:00.000Z',
  }
}

async function seedStore(databasePath: string, chunks: VectorChunk[]): Promise<VectorStore> {
  const store = new VectorStore({ dbPath: databasePath, tableName: 'chunks' })
  await store.initialize()
  await store.insertChunks(chunks)
  await store.optimize()
  return store
}

function plainRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected LanceDB to return a row object')
  }
  const vector = value['vector']
  const metadata = value['metadata']
  if (!isArrayLike(vector) || !isRecord(metadata)) {
    throw new Error('Expected LanceDB rows to contain vector and metadata fields')
  }

  const normalizedVector: number[] = []
  for (const element of Array.from(vector)) {
    if (typeof element !== 'number') {
      throw new Error('Expected LanceDB vectors to contain numeric elements')
    }
    normalizedVector.push(element)
  }

  return {
    ...value,
    vector: normalizedVector,
    metadata: { ...metadata },
  }
}

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return isRecord(value) && typeof value['length'] === 'number'
}

function hasTableUpdate(value: unknown): value is Pick<Table, 'update'> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'update' in value &&
    typeof value.update === 'function'
  )
}

async function databaseSnapshot(databasePath: string): Promise<{
  version: number
  schema: Array<{ name: string; type: string }>
  rows: Record<string, unknown>[]
}> {
  const connection = await connect(databasePath)
  try {
    const table = await connection.openTable('chunks')
    const schema = await table.schema()
    const rows = await table.query().toArray()
    return {
      version: await table.version(),
      schema: schema.fields.map((field) => ({ name: field.name, type: String(field.type) })),
      rows: rows
        .map(plainRow)
        .sort((left, right) => String(left['id']).localeCompare(String(right['id']))),
    }
  } finally {
    connection.close()
  }
}

async function ftsPaths(table: Table, query: string, where: string): Promise<string[]> {
  const rows = await table
    .search(query, 'fts', 'text')
    .where(where)
    .select(['filePath', '_score'])
    .limit(20)
    .toArray()
  return rows.map((row) => String(row['filePath']))
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function withDotSegmentBeforeFileName(filePath: string): string {
  return `${path.dirname(filePath)}${path.sep}.${path.sep}${path.basename(filePath)}`
}

function withNativeAlternativeSeparator(filePath: string): string {
  if (process.platform === 'win32') {
    return filePath.replaceAll('\\', '/')
  }
  return `${path.dirname(filePath)}${path.sep}${path.sep}${path.basename(filePath)}`
}

async function seedLegacyTable(
  databasePath: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  const connection = await connect(databasePath)
  try {
    await connection.createTable('chunks', rows)
  } finally {
    connection.close()
  }
}

describe('relocateIndexedPaths', () => {
  it('normalizes selected aliases while preserving unrelated aliases in one searchable publication', async () => {
    const databasePath = createDatabasePath('success')
    const fromRoot = path.join(path.dirname(databasePath), "old project's (Ω)+")
    const toRoot = path.join(path.dirname(databasePath), "new $archive project's (Ω)+")
    const sourceA = withDotSegmentBeforeFileName(path.join(fromRoot, 'notes', "O'Brien_計画.md"))
    const sourceB = withNativeAlternativeSeparator(
      path.join(fromRoot, 'managed', 'archive%_one.txt')
    )
    const sibling = path.join(`${fromRoot}-backup`, 'leave-alone.md')
    const external = withDotSegmentBeforeFileName(path.join(path.dirname(fromRoot), 'external.md'))
    const destinationA = path.join(toRoot, 'notes', "O'Brien_計画.md")
    const destinationB = path.join(toRoot, 'managed', 'archive%_one.txt')
    const marker = 'quasarrelocationkeyword'
    const store = await seedStore(databasePath, [
      createChunk(sourceA, `First ${marker} passage`, 0),
      createChunk(sourceA, `Second ${marker} passage`, 1),
      createChunk(sourceB, 'Managed raw data is preserved', 0),
      createChunk(sibling, 'Sibling prefix remains untouched', 0),
      createChunk(external, 'Unrelated absolute path remains untouched', 0),
    ])
    const observerConnection = await connect(databasePath, { readConsistencyInterval: 0 })

    try {
      const observerTable = await observerConnection.openTable('chunks')
      const before = await databaseSnapshot(databasePath)
      const callback = vi.fn(async (_mappings: readonly RelocationPathMapping[]) => undefined)

      const result = await relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: toRoot,
        validateDestinations: callback,
      })

      expect(callback).toHaveBeenCalledOnce()
      expect(callback).toHaveBeenCalledWith(
        expect.arrayContaining([
          { sourcePath: sourceA, destinationPath: destinationA },
          { sourcePath: sourceB, destinationPath: destinationB },
        ])
      )
      expect(callback.mock.calls[0]?.[0]).toHaveLength(2)
      expect(result).toEqual({ filesRelocated: 2, chunksRelocated: 3 })

      const after = await databaseSnapshot(databasePath)
      expect(after.version).toBe(before.version + 1)
      expect(after.schema).toEqual(before.schema)
      expect(after.rows).toEqual(
        before.rows.map((row) => {
          if (row['filePath'] === sourceA) {
            return { ...row, filePath: destinationA }
          }
          if (row['filePath'] === sourceB) {
            return { ...row, filePath: destinationB }
          }
          return row
        })
      )
      expect(
        await ftsPaths(observerTable, marker, `\`filePath\` = ${sqlString(destinationA)}`)
      ).toHaveLength(2)

      const reopenedConnection = await connect(databasePath, { readConsistencyInterval: 0 })
      try {
        const reopenedTable = await reopenedConnection.openTable('chunks')
        expect(
          await ftsPaths(reopenedTable, marker, `\`filePath\` = ${sqlString(destinationA)}`)
        ).toHaveLength(2)
      } finally {
        reopenedConnection.close()
      }

      await store.close()
      const reopenedStore = new VectorStore({ dbPath: databasePath, tableName: 'chunks' })
      try {
        await reopenedStore.initialize()
        const search = await reopenedStore.search([1, 0, 0], { queryText: marker, limit: 10 })
        expect(search.filter((row) => row.filePath === destinationA)).toHaveLength(2)
        expect(await reopenedStore.getChunksByRange(destinationA, 0, 1)).toHaveLength(2)
        expect(await reopenedStore.getChunksByFilePath(destinationB)).toHaveLength(1)
      } finally {
        await reopenedStore.close()
      }
    } finally {
      observerConnection.close()
      await store.close()
    }
  })

  it('rejects a destination collision without changing a legacy table schema, rows, or version', async () => {
    const databasePath = createDatabasePath('collision')
    const fromRoot = path.join(path.dirname(databasePath), 'old')
    const toRoot = path.join(path.dirname(databasePath), 'new')
    const source = path.join(fromRoot, 'notes', 'same.md')
    const collision = withDotSegmentBeforeFileName(path.join(toRoot, 'notes', 'same.md'))
    await seedLegacyTable(databasePath, [createLegacyRecord(source), createLegacyRecord(collision)])
    const before = await databaseSnapshot(databasePath)
    const callback = vi.fn(async () => undefined)

    await expect(
      relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: toRoot,
        validateDestinations: callback,
      })
    ).rejects.toThrow(/collid/i)

    expect(callback).not.toHaveBeenCalled()
    expect(await databaseSnapshot(databasePath)).toEqual(before)
    expect(before.schema.map((field) => field.name)).not.toContain('sourceContext')
  })

  it('rejects distinct selected aliases that converge on one normalized destination before writing', async () => {
    const databasePath = createDatabasePath('source-alias-collision')
    const fromRoot = path.join(path.dirname(databasePath), 'old')
    const toRoot = path.join(path.dirname(databasePath), 'new')
    const canonicalSource = path.join(fromRoot, 'notes', 'same.md')
    const aliasedSource = withDotSegmentBeforeFileName(canonicalSource)
    await seedLegacyTable(databasePath, [
      createLegacyRecord(canonicalSource),
      createLegacyRecord(aliasedSource),
    ])
    const before = await databaseSnapshot(databasePath)
    const callback = vi.fn(async () => undefined)

    await expect(
      relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: toRoot,
        validateDestinations: callback,
      })
    ).rejects.toThrow(/same destination|collid/i)

    expect(callback).not.toHaveBeenCalled()
    expect(await databaseSnapshot(databasePath)).toEqual(before)
  })

  it('rejects destination validation on a legacy table without a maintenance commit', async () => {
    const databasePath = createDatabasePath('destination-validation')
    const fromRoot = path.join(path.dirname(databasePath), 'old')
    const toRoot = path.join(path.dirname(databasePath), 'new')
    await seedLegacyTable(databasePath, [createLegacyRecord(path.join(fromRoot, 'file.md'))])
    const before = await databaseSnapshot(databasePath)

    await expect(
      relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: toRoot,
        validateDestinations: async () => {
          throw new Error('Destination file is missing')
        },
      })
    ).rejects.toThrow(/destination/i)

    expect(await databaseSnapshot(databasePath)).toEqual(before)
  })

  it('rejects relative or structurally malformed stored paths before invoking destination validation', async () => {
    const databasePath = createDatabasePath('malformed-path')
    const fromRoot = path.join(path.dirname(databasePath), 'old')
    await seedLegacyTable(databasePath, [
      createLegacyRecord(path.join(fromRoot, 'valid.md')),
      createLegacyRecord('relative/file.md'),
    ])
    const before = await databaseSnapshot(databasePath)
    const callback = vi.fn(async () => undefined)

    await expect(
      relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: path.join(path.dirname(databasePath), 'new'),
        validateDestinations: callback,
      })
    ).rejects.toThrow(/absolute|malformed|path/i)

    expect(callback).not.toHaveBeenCalled()
    expect(await databaseSnapshot(databasePath)).toEqual(before)
  })

  it('rejects the source directory itself as an indexed file path without writing', async () => {
    const databasePath = createDatabasePath('root-path')
    const fromRoot = path.join(path.dirname(databasePath), 'old')
    await seedLegacyTable(databasePath, [createLegacyRecord(fromRoot)])
    const before = await databaseSnapshot(databasePath)

    await expect(
      relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: path.join(path.dirname(databasePath), 'new'),
        validateDestinations: async () => undefined,
      })
    ).rejects.toThrow(/directory|malformed|path/i)

    expect(await databaseSnapshot(databasePath)).toEqual(before)
  })

  it('does not publish a version or call validation when no paths match', async () => {
    const databasePath = createDatabasePath('no-match')
    const unrelatedPath = path.join(path.dirname(databasePath), 'unrelated', 'document.md')
    const fromRoot = path.join(path.dirname(databasePath), 'never-here')
    const toRoot = path.join(path.dirname(databasePath), 'new-root')
    const store = await seedStore(databasePath, [createChunk(unrelatedPath, 'Untouched')])
    try {
      const before = await databaseSnapshot(databasePath)
      const callback = vi.fn(async () => undefined)

      const result = await relocateIndexedPaths({
        dbPath: databasePath,
        tableName: 'chunks',
        fromPath: fromRoot,
        toPath: toRoot,
        validateDestinations: callback,
      })

      expect(result).toEqual({ filesRelocated: 0, chunksRelocated: 0 })
      expect(callback).not.toHaveBeenCalled()
      expect(await databaseSnapshot(databasePath)).toEqual(before)
    } finally {
      await store.close()
    }
  })

  it('propagates a rejected native update while leaving all rows and the table version unchanged', async () => {
    const databasePath = createDatabasePath('native-update-failure')
    const fromRoot = path.join(path.dirname(databasePath), 'old')
    const toRoot = path.join(path.dirname(databasePath), 'new')
    const store = await seedStore(databasePath, [
      createChunk(path.join(fromRoot, 'one.md'), 'First row'),
      createChunk(path.join(fromRoot, 'two.md'), 'Second row'),
      createChunk(path.join(path.dirname(databasePath), 'unrelated', 'keep.md'), 'Unrelated row'),
    ])
    const connection = await connect(databasePath)

    try {
      const table = await connection.openTable('chunks')
      const prototype: unknown = Object.getPrototypeOf(table)
      if (!hasTableUpdate(prototype)) {
        throw new Error('LanceDB table prototype does not expose update')
      }
      const nativeUpdate = prototype.update
      let attemptedNativeUpdate = false
      let nativeUpdateError: unknown
      const updateSpy = vi.spyOn(prototype, 'update').mockImplementation(async function (
        this: Table,
        options
      ) {
        attemptedNativeUpdate = true
        if (!isRecord(options) || typeof options['where'] !== 'string') {
          throw new Error('Expected relocation to call update with a where clause')
        }
        try {
          return await nativeUpdate.call(
            this,
            {
              filePath: 'missing_relocation_test_function(`filePath`)',
            },
            { where: options['where'] }
          )
        } catch (error) {
          nativeUpdateError = error
          throw error
        }
      })
      const before = await databaseSnapshot(databasePath)

      try {
        await expect(
          relocateIndexedPaths({
            dbPath: databasePath,
            tableName: 'chunks',
            fromPath: fromRoot,
            toPath: toRoot,
            validateDestinations: async () => undefined,
          })
        ).rejects.toThrow()
        expect(attemptedNativeUpdate).toBe(true)
        expect(nativeUpdateError).toBeInstanceOf(Error)
        expect(updateSpy).toHaveBeenCalledOnce()
      } finally {
        updateSpy.mockRestore()
      }

      expect(await databaseSnapshot(databasePath)).toEqual(before)
    } finally {
      connection.close()
      await store.close()
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'maps native Windows aliases across drives in one path-only publication',
    async () => {
      const databasePath = createDatabasePath('windows-paths')
      const toPath = String.raw`d:\MovedRoot\Nested\..`
      const toRoot = path.resolve(toPath)
      const dotSource = String.raw`C:\OldRoot\Docs\.\Dot.md`
      const parentSource = String.raw`C:\OldRoot\Docs\Sub\..\Parent.md`
      const alternativeSeparatorSource = 'C:/OldRoot/Docs/Alternative.md'
      const repeatedSeparatorSource = String.raw`C:\OldRoot\Docs\\Repeated.md`
      const sibling = String.raw`C:\OldRootBackup\stay.md`
      const otherDrive = String.raw`E:\OldRoot\stay.md`
      const expectedMappings: RelocationPathMapping[] = [
        {
          sourcePath: dotSource,
          destinationPath: path.join(toRoot, 'Docs', 'Dot.md'),
        },
        {
          sourcePath: parentSource,
          destinationPath: path.join(toRoot, 'Docs', 'Parent.md'),
        },
        {
          sourcePath: alternativeSeparatorSource,
          destinationPath: path.join(toRoot, 'Docs', 'Alternative.md'),
        },
        {
          sourcePath: repeatedSeparatorSource,
          destinationPath: path.join(toRoot, 'Docs', 'Repeated.md'),
        },
      ]
      const store = await seedStore(databasePath, [
        createChunk(dotSource, 'First selected alias'),
        createChunk(dotSource, 'Second chunk at the same alias', 1),
        createChunk(parentSource, 'Parent-segment alias'),
        createChunk(alternativeSeparatorSource, 'Alternative-separator alias'),
        createChunk(repeatedSeparatorSource, 'Repeated-separator alias'),
        createChunk(sibling, 'Sibling root is not selected'),
        createChunk(otherDrive, 'Other drive is not selected'),
      ])
      try {
        const before = await databaseSnapshot(databasePath)
        const callback = vi.fn(async (_mappings: readonly RelocationPathMapping[]) => undefined)
        const result = await relocateIndexedPaths({
          dbPath: databasePath,
          tableName: 'chunks',
          fromPath: 'c:/oldroot/.',
          toPath,
          validateDestinations: callback,
        })

        expect(callback).toHaveBeenCalledOnce()
        expect(callback.mock.calls[0]?.[0]).toHaveLength(expectedMappings.length)
        expect(callback.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(expectedMappings))
        expect(result).toEqual({ filesRelocated: 4, chunksRelocated: 5 })

        const after = await databaseSnapshot(databasePath)
        expect(after.version).toBe(before.version + 1)
        expect(after.schema).toEqual(before.schema)
        const destinationsBySource = new Map(
          expectedMappings.map(({ sourcePath, destinationPath }) => [sourcePath, destinationPath])
        )
        expect(after.rows).toEqual(
          before.rows.map((row) => {
            const destinationPath = destinationsBySource.get(String(row['filePath']))
            return destinationPath === undefined ? row : { ...row, filePath: destinationPath }
          })
        )
        expect(after.rows.map((row) => row['filePath'])).toContain(sibling)
        expect(after.rows.map((row) => row['filePath'])).toContain(otherDrive)
      } finally {
        await store.close()
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rejects case-insensitive destination collisions without changing legacy rows or schema',
    async () => {
      const databasePath = createDatabasePath('windows-destination-collision')
      const source = String.raw`C:\OldRoot\Docs\same.md`
      const collision = 'D:/movedroot/docs/../docs/SAME.md'
      await seedLegacyTable(databasePath, [
        createLegacyRecord(source),
        createLegacyRecord(collision),
      ])
      const before = await databaseSnapshot(databasePath)
      const callback = vi.fn(async () => undefined)

      await expect(
        relocateIndexedPaths({
          dbPath: databasePath,
          tableName: 'chunks',
          fromPath: 'c:/oldroot',
          toPath: String.raw`D:\MovedRoot`,
          validateDestinations: callback,
        })
      ).rejects.toThrow(/collid/i)

      expect(callback).not.toHaveBeenCalled()
      expect(before.schema.map((field) => field.name)).not.toContain('sourceContext')
      expect(await databaseSnapshot(databasePath)).toEqual(before)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rejects selected source aliases differing by case when they converge on one destination',
    async () => {
      const databasePath = createDatabasePath('windows-source-collision')
      const canonicalSource = String.raw`C:\OldRoot\Docs\Case.md`
      const caseAlias = 'c:/oldroot/docs/temp/../case.md'
      await seedLegacyTable(databasePath, [
        createLegacyRecord(canonicalSource),
        createLegacyRecord(caseAlias),
      ])
      const before = await databaseSnapshot(databasePath)
      const callback = vi.fn(async () => undefined)

      await expect(
        relocateIndexedPaths({
          dbPath: databasePath,
          tableName: 'chunks',
          fromPath: 'c:/oldroot',
          toPath: String.raw`D:\MovedRoot`,
          validateDestinations: callback,
        })
      ).rejects.toThrow(/same destination|collid/i)

      expect(callback).not.toHaveBeenCalled()
      expect(before.schema.map((field) => field.name)).not.toContain('sourceContext')
      expect(await databaseSnapshot(databasePath)).toEqual(before)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rejects roots equivalent after Windows case, separator, and dot normalization without writing',
    async () => {
      const databasePath = createDatabasePath('windows-same-root')
      await seedLegacyTable(databasePath, [createLegacyRecord(String.raw`C:\OldRoot\Docs\file.md`)])
      const before = await databaseSnapshot(databasePath)
      const callback = vi.fn(async () => undefined)

      await expect(
        relocateIndexedPaths({
          dbPath: databasePath,
          tableName: 'chunks',
          fromPath: String.raw`C:\OldRoot\Nested\..`,
          toPath: 'c:/oldroot/./',
          validateDestinations: callback,
        })
      ).rejects.toThrow(/different/i)

      expect(callback).not.toHaveBeenCalled()
      expect(await databaseSnapshot(databasePath)).toEqual(before)
    }
  )
})
