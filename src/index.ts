#!/usr/bin/env node

// Entry point for mcp-local-rag
// Routes to CLI subcommands or starts the MCP server

import { parseGlobalOptions } from './cli/options.js'
import { handleCli, SUBCOMMANDS, type Subcommand } from './cli-main.js'
import { startServer } from './server-main.js'

// ============================================
// Routing helpers
// ============================================

const SUBCOMMAND_SET: ReadonlySet<string> = new Set(SUBCOMMANDS)

function isSubcommand(value: string): value is Subcommand {
  return SUBCOMMAND_SET.has(value)
}

/** Replace control chars and truncate, so an unexpected argv value
 *  echoed to stderr cannot smuggle ANSI escapes or CR/LF into log lines. */
function sanitizeForEcho(s: string): string {
  return s.replace(/\p{Cc}/gu, '?').slice(0, 100)
}

// ============================================
// Routing
// ============================================

const { globalOptions, remainingArgs } = parseGlobalOptions(process.argv.slice(2))
const firstArg = remainingArgs[0]

if (firstArg !== undefined && isSubcommand(firstArg)) {
  // CLI subcommand
  handleCli(firstArg, remainingArgs.slice(1), globalOptions).catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else if (remainingArgs.length === 0) {
  if (Object.keys(globalOptions).length > 0) {
    console.error('Global CLI options are not supported when launching the MCP server directly.')
    console.error(
      'Use environment variables like DB_PATH, CACHE_DIR, MODEL_NAME, BASE_DIR, BASE_DIRS, and MAX_FILE_SIZE instead.'
    )
    process.exit(1)
  }

  // Default: start MCP server (env-only, no CLI flags)
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    process.exit(1)
  })

  startServer()
} else {
  console.error(`Unknown command: ${sanitizeForEcho(firstArg ?? '')}`)
  console.error(`Available commands: ${SUBCOMMANDS.join(', ')}`)
  process.exit(1)
}
