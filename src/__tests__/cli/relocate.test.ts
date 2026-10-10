import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from '@lancedb/lancedb'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateMetaJsonPath,
  generateRawDataPath,
  type RawDataMeta,
  saveMetaJson,
} from '../../utils/raw-data-utils.js'
import { isRecord } from '../../utils/type-guards.js'
import { type VectorChunk, VectorStore } from '../../vectordb/index.js'

const testFile = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(testFile), '../../..')
const cliEntry = path.resolve(projectRoot, 'src/index.ts')
const tempRoots = new Set<string>()

interface CliResult {
  status: number | null
  stderr: string
  stdout: string
}

interface DatabaseSnapshot {
  version: number
  schema: Array<{ name: string; type: string }>
  rows: Array<Record<string, unknown>>
}

interface MovedProjectFixture {
  tempRoot: string
  oldRoot: string
  newRoot: string
  newDatabasePath: string
  oldDocumentPaths: string[]
  newDocumentPaths: string[]
  oldRawDataPath: string
  newRawDataPath: string
  unrelatedPath: string
  sidecar: RawDataMeta
  before: DatabaseSnapshot
}

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 30000,
  })
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function createTempRoot(): string {
  const tempRoot = path.resolve(projectRoot, 'tmp', `relocate-cli-${randomUUID()}`)
  tempRoots.add(tempRoot)
  return tempRoot
}

function createChunk(filePath: string, id: string, text: string, chunkIndex = 0): VectorChunk {
  return {
    id,
    filePath,
    chunkIndex,
    text,
    vector: [1, 0, 0],
    metadata: {
      fileName: path.basename(filePath),
      fileSize: Buffer.byteLength(text),
      fileType: path.extname(filePath).slice(1),
    },
    fileTitle: `Title for ${path.basename(filePath)}`,
    contentHash: `hash-${id}`,
    visualAttachments: '[]',
    visualProfile: 'quality',
    sourceContext: JSON.stringify({ headingPaths: [['Relocation', 'Preserved']] }),
    timestamp: '2026-10-10T00:00:00.000Z',
  }
}

function normalizeRow(value: unknown): Record<string, unknown> {
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

async function snapshotDatabase(databasePath: string): Promise<DatabaseSnapshot> {
  const connection = await connect(databasePath)
  try {
    const table = await connection.openTable('chunks')
    const schema = await table.schema()
    const rows = await table.query().toArray()
    return {
      version: await table.version(),
      schema: schema.fields.map((field) => ({ name: field.name, type: String(field.type) })),
      rows: rows
        .map(normalizeRow)
        .sort((left, right) => String(left['id']).localeCompare(String(right['id']))),
    }
  } finally {
    connection.close()
  }
}

async function seedDatabase(databasePath: string, chunks: VectorChunk[]): Promise<void> {
  const store = new VectorStore({ dbPath: databasePath, tableName: 'chunks' })
  await store.initialize()
  await store.insertChunks(chunks)
  await store.close()
}

async function createMovedProjectFixture(): Promise<MovedProjectFixture> {
  const tempRoot = createTempRoot()
  await mkdir(tempRoot, { recursive: true })
  const oldRoot = path.join(tempRoot, 'before')
  const newRoot = path.join(tempRoot, 'after')
  const oldDatabasePath = path.join(oldRoot, 'lancedb')
  const newDatabasePath = path.join(newRoot, 'lancedb')
  const oldDocumentPaths = [
    path.join(oldRoot, 'docs', 'manual', 'intro.md'),
    path.join(oldRoot, 'docs', 'reference', 'api.md'),
  ]
  const unrelatedPath = path.join(tempRoot, 'unrelated.md')
  const source = 'https://example.org/relocation-source'
  const oldRawDataPath = generateRawDataPath(oldDatabasePath, source)
  const sidecar: RawDataMeta = {
    title: 'Relocated source',
    source,
    format: 'markdown',
  }

  await Promise.all([
    mkdir(path.dirname(oldDocumentPaths[0] ?? ''), { recursive: true }),
    mkdir(path.dirname(oldDocumentPaths[1] ?? ''), { recursive: true }),
    mkdir(path.dirname(unrelatedPath), { recursive: true }),
    mkdir(path.dirname(oldRawDataPath), { recursive: true }),
  ])
  await Promise.all([
    writeFile(oldDocumentPaths[0] ?? '', '# Intro before moving\n', 'utf-8'),
    writeFile(oldDocumentPaths[1] ?? '', '# API before moving\n', 'utf-8'),
    writeFile(unrelatedPath, '# Unrelated document\n', 'utf-8'),
    writeFile(oldRawDataPath, '# Raw content\n', 'utf-8'),
  ])
  await saveMetaJson(oldRawDataPath, sidecar)

  const chunks = [
    createChunk(oldDocumentPaths[0] ?? '', 'manual-a', 'Original indexed intro text', 0),
    createChunk(oldDocumentPaths[0] ?? '', 'manual-b', 'Second original intro chunk', 1),
    createChunk(oldDocumentPaths[1] ?? '', 'reference-a', 'Original indexed API text'),
    createChunk(oldRawDataPath, 'raw-a', 'Original indexed raw-data text'),
    createChunk(unrelatedPath, 'unrelated-a', 'Unrelated indexed text'),
  ]
  await seedDatabase(oldDatabasePath, chunks)
  const before = await snapshotDatabase(oldDatabasePath)

  await rename(oldRoot, newRoot)
  const newDocumentPaths = oldDocumentPaths.map((filePath) =>
    path.join(newRoot, path.relative(oldRoot, filePath))
  )
  const newRawDataPath = path.join(newRoot, path.relative(oldRoot, oldRawDataPath))

  // The command is an existence check, not a content-identity check.
  await Promise.all([
    writeFile(newDocumentPaths[0] ?? '', '# Changed content at the moved path\n', 'utf-8'),
    writeFile(newDocumentPaths[1] ?? '', '# Different content at the moved path\n', 'utf-8'),
  ])

  return {
    tempRoot,
    oldRoot,
    newRoot,
    newDatabasePath,
    oldDocumentPaths,
    newDocumentPaths,
    oldRawDataPath,
    newRawDataPath,
    unrelatedPath,
    sidecar,
    before,
  }
}

async function moveSingleDocumentProject(): Promise<{
  tempRoot: string
  oldRoot: string
  newRoot: string
  databasePath: string
  oldFilePath: string
  newFilePath: string
  unrelatedPath: string
}> {
  const tempRoot = createTempRoot()
  await mkdir(tempRoot, { recursive: true })
  const oldRoot = path.join(tempRoot, 'before')
  const newRoot = path.join(tempRoot, 'after')
  const databasePath = path.join(oldRoot, 'lancedb')
  const oldFilePath = path.join(oldRoot, 'docs', 'nested', 'file.md')
  const unrelatedPath = path.join(tempRoot, 'unrelated.md')
  await Promise.all([
    mkdir(path.dirname(oldFilePath), { recursive: true }),
    writeFile(unrelatedPath, '# Unrelated\n', 'utf-8'),
  ])
  await writeFile(oldFilePath, '# Before\n', 'utf-8')
  await seedDatabase(databasePath, [
    createChunk(oldFilePath, 'selected', 'Selected indexed text'),
    createChunk(unrelatedPath, 'unrelated', 'Unrelated indexed text'),
  ])
  await rename(oldRoot, newRoot)
  const newFilePath = path.join(newRoot, path.relative(oldRoot, oldFilePath))
  return {
    tempRoot,
    oldRoot,
    newRoot,
    databasePath: path.join(newRoot, 'lancedb'),
    oldFilePath,
    newFilePath,
    unrelatedPath,
  }
}

function relocateArgs(databasePath: string, fromPath: string, toPath: string): string[] {
  return ['--db-path', databasePath, 'relocate', '--from', fromPath, '--to', toPath]
}

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })))
  tempRoots.clear()
})

