// CLI read-neighbors subcommand — read N chunks before/after a target chunk within one document

import { resolve } from 'node:path'
import { MAX_NEIGHBOR_COUNT } from '../utils/limits.js'
import {
  extractSourceFromPath,
  generateRawDataPath,
  isManagedRawDataPath,
} from '../utils/raw-data-utils.js'
import { createVectorStore, formatCliError } from './common.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig, validatePath } from './options.js'

// ============================================
// Defaults
// ============================================

const READ_NEIGHBORS_DEFAULTS = {
  before: 2,
  after: 2,
} as const

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] read-neighbors [options]

Read N chunks before and after a target chunk within the same document.

Either --file-path or --source is required, not both.

Options:
  --file-path <abs-path>   File path of ingested content (absolute path)
  --source <id>            Source identifier (for content ingested via ingest_data)
  --chunk-index <n>        Target chunk index (zero-based, required, non-negative integer)
  --before <n>             Number of chunks before the target (default: ${READ_NEIGHBORS_DEFAULTS.before}, non-negative integer)
  --after <n>              Number of chunks after the target (default: ${READ_NEIGHBORS_DEFAULTS.after}, non-negative integer)
  -h, --help               Show this help

Defaults: before=${READ_NEIGHBORS_DEFAULTS.before}, after=${READ_NEIGHBORS_DEFAULTS.after} (grep -C 2 convention)

Example:
  npx mcp-local-rag read-neighbors --file-path /abs/path/file.md --chunk-index 12 --before 3 --after 3

Global options (must appear before "read-neighbors"):
  --db-path <path>         LanceDB database path
  --cache-dir <path>       Model cache directory
  --model-name <name>      Embedding model`

// ============================================
// Arg Parsing
// ============================================

interface ReadNeighborsArgs {
  help: boolean
  filePath?: string
  source?: string
  chunkIndex?: number
  before?: number
  after?: number
}

/**
 * Parse a value expected to be a non-negative integer flag value.
 * Throws a descriptive Error on malformed input; the outer runReadNeighbors
 * try/catch converts this into `console.error` + `process.exit(1)`.
 */
function parseNonNegativeInteger(flag: string, rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`)
  }
  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== rawValue) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return parsed
}

/**
 * Parse read-neighbors CLI arguments.
 * Flags: --file-path, --source, --chunk-index, --before, --after, -h/--help.
 * Integer flags are validated syntactically (must be non-negative integer).
 * Semantic validation (required-ness, XOR) is performed in runReadNeighbors.
 */
/** Flags whose value is taken verbatim, mapped to the field they fill. */
const STRING_FLAGS = new Map<string, 'filePath' | 'source'>([
  ['--file-path', 'filePath'],
  ['--source', 'source'],
])

/** Flags whose value must parse as a non-negative integer. */
const INTEGER_FLAGS = new Map<string, 'chunkIndex' | 'before' | 'after'>([
  ['--chunk-index', 'chunkIndex'],
  ['--before', 'before'],
  ['--after', 'after'],
])

