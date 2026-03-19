// CLI delete subcommand — delete ingested content by file path or source URL

import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  generateMetaJsonPath,
  generateRawDataPath,
  isRawDataPath,
} from '../utils/raw-data-utils.js'
import { createVectorStore } from './common.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig, validatePath } from './options.js'

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] delete [--source <url>] [<file-path>]

Delete ingested content by file path or source URL.

Either <file-path> or --source is required (not both).

Arguments:
  <file-path>            File path of ingested content to delete

Options:
  --source <url>         Delete by source URL (for content ingested via ingest_data)
  -h, --help             Show this help

Global options (must appear before "delete"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

interface DeleteArgs {
  help: boolean
  source?: string
  filePath?: string
}

/**
 * Parse delete-specific CLI arguments.
 * Accepts a positional <file-path>, --source <url>, and -h/--help.
 * Unknown flags or conflicting args cause exit(1).
 */
function parseArgs(args: string[]): DeleteArgs {
  let help = false
  let source: string | undefined
  let filePath: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    if (arg === '-h' || arg === '--help') {
      help = true
      i++
    } else if (arg === '--source') {
      const value = args[++i]
      if (value === undefined || value.startsWith('-')) {
        console.error('Missing value for --source')
        console.error(HELP_TEXT)
        process.exit(1)
      }
      source = value
      i++
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`)
      console.error(HELP_TEXT)
      process.exit(1)
    } else {
      // Positional argument: file-path
      filePath = arg
      i++
    }
  }

  const result: DeleteArgs = { help }
  if (source !== undefined) result.source = source
  if (filePath !== undefined) result.filePath = filePath
  return result
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the delete CLI subcommand.
 * @param args - Arguments after "delete"
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runDelete(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const parsed = parseArgs(args)

  // Handle --help
  if (parsed.help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Validate: either file-path or --source required, not both
  if (!parsed.filePath && !parsed.source) {
    console.error('Either <file-path> or --source is required')
    console.error(HELP_TEXT)
    process.exit(1)
  }

  if (parsed.filePath && parsed.source) {
    console.error('Cannot specify both <file-path> and --source')
    console.error(HELP_TEXT)
    process.exit(1)
  }

  // Resolve global config
  const globalConfig = resolveGlobalConfig(globalOptions)

  try {
    // Create and initialize VectorStore (no Embedder needed for delete)
    const vectorStore = createVectorStore(globalConfig)
    await vectorStore.initialize()

    // Determine target file path
    let targetPath: string

    if (parsed.source) {
      // Generate raw-data path from source URL
      targetPath = generateRawDataPath(globalConfig.dbPath, parsed.source, 'markdown')
    } else {
      // Use provided file path, resolve to absolute
      targetPath = resolve(parsed.filePath!)

      // Validate path (reject sensitive system directories)
      const pathError = validatePath(targetPath, '<file-path>')
      if (pathError) {
        console.error(pathError)
        process.exitCode = 1
        return
      }
    }

    // Delete chunks from VectorStore
    await vectorStore.deleteChunks(targetPath)

    // Clean up physical raw-data files if applicable
    if (isRawDataPath(targetPath)) {
      try {
        await unlink(targetPath)
      } catch (error: unknown) {
        // Ignore ENOENT (file already deleted / never existed)
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error
        }
      }

      try {
        await unlink(generateMetaJsonPath(targetPath))
      } catch (error: unknown) {
        // Ignore ENOENT
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw error
        }
      }
    }

    // Optimize VectorStore after deletion
    await vectorStore.optimize()

    // Output result JSON to stdout
    const result = {
      filePath: targetPath,
      deleted: true,
      timestamp: new Date().toISOString(),
    }
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${reason}`)
    process.exit(1)
  }
}
