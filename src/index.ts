#!/usr/bin/env node
// Entry point for RAG MCP Server

import { RAGServer } from './server/index.js'
import type { GroupingMode } from './vectordb/index.js'

/**
 * Parse grouping mode from environment variable
 */
function parseGroupingMode(value: string | undefined): GroupingMode | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase().trim()
  if (normalized === 'similar' || normalized === 'related') {
    return normalized
  }
  console.error(
    `Invalid RAG_GROUPING value: "${value}". Expected "similar" or "related". Ignoring.`
  )
  return undefined
}

/**
 * Parse max distance from environment variable
 */
function parseMaxDistance(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(`Invalid RAG_MAX_DISTANCE value: "${value}". Expected positive number. Ignoring.`)
    return undefined
  }
  return parsed
}

/**
 * Entry point - Start RAG MCP Server
 */
async function main(): Promise<void> {
  try {
    // RAGServer configuration
    const config: ConstructorParameters<typeof RAGServer>[0] = {
      dbPath: process.env['DB_PATH'] || './lancedb/',
      modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: process.env['CACHE_DIR'] || './models/',
      baseDir: process.env['BASE_DIR'] || process.cwd(),
      maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10), // 100MB
      chunkSize: Number.parseInt(process.env['CHUNK_SIZE'] || '512', 10),
      chunkOverlap: Number.parseInt(process.env['CHUNK_OVERLAP'] || '100', 10),
    }

    // Add quality filter settings only if defined
    const maxDistance = parseMaxDistance(process.env['RAG_MAX_DISTANCE'])
    const grouping = parseGroupingMode(process.env['RAG_GROUPING'])
    if (maxDistance !== undefined) {
      config.maxDistance = maxDistance
    }
    if (grouping !== undefined) {
      config.grouping = grouping
    }

    console.error('Starting RAG MCP Server...')
    console.error('Configuration:', config)

    // Start RAGServer
    const server = new RAGServer(config)
    await server.initialize()
    await server.run()

    console.error('RAG MCP Server started successfully')
  } catch (error) {
    console.error('Failed to start RAG MCP Server:', error)
    process.exit(1)
  }
}

// Global error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  process.exit(1)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  process.exit(1)
})

// Execute main
main()