describe('relocate CLI', () => {
  it('relocates a moved project and database without reading changed content or touching unrelated rows and sidecars', async () => {
    const fixture = await createMovedProjectFixture()
    const result = runCli(relocateArgs(fixture.newDatabasePath, fixture.oldRoot, fixture.newRoot))

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ filesRelocated: 3, chunksRelocated: 4 })
    await expect(access(fixture.oldRoot)).rejects.toThrow()
    expect(await readFile(fixture.newDocumentPaths[0] ?? '', 'utf-8')).toContain('Changed content')
    expect(await readFile(generateMetaJsonPath(fixture.newRawDataPath), 'utf-8')).toBe(
      JSON.stringify(fixture.sidecar, null, 2)
    )

    const after = await snapshotDatabase(fixture.newDatabasePath)
    expect(after.version).toBe(fixture.before.version + 1)
    expect(after.schema).toEqual(fixture.before.schema)
    expect(after.rows).toHaveLength(fixture.before.rows.length)

    const priorRows = new Map(fixture.before.rows.map((row) => [row['id'], row]))
    for (const row of after.rows) {
      const prior = priorRows.get(row['id'])
      expect(prior).toBeDefined()
      const priorData = { ...(prior ?? {}) }
      delete priorData['filePath']
      const { filePath, ...updatedData } = row
      expect(updatedData).toEqual(priorData)

      if (fixture.oldDocumentPaths.includes(String(prior?.['filePath']))) {
        const index = fixture.oldDocumentPaths.indexOf(String(prior?.['filePath']))
        expect(filePath).toBe(fixture.newDocumentPaths[index])
      } else if (prior?.['filePath'] === fixture.oldRawDataPath) {
        expect(filePath).toBe(fixture.newRawDataPath)
      } else {
        expect(filePath).toBe(fixture.unrelatedPath)
      }
    }
  })

  it.each(['missing', 'directory', 'stat-error', 'dangling-link'] as const)(
    'fails before mutation when a destination is a %s',
    async (destinationState) => {
      const fixture = await moveSingleDocumentProject()
      if (destinationState === 'missing') {
        await rm(fixture.newFilePath)
      } else if (destinationState === 'directory') {
        await rm(fixture.newFilePath)
        await mkdir(fixture.newFilePath)
      } else if (destinationState === 'stat-error') {
        const docsPath = path.join(fixture.newRoot, 'docs')
        await rm(docsPath, { recursive: true })
        await writeFile(docsPath, 'not a directory', 'utf-8')
      } else {
        await rm(fixture.newFilePath)
        await symlink(path.join(fixture.tempRoot, 'missing-target.md'), fixture.newFilePath, 'file')
      }

      const before = await snapshotDatabase(fixture.databasePath)
      const result = runCli(relocateArgs(fixture.databasePath, fixture.oldRoot, fixture.newRoot))

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(fixture.newFilePath)
      const after = await snapshotDatabase(fixture.databasePath)
      expect(after).toEqual(before)
    }
  )

  it('accepts a symlink whose target is a regular file', async () => {
    const fixture = await moveSingleDocumentProject()
    const targetPath = path.join(fixture.newRoot, 'replacement.md')
    await writeFile(targetPath, '# Different file contents\n', 'utf-8')
    await rm(fixture.newFilePath)
    await symlink(targetPath, fixture.newFilePath, 'file')

    const result = runCli(relocateArgs(fixture.databasePath, fixture.oldRoot, fixture.newRoot))

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ filesRelocated: 1, chunksRelocated: 1 })
  })

  it('reports zero matches without publishing a table update', async () => {
    const fixture = await moveSingleDocumentProject()
    const before = await snapshotDatabase(fixture.databasePath)
    const result = runCli(
      relocateArgs(
        fixture.databasePath,
        path.join(fixture.tempRoot, 'absent-root'),
        fixture.newRoot
      )
    )

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ filesRelocated: 0, chunksRelocated: 0 })
    expect(await snapshotDatabase(fixture.databasePath)).toEqual(before)
  })

  it('rejects a missing destination directory before opening the relocation operation', async () => {
    const fixture = await moveSingleDocumentProject()
    const missingDestination = path.join(fixture.tempRoot, 'missing-destination')
    const before = await snapshotDatabase(fixture.databasePath)
    const result = runCli(relocateArgs(fixture.databasePath, fixture.oldRoot, missingDestination))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(missingDestination)
    expect(await snapshotDatabase(fixture.databasePath)).toEqual(before)
  })

  it('rejects a destination path that is a file without mutating the database', async () => {
    const fixture = await moveSingleDocumentProject()
    const destinationFile = path.join(fixture.tempRoot, 'not-a-directory')
    await writeFile(destinationFile, 'not a directory', 'utf-8')
    const before = await snapshotDatabase(fixture.databasePath)
    const result = runCli(relocateArgs(fixture.databasePath, fixture.oldRoot, destinationFile))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Destination is not a directory')
    expect(await snapshotDatabase(fixture.databasePath)).toEqual(before)
  })

  it('rejects a missing database without creating it', async () => {
    const tempRoot = createTempRoot()
    await mkdir(tempRoot, { recursive: true })
    const missingDatabase = path.join(tempRoot, 'never-created')
    const fromPath = path.join(tempRoot, 'before')
    const toPath = path.join(tempRoot, 'after')
    await mkdir(toPath, { recursive: true })

    const result = runCli(relocateArgs(missingDatabase, fromPath, toPath))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Database directory does not exist')
    await expect(access(missingDatabase)).rejects.toThrow()
  })

  it('rejects an existing database without a chunks table', async () => {
    const tempRoot = createTempRoot()
    await mkdir(tempRoot, { recursive: true })
    const emptyDatabase = path.join(tempRoot, 'empty-database')
    const toPath = path.join(tempRoot, 'after')
    await Promise.all([mkdir(emptyDatabase), mkdir(toPath)])

    const result = runCli(relocateArgs(emptyDatabase, path.join(tempRoot, 'before'), toPath))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Table does not exist: chunks')
    const connection = await connect(emptyDatabase)
    try {
      expect(await connection.tableNames()).not.toContain('chunks')
    } finally {
      connection.close()
    }
  })

  const invalidArgumentCases: { args: string[]; message: string }[] = [
    { args: [], message: '--from is required' },
    { args: ['--from', '/old'], message: '--to is required' },
    {
      args: ['--from', '', '--to', '/new'],
      message: '--from value must not be empty',
    },
    { args: ['--from', 'relative', '--to', '/new'], message: '--from must be absolute' },
    { args: ['--from', '/old', '--to', 'relative'], message: '--to must be absolute' },
    { args: ['--from', '/same', '--to', '/same'], message: 'must be different' },
    {
      args: ['--from', '/old', '--from', '/older', '--to', '/new'],
      message: 'Duplicate option: --from',
    },
    {
      args: ['--from', '/old', '--to', '/new', '--to', '/newer'],
      message: 'Duplicate option: --to',
    },
    { args: ['--from', '/old', '--to', '/new', '--unknown'], message: 'Unknown option: --unknown' },
  ]

  it.each(invalidArgumentCases)('rejects invalid arguments: $message', ({ args, message }) => {
    const result = runCli(['relocate', ...args])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })
})