/** Take a flag's value, rejecting an absent one or the next flag. */
function requireValue(flag: string, rawValue: string | undefined): string {
  if (rawValue === undefined || rawValue.startsWith('-')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return rawValue
}

function parseArgs(args: string[]): ReadNeighborsArgs {
  const result: ReadNeighborsArgs = { help: false }

  let i = 0
  while (i < args.length) {
    const arg = args[i] ?? ''

    if (arg === '-h' || arg === '--help') {
      result.help = true
      i += 1
      continue
    }

    const stringKey = STRING_FLAGS.get(arg)
    if (stringKey !== undefined) {
      result[stringKey] = requireValue(arg, args[i + 1])
      i += 2
      continue
    }

    const integerKey = INTEGER_FLAGS.get(arg)
    if (integerKey !== undefined) {
      result[integerKey] = parseNonNegativeInteger(arg, args[i + 1])
      i += 2
      continue
    }

    throw new Error(arg.startsWith('-') ? `Unknown option: ${arg}` : `Unexpected argument: ${arg}`)
  }

  return result
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the read-neighbors CLI subcommand.
 * Reads chunks adjacent to a target chunkIndex within a single document.
 * Does NOT perform any search; this is an index-adjacent retrieval utility.
 */
/** The neighbor window a validated request asks for. */
interface NeighborRequest {
  chunkIndex: number
  before: number
  after: number
}

/**
 * Apply the same validation order as the MCP handler: chunkIndex, then the
 * window bounds, then the file-path/source XOR.
 */
function validateRequest(parsed: ReadNeighborsArgs): NeighborRequest {
  if (parsed.chunkIndex === undefined) {
    throw new Error('--chunk-index is required and must be a non-negative integer')
  }
  const before = parsed.before ?? READ_NEIGHBORS_DEFAULTS.before
  if (before > MAX_NEIGHBOR_COUNT) {
    throw new Error(`before must be between 0 and ${MAX_NEIGHBOR_COUNT} (got ${before})`)
  }
  const after = parsed.after ?? READ_NEIGHBORS_DEFAULTS.after
  if (after > MAX_NEIGHBOR_COUNT) {
    throw new Error(`after must be between 0 and ${MAX_NEIGHBOR_COUNT} (got ${after})`)
  }
  if (parsed.filePath === undefined && parsed.source === undefined) {
    throw new Error('Either --file-path or --source is required')
  }
  if (parsed.filePath !== undefined && parsed.source !== undefined) {
    throw new Error('Cannot specify both --file-path and --source')
  }
  return { chunkIndex: parsed.chunkIndex, before, after }
}

/** Resolve the document to read from either input form. */
function resolveTargetPath(parsed: ReadNeighborsArgs, dbPath: string): string {
  if (parsed.source !== undefined) {
    return generateRawDataPath(dbPath, parsed.source)
  }
  // DB key is the resolve()'d ingest path, so look up by resolve() (never
  // realpath); validate here (mirrors runDelete; realpath stays there).
  const targetPath = resolve(parsed.filePath ?? '')
  const pathError = validatePath(targetPath, '--file-path')
  if (pathError) {
    console.error(pathError)
    process.exit(1)
  }
  return targetPath
}

export async function runReadNeighbors(
  args: string[],
  globalOptions: GlobalOptions = {}
): Promise<void> {
  // Parse CLI options (parse errors are caught and converted to exit(1) below).
  let parsed: ReadNeighborsArgs
  try {
    parsed = parseArgs(args)
  } catch (error) {
    const reason = formatCliError(error)
    console.error(`Error: ${reason}`)
    process.exit(1)
  }

  // Handle --help OUTSIDE the main try/catch so exit(0) is not converted to exit(1).
  // Mirrors src/cli/delete.ts and src/cli/query.ts.
  if (parsed.help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  try {
    const request = validateRequest(parsed)
    const globalConfig = resolveGlobalConfig(globalOptions)
    const targetPath = resolveTargetPath(parsed, globalConfig.dbPath)

    const vectorStore = createVectorStore(globalConfig)
    try {
      await vectorStore.initialize()

      const rows = await vectorStore.getChunksByRange(
        targetPath,
        Math.max(0, request.chunkIndex - request.before),
        request.chunkIndex + request.after
      )

      const sourceForAll = isManagedRawDataPath(targetPath, globalConfig.dbPath)
        ? extractSourceFromPath(targetPath)
        : null
      const items = rows.map((row) => ({
        filePath: row.filePath,
        chunkIndex: row.chunkIndex,
        text: row.text,
        isTarget: row.chunkIndex === request.chunkIndex,
        fileTitle: row.fileTitle ?? null,
        ...(sourceForAll ? { source: sourceForAll } : {}),
      }))

      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`)
    } finally {
      await vectorStore.close()
    }
  } catch (error) {
    const reason = formatCliError(error)
    console.error(`Error: ${reason}`)
    process.exitCode = 1
  }
}
