#!/usr/bin/env node

// Entry point for mcp-local-rag
// Routes to CLI subcommands or starts the MCP server

import { parseGlobalOptions } from './cli/options.js'
import { handleCli } from './cli-main.js'
import { startServer } from './server-main.js'

// ============================================
// Routing
// ============================================

const SUBCOMMANDS = new Set(['skills', 'ingest', 'list', 'query', 'status'])

const { globalOptions, remainingArgs } = parseGlobalOptions(process.argv.slice(2))
const firstArg = remainingArgs[0]

if (firstArg && SUBCOMMANDS.has(firstArg)) {
  // CLI subcommand
  handleCli(remainingArgs, globalOptions).catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  // Default: start MCP server
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    process.exit(1)
  })

  startServer()
}
