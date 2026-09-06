// CLI delete subcommand — delete ingested content by file path or source URL

import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  checkRawDataArtifacts,
  generateMetaJsonPath,
  generateRawDataPath,
  isEnoent,
  isPathInRawDataDirLexical,
} from '../utils/raw-data-utils.js'
import { createVectorStore, formatCliError } from './common.js'
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
/** Report a usage error with the help text and stop. */
function usageError(message: string): never {
  console.error(message)
  console.error(HELP_TEXT)
  process.exit(1)
}

function parseArgs(args: string[]): DeleteArgs {
  const result: DeleteArgs = { help: false }

  let i = 0
  while (i < args.length) {
    const arg = args[i] ?? ''

    if (arg === '-h' || arg === '--help') {
      result.help = true
      i += 1
      continue
    }

    if (arg === '--source') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        usageError('Missing value for --source')
      }
      result.source = value
      i += 2
      continue
    }

    if (arg.startsWith('-')) {
      usageError(`Unknown option: ${arg}`)
    }
    if (result.filePath !== undefined) {
      usageError(`Unexpected argument: ${arg}`)
    }
    // Positional argument: file-path
    result.filePath = arg
    i += 1
  }

  return result
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the delete CLI subcommand.
 */
/**
 * Resolve the document to delete from either input form, or `null` when the
 * path was rejected (the reason is already reported).
 */
function resolveTargetPath(parsed: DeleteArgs, dbPath: string): string | null {
  if (parsed.source) {
    return generateRawDataPath(dbPath, parsed.source)
  }
  // DB key is the resolve()'d ingest path, so look up by resolve() (never
  // realpath) — realpath stays in validatePath/validateFilePath.
  const targetPath = resolve(parsed.filePath ?? '')
  const pathError = validatePath(targetPath, '<file-path>')
  if (pathError) {
    console.error(pathError)
    return null
  }
  return targetPath
}

/** Unlink one raw-data file, treating an already-absent file as success. */
async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if (!isEnoent(error)) {
      throw error
    }
  }
}

/** Remove a managed raw-data document and its sidecar, reporting what existed. */
async function removeRawDataArtifacts(
  targetPath: string
): Promise<{ rawDataExisted: boolean; metaExisted: boolean }> {
  // Pre-unlink existence (shared with the MCP server delete path).
  const artifacts = await checkRawDataArtifacts(targetPath)
  await unlinkIfPresent(targetPath)
  await unlinkIfPresent(generateMetaJsonPath(targetPath))
  return artifacts
}

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
  const vectorStore = createVectorStore(globalConfig)

  try {
    await vectorStore.initialize()

    const targetPath = resolveTargetPath(parsed, globalConfig.dbPath)
    if (targetPath === null) {
      process.exitCode = 1
      return
    }

    // Delete chunks from VectorStore
    const removedChunks = await vectorStore.deleteChunks(targetPath)
    // Optimize immediately after the DB delete: a later raw-data unlink failure
    // (re-thrown below for non-ENOENT) must not skip compaction once the rows
    // are already gone.
    await vectorStore.optimize()

    const removedFiles = isPathInRawDataDirLexical(targetPath, globalConfig.dbPath)
      ? await removeRawDataArtifacts(targetPath)
      : { rawDataExisted: false, metaExisted: false }

    // Output result JSON to stdout
    const result = {
      filePath: targetPath,
      deleted: true,
      removedChunks,
      existed: removedChunks > 0 || removedFiles.rawDataExisted || removedFiles.metaExisted,
      timestamp: new Date().toISOString(),
    }
    process.stdout.write(JSON.stringify(result))
  } catch (error) {
    const reason = formatCliError(error)
    console.error(`Error: ${reason}`)
    process.exitCode = 1
  } finally {
    await vectorStore.close()
  }
}
