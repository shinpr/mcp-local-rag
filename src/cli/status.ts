// CLI status subcommand — show vector database status

import { createVectorStore } from './common.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig } from './options.js'

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] status

Show vector database status (document count, chunk count, memory usage, etc.).

Options:
  -h, --help             Show this help

Global options (must appear before "status"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse status-specific CLI arguments.
 * Status accepts no options or positional args — only -h/--help.
 * Unknown flags or positional args cause an error.
 */
function parseArgs(args: string[]): { help: boolean } {
  let help = false

  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`)
      console.error(HELP_TEXT)
      process.exit(1)
    } else {
      console.error(`Unexpected argument: ${arg}`)
      console.error(HELP_TEXT)
      process.exit(1)
    }
  }

  return { help }
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the status CLI subcommand.
 * @param args - Arguments after "status" (should be empty or --help)
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runStatus(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Resolve global config
  const globalConfig = resolveGlobalConfig(globalOptions)

  try {
    // Create and initialize VectorStore (no Embedder needed for status)
    const vectorStore = createVectorStore(globalConfig)
    await vectorStore.initialize()

    // Get status
    const status = await vectorStore.getStatus()

    // Output JSON to stdout
    process.stdout.write(JSON.stringify(status))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${reason}`)
    process.exit(1)
  }
}
