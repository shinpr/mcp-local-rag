// CLI list subcommand — list files and ingestion status

import { readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { extractSourceFromPath, isRawDataPath } from '../utils/raw-data-utils.js'
import { createVectorStore } from './common.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig, validatePath } from './options.js'

// ============================================
// Types
// ============================================

interface ListCliOptions {
  baseDir?: string | undefined
}

interface ParsedArgs {
  options: ListCliOptions
  help: boolean
}

interface FileEntry {
  filePath: string
  ingested: boolean
  chunkCount?: number
  timestamp?: string
}

interface SourceEntry {
  source?: string
  filePath?: string
  chunkCount: number
  timestamp: string
}

interface ListResult {
  baseDir: string
  files: FileEntry[]
  sources: SourceEntry[]
}

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] list [options]

List files and their ingestion status.

Options:
  --base-dir <path>      Base directory to scan for files (default: BASE_DIR env or cwd)
  -h, --help             Show this help

Global options (must appear before "list"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse list-specific CLI arguments.
 * Flags: --base-dir, -h/--help
 * No positional arguments accepted.
 * Unknown flags cause exit(1).
 */
export function parseArgs(args: string[]): ParsedArgs {
  const options: ListCliOptions = {}
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        i++
        break
      case '--base-dir': {
        const value = args[++i]
        if (value === undefined || value.startsWith('-')) {
          console.error('Missing value for --base-dir')
          process.exit(1)
        }
        options.baseDir = value
        i++
        break
      }
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        console.error(`Unexpected argument: ${arg}`)
        console.error('The list command does not accept positional arguments.')
        process.exit(1)
    }
  }

  return { options, help }
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the list CLI subcommand.
 * @param args - Arguments after "list"
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runList(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Resolve global config
  const globalConfig = resolveGlobalConfig(globalOptions)

  // Resolve baseDir: CLI flag > BASE_DIR env > cwd
  const baseDir = options.baseDir ?? process.env['BASE_DIR'] ?? process.cwd()

  // Validate baseDir path
  const baseDirError = validatePath(baseDir, '--base-dir')
  if (baseDirError) {
    console.error(baseDirError)
    process.exit(1)
  }

  try {
    // Initialize VectorStore only (no Embedder needed for list)
    const vectorStore = createVectorStore(globalConfig)
    await vectorStore.initialize()

    // Build exclude paths (resolved to absolute)
    const excludePaths = [`${resolve(globalConfig.dbPath)}/`, `${resolve(globalConfig.cacheDir)}/`]

    // Get all ingested entries from the vector store
    const ingested = await vectorStore.listFiles()
    const ingestedMap = new Map(ingested.map((f) => [f.filePath, f]))

    // Scan baseDir recursively for supported files
    const entries = await readdir(baseDir, { recursive: true, withFileTypes: true })
    const baseDirFiles = entries
      .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => {
        const dir = e.parentPath
        return join(dir, e.name)
      })
      .filter((filePath) => !excludePaths.some((ep) => filePath.startsWith(ep)))
      .sort()

    const baseDirSet = new Set(baseDirFiles)

    // Files in baseDir with ingestion status
    const files: FileEntry[] = baseDirFiles.map((filePath) => {
      const entry = ingestedMap.get(filePath)
      return entry
        ? { filePath, ingested: true, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
        : { filePath, ingested: false }
    })

    // Content ingested via ingest_data (web pages, clipboard, etc.) plus any
    // orphaned DB entries whose files no longer exist on disk
    const sources: SourceEntry[] = ingested
      .filter((f) => !baseDirSet.has(f.filePath))
      .map((f) => {
        if (isRawDataPath(f.filePath)) {
          const source = extractSourceFromPath(f.filePath)
          if (source) return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
        }
        return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
      })

    const result: ListResult = { baseDir, files, sources }

    // Output JSON to stdout
    process.stdout.write(JSON.stringify(result, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Failed to list files: ${message}`)
    process.exit(1)
  }
}
