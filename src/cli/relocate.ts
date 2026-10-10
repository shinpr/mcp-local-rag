import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import { toError } from '../utils/errors.js'
import { relocateIndexedPaths } from '../vectordb/relocate.js'
import { formatCliError } from './common.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig, validatePath } from './options.js'

const HELP_TEXT = `Usage: mcp-local-rag [global-options] relocate --from <old-absolute-directory> --to <new-absolute-directory>

Update indexed absolute file paths after moving a project and its files.
The command checks that each mapped destination exists as a regular file; it does not compare file contents.

Options:
  --from <path>          Old absolute directory prefix (need not exist)
  --to <path>            New absolute directory prefix (must exist)
  -h, --help             Show this help

Global options (must appear before "relocate"):
  --db-path <path>       Existing LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

interface RelocateArgs {
  help: boolean
  fromPath?: string
  toPath?: string
}

function usageError(message: string): never {
  console.error(message)
  console.error(HELP_TEXT)
  process.exit(1)
}

function readPathValue(args: string[], index: number, flag: '--from' | '--to'): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    usageError(`Missing value for ${flag}`)
  }
  return value
}

function assignPathOption(result: RelocateArgs, flag: '--from' | '--to', value: string): void {
  const key = flag === '--from' ? 'fromPath' : 'toPath'
  if (result[key] !== undefined) {
    usageError(`Duplicate option: ${flag}`)
  }
  result[key] = value
}

function parseArgs(args: string[]): RelocateArgs {
  const result: RelocateArgs = { help: false }
  let index = 0

  while (index < args.length) {
    const arg = args[index] ?? ''
    if (arg === '-h' || arg === '--help') {
      result.help = true
      index += 1
      continue
    }

    if (arg === '--from' || arg === '--to') {
      assignPathOption(result, arg, readPathValue(args, index, arg))
      index += 2
      continue
    }

    usageError(arg.startsWith('-') ? `Unknown option: ${arg}` : `Unexpected argument: ${arg}`)
  }

  return result
}

function normalizeDirectory(value: string, flag: '--from' | '--to'): string {
  if (value.length === 0) {
    usageError(`${flag} value must not be empty`)
  }
  if (value.includes('\0')) {
    usageError(`${flag} must be a valid absolute directory path`)
  }
  if (!path.isAbsolute(value)) {
    usageError(`${flag} must be absolute`)
  }
  return path.resolve(value)
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function requireDestinationDirectory(directory: string): Promise<void> {
  const info = await stat(directory).catch((error: unknown) => {
    throw new Error(`Destination directory is missing or cannot be accessed: ${directory}`, {
      cause: toError(error),
    })
  })
  if (!info.isDirectory()) {
    throw new Error(`Destination is not a directory: ${directory}`)
  }
}

async function validateDestinationFiles(
  mappings: readonly { destinationPath: string }[]
): Promise<void> {
  for (const { destinationPath } of mappings) {
    const info = await stat(destinationPath).catch((error: unknown) => {
      throw new Error(`Destination file is missing or cannot be accessed: ${destinationPath}`, {
        cause: toError(error),
      })
    })
    if (!info.isFile()) {
      throw new Error(`Destination is not a regular file: ${destinationPath}`)
    }
  }
}

export async function runRelocate(
  args: string[],
  globalOptions: GlobalOptions = {}
): Promise<void> {
  const parsed = parseArgs(args)
  if (parsed.help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }
  if (parsed.fromPath === undefined) {
    usageError('--from is required')
  }
  if (parsed.toPath === undefined) {
    usageError('--to is required')
  }

  const fromPath = normalizeDirectory(parsed.fromPath, '--from')
  const toPath = normalizeDirectory(parsed.toPath, '--to')
  if (samePath(fromPath, toPath)) {
    usageError('--from and --to must be different directories')
  }

  const globalConfig = resolveGlobalConfig(globalOptions)
  const destinationPathError = validatePath(toPath, '--to')
  if (destinationPathError) {
    console.error(destinationPathError)
    process.exit(1)
  }

  try {
    await requireDestinationDirectory(toPath)
    const result = await relocateIndexedPaths({
      dbPath: globalConfig.dbPath,
      tableName: 'chunks',
      fromPath,
      toPath,
      validateDestinations: validateDestinationFiles,
    })
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    console.error(`Error: ${formatCliError(error)}`)
    process.exitCode = 1
  }
}
