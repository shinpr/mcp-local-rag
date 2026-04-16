// CLI read-neighbors subcommand — read N chunks before/after a target chunk within one document

import { resolve } from 'node:path'
import {
  extractSourceFromPath,
  generateRawDataPath,
  isRawDataPath,
} from '../utils/raw-data-utils.js'
import { createVectorStore } from './common.js'
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
function parseArgs(args: string[]): ReadNeighborsArgs {
  let help = false
  let filePath: string | undefined
  let source: string | undefined
  let chunkIndex: number | undefined
  let before: number | undefined
  let after: number | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    if (arg === '-h' || arg === '--help') {
      help = true
      i++
    } else if (arg === '--file-path') {
      const value = args[++i]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('Missing value for --file-path')
      }
      filePath = value
      i++
    } else if (arg === '--source') {
      const value = args[++i]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('Missing value for --source')
      }
      source = value
      i++
    } else if (arg === '--chunk-index') {
      chunkIndex = parseNonNegativeInteger('--chunk-index', args[++i])
      i++
    } else if (arg === '--before') {
      before = parseNonNegativeInteger('--before', args[++i])
      i++
    } else if (arg === '--after') {
      after = parseNonNegativeInteger('--after', args[++i])
      i++
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }

  const result: ReadNeighborsArgs = { help }
  if (filePath !== undefined) result.filePath = filePath
  if (source !== undefined) result.source = source
  if (chunkIndex !== undefined) result.chunkIndex = chunkIndex
  if (before !== undefined) result.before = before
  if (after !== undefined) result.after = after
  return result
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the read-neighbors CLI subcommand.
 * Reads chunks adjacent to a target chunkIndex within a single document.
 * Does NOT perform any search; this is an index-adjacent retrieval utility.
 *
 * @param args - Arguments after "read-neighbors"
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runReadNeighbors(
  args: string[],
  globalOptions: GlobalOptions = {}
): Promise<void> {
  try {
    // Parse CLI options
    const parsed = parseArgs(args)

    // Handle --help
    if (parsed.help) {
      console.error(HELP_TEXT)
      process.exit(0)
    }

    // Validation order: chunkIndex → before → after → XOR (matches handler per Design Doc).
    if (parsed.chunkIndex === undefined) {
      throw new Error('--chunk-index is required and must be a non-negative integer')
    }
    const chunkIndex = parsed.chunkIndex

    const before = parsed.before ?? READ_NEIGHBORS_DEFAULTS.before
    const after = parsed.after ?? READ_NEIGHBORS_DEFAULTS.after

    // XOR: exactly one of --file-path / --source
    const hasFilePath = parsed.filePath !== undefined
    const hasSource = parsed.source !== undefined
    if (!hasFilePath && !hasSource) {
      throw new Error('Either --file-path or --source is required')
    }
    if (hasFilePath && hasSource) {
      throw new Error('Cannot specify both --file-path and --source')
    }

    // Resolve global config
    const globalConfig = resolveGlobalConfig(globalOptions)

    // Determine target file path (dual-input resolution).
    let targetPath: string
    if (parsed.source !== undefined) {
      // Generate raw-data path from source identifier.
      targetPath = generateRawDataPath(globalConfig.dbPath, parsed.source, 'markdown')
    } else {
      // Resolve to absolute path and validate (mirrors runDelete).
      targetPath = resolve(parsed.filePath!)
      const pathError = validatePath(targetPath, '--file-path')
      if (pathError) {
        console.error(pathError)
        process.exit(1)
      }
    }

    // Create and initialize VectorStore (no embedder needed for index-only read).
    const vectorStore = createVectorStore(globalConfig)
    await vectorStore.initialize()

    // Range composition (handler-side clamp; primitive stays feature-agnostic).
    const minIdx = Math.max(0, chunkIndex - before)
    const maxIdx = chunkIndex + after

    // Primitive call.
    const rows = await vectorStore.getChunksByRange(targetPath, minIdx, maxIdx)

    // Post-fetch marking: isTarget per item; source attached for raw-data rows.
    const isRaw = isRawDataPath(targetPath)
    const sourceForAll = isRaw ? extractSourceFromPath(targetPath) : null
    const items = rows.map((row) => {
      const item: {
        filePath: string
        chunkIndex: number
        text: string
        isTarget: boolean
        fileTitle: string | null
        source?: string
      } = {
        filePath: row.filePath,
        chunkIndex: row.chunkIndex,
        text: row.text,
        isTarget: row.chunkIndex === chunkIndex,
        fileTitle: row.fileTitle ?? null,
      }
      if (sourceForAll) item.source = sourceForAll
      return item
    })

    // Output JSON to stdout (2-space indent per query.ts convention).
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${reason}`)
    process.exit(1)
  }
}
