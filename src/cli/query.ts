// CLI query subcommand — search ingested documents

import { extractSourceFromPath, isManagedRawDataPath } from '../utils/raw-data-utils.js'
import { createEmbedder, createVectorStore, formatCliError } from './common.js'
import type { GlobalOptions } from './options.js'
import { requireFlagValue, resolveGlobalConfig } from './options.js'

// ============================================
// Types
// ============================================

interface QueryCliOptions {
  limit?: number | undefined
  scope?: string[] | undefined
}

interface ParsedArgs {
  queryText: string | undefined
  options: QueryCliOptions
  help: boolean
}

interface QueryResultOutput {
  filePath: string
  chunkIndex: number
  text: string
  score: number
  fileTitle: string | null
  source?: string
}

// ============================================
// Defaults
// ============================================

const QUERY_DEFAULTS = {
  limit: 10,
} as const

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] query [options] <query-text>

Search ingested documents using hybrid vector + keyword matching.

Options:
  --limit <n>            Max results (default: ${QUERY_DEFAULTS.limit}, range: 1-20)
  --scope <prefix>       Restrict results to a path prefix (repeatable for multiple prefixes)
  -h, --help             Show this help

Global options (must appear before "query"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse query-specific CLI arguments into options and a positional query text.
 * Flags: --limit, --scope (repeatable), -h/--help
 * Unknown flags (including global flags passed after subcommand) cause an error.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const options: QueryCliOptions = {}
  let queryText: string | undefined
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
      case '--limit': {
        const value = requireFlagValue(args, i, '--limit')
        if (!/^\d+$/.test(value)) {
          console.error('--limit must be between 1 and 20')
          process.exit(1)
        }
        options.limit = Number.parseInt(value, 10)
        i += 2
        break
      }
      case '--scope': {
        const value = requireFlagValue(args, i, '--scope').trim()
        if (value.length === 0) {
          console.error('--scope value must not be empty')
          process.exit(1)
        }
        const scope = options.scope ?? []
        scope.push(value)
        options.scope = scope
        i += 2
        break
      }
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        if (queryText !== undefined) {
          console.error(`Unexpected argument: ${arg}`)
          console.error('Only one query text argument is accepted.')
          process.exit(1)
        }
        queryText = arg
        i++
        break
    }
  }

  return { queryText, options, help }
}

// ============================================
// Limit Validation
// ============================================

/**
 * Validate and resolve the limit value.
 * Returns the validated limit or exits with error.
 */
function resolveLimit(rawLimit: number | undefined): number {
  const limit = rawLimit ?? QUERY_DEFAULTS.limit
  if (!Number.isFinite(limit) || limit < 1 || limit > 20) {
    console.error('--limit must be between 1 and 20')
    process.exit(1)
  }
  return limit
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the query CLI subcommand.
 * @param args - Arguments after "query" (e.g., option flags and query text)
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runQuery(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { queryText, options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Validate positional argument
  if (!queryText) {
    console.error('Usage: mcp-local-rag query [options] <query-text>')
    console.error('  Search ingested documents.')
    console.error('  Run with --help for all options.')
    process.exit(1)
  }

  // Validate limit
  const limit = resolveLimit(options.limit)

  // Resolve global config
  const globalConfig = resolveGlobalConfig(globalOptions)

  // Initialize components
  const vectorStore = createVectorStore(globalConfig)
  const embedder = createEmbedder(globalConfig)
  await vectorStore.initialize()

  try {
    // Generate query embedding
    const embeddings = await embedder.embedBatch([queryText])
    const queryVector = embeddings[0]
    if (!queryVector) {
      throw new Error('Failed to generate query embedding')
    }

    // Hybrid search (vector + BM25). Thread scope only when present so the
    // scope-absent call shape stays identical to the pre-flag behavior.
    const searchResults = await vectorStore.search(queryVector, {
      queryText,
      limit,
      ...(options.scope ? { scope: options.scope } : {}),
    })

    // Format results with source restoration for raw-data files
    const results: QueryResultOutput[] = searchResults.map((result) => {
      const output: QueryResultOutput = {
        filePath: result.filePath,
        chunkIndex: result.chunkIndex,
        text: result.text,
        score: result.score,
        fileTitle: result.fileTitle ?? null,
      }

      if (isManagedRawDataPath(result.filePath, globalConfig.dbPath)) {
        const source = extractSourceFromPath(result.filePath)
        if (source) {
          output.source = source
        }
      }

      return output
    })

    // Output JSON to stdout
    process.stdout.write(JSON.stringify(results, null, 2))
  } catch (error) {
    const reason = formatCliError(error)
    console.error(`Error: ${reason}`)
    process.exit(1)
  } finally {
    await embedder.dispose()
    await vectorStore.close()
  }
}
