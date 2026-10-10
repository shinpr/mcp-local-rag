import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import { type Connection, connect } from '@lancedb/lancedb'
import { toError } from '../utils/errors.js'
import { isRecord } from '../utils/type-guards.js'
import { DatabaseError } from './types.js'

export interface RelocationPathMapping {
  sourcePath: string
  destinationPath: string
}

export interface RelocateIndexedPathsOptions {
  dbPath: string
  tableName: string
  fromPath: string
  toPath: string
  validateDestinations: (mappings: readonly RelocationPathMapping[]) => Promise<void>
}

export interface RelocateIndexedPathsResult {
  filesRelocated: number
  chunksRelocated: number
}

interface IndexedPathSnapshot {
  filePaths: string[]
  mappings: RelocationPathMapping[]
  chunksRelocated: number
}

/** Move indexed file keys beneath one directory prefix in a single table update. */
export async function relocateIndexedPaths(
  options: RelocateIndexedPathsOptions
): Promise<RelocateIndexedPathsResult> {
  let connection: Connection | undefined

  try {
    const { dbPath, tableName, validateDestinations } = options
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
      throw new DatabaseError('Relocation requires an existing database path')
    }
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new DatabaseError('Relocation requires a table name')
    }
    if (typeof validateDestinations !== 'function') {
      throw new DatabaseError('Relocation requires destination validation')
    }

    const fromRoot = normalizeDirectory(options.fromPath, 'source')
    const toRoot = normalizeDirectory(options.toPath, 'destination')
    if (samePath(fromRoot, toRoot)) {
      throw new DatabaseError('Source and destination directories must be different')
    }

    const dbInfo = await stat(dbPath).catch((error: unknown) => {
      throw new DatabaseError(`Database directory does not exist: ${dbPath}`, {
        cause: toError(error),
      })
    })
    if (!dbInfo.isDirectory()) {
      throw new DatabaseError(`Database path is not a directory: ${dbPath}`)
    }

    connection = await connect(dbPath, { readConsistencyInterval: 0 })
    if (!(await connection.tableNames()).includes(tableName)) {
      throw new DatabaseError(`Table does not exist: ${tableName}`)
    }

    const table = await connection.openTable(tableName)
    const rawRows = await table.query().select(['filePath']).toArray()
    const snapshot = createSnapshot(rawRows, fromRoot, toRoot)
    if (snapshot.mappings.length === 0) {
      return { filesRelocated: 0, chunksRelocated: 0 }
    }

    try {
      await validateDestinations(snapshot.mappings)
    } catch (error) {
      throw new DatabaseError('Destination validation failed; no database changes were made', {
        cause: toError(error),
      })
    }

    const sourceLiterals = snapshot.mappings.map(({ sourcePath }) => sqlString(sourcePath))
    const destinationLiterals = snapshot.mappings.map(({ destinationPath }) =>
      sqlString(destinationPath)
    )
    const sourceList = `[${sourceLiterals.join(', ')}]`
    const destinationList = `[${destinationLiterals.join(', ')}]`
    await table.update({
      where: `\`filePath\` IN (${sourceLiterals.join(', ')})`,
      valuesSql: {
        filePath: `array_element(${destinationList}, CAST(array_position(${sourceList}, \`filePath\`) AS BIGINT))`,
      },
    })

    return {
      filesRelocated: snapshot.mappings.length,
      chunksRelocated: snapshot.chunksRelocated,
    }
  } catch (error) {
    if (error instanceof DatabaseError) {
      throw error
    }
    throw new DatabaseError('Failed to relocate indexed paths', { cause: toError(error) })
  } finally {
    connection?.close()
  }
}

function normalizeDirectory(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw new DatabaseError(`The ${label} directory must be an absolute native path`)
  }
  return path.resolve(value)
}

function validateStoredPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw new DatabaseError('Indexed file paths must be non-empty absolute native paths')
  }
  if (value.endsWith(path.sep) || (process.platform === 'win32' && value.endsWith('/'))) {
    throw new DatabaseError(`Indexed file path is malformed: ${value}`)
  }
  return value
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isOutsideRelativePath(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
}

function relativeWithin(root: string, candidate: string): string | null {
  const relativePath = path.relative(root, path.normalize(candidate))
  if (isOutsideRelativePath(relativePath)) {
    return null
  }
  return relativePath
}

function createSnapshot(rawRows: unknown[], fromRoot: string, toRoot: string): IndexedPathSnapshot {
  const filePaths = rawRows.map(readIndexedPath)
  const mappings = createMappings(filePaths, fromRoot, toRoot)
  assertNoDestinationCollisions(filePaths, mappings)
  const sourcePaths = new Set(mappings.map(({ sourcePath }) => sourcePath))

  return {
    filePaths,
    mappings,
    chunksRelocated: filePaths.filter((filePath) => sourcePaths.has(filePath)).length,
  }
}

function readIndexedPath(row: unknown): string {
  if (!isRecord(row)) {
    throw new DatabaseError('Invalid indexed path row returned by LanceDB')
  }
  return validateStoredPath(row['filePath'])
}

function createMappings(
  filePaths: string[],
  fromRoot: string,
  toRoot: string
): RelocationPathMapping[] {
  const selected = new Map<string, string>()
  for (const filePath of filePaths) {
    if (selected.has(filePath)) {
      continue
    }
    const relativePath = relativeWithin(fromRoot, filePath)
    if (relativePath === null) {
      continue
    }
    if (relativePath.length === 0) {
      throw new DatabaseError(`Indexed path is the source directory itself: ${filePath}`)
    }

    const destinationPath = path.join(toRoot, relativePath)
    const destinationRelativePath = relativeWithin(toRoot, destinationPath)
    if (destinationRelativePath === null || destinationRelativePath.length === 0) {
      throw new DatabaseError(`Relocated path is outside the destination directory: ${filePath}`)
    }
    selected.set(filePath, destinationPath)
  }

  return [...selected].map(([sourcePath, destinationPath]) => ({
    sourcePath,
    destinationPath,
  }))
}

function assertNoDestinationCollisions(
  filePaths: string[],
  mappings: RelocationPathMapping[]
): void {
  const sourceKeys = new Set(mappings.map(({ sourcePath }) => pathKey(sourcePath)))
  const indexedPathKeys = new Set(filePaths.map(pathKey))
  const destinationOwners = new Map<string, string>()
  for (const mapping of mappings) {
    const destinationKey = pathKey(mapping.destinationPath)
    const previousSource = destinationOwners.get(destinationKey)
    if (previousSource !== undefined && previousSource !== mapping.sourcePath) {
      throw new DatabaseError(
        `Multiple indexed paths map to the same destination: ${mapping.destinationPath}`
      )
    }
    destinationOwners.set(destinationKey, mapping.sourcePath)

    if (indexedPathKeys.has(destinationKey) && !sourceKeys.has(destinationKey)) {
      const existingKey = filePaths.find((filePath) => pathKey(filePath) === destinationKey)
      throw new DatabaseError(
        `Relocation destination collides with an indexed path: ${existingKey}`
      )
    }
  }
}

function pathKey(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
