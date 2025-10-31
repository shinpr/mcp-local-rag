#!/usr/bin/env node
// Entry point for RAG MCP Server

import { RAGServer } from './server/index.js'

/**
 * Entry point - Start RAG MCP Server
 */
async function main(): Promise<void> {
  try {
    // RAGServer configuration
    const config = {
      dbPath: process.env['DB_PATH'] || './lancedb/',
      modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: process.env['CACHE_DIR'] || './models/',
      baseDir: process.env['BASE_DIR'] || process.cwd(),
      maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10), // 100MB
      chunkSize: Number.parseInt(process.env['CHUNK_SIZE'] || '512', 10),
      chunkOverlap: Number.parseInt(process.env['CHUNK_OVERLAP'] || '100', 10),
    }

    console.log('Starting RAG MCP Server...')
    console.log('Configuration:', config)

    // Start RAGServer
    const server = new RAGServer(config)
    await server.initialize()
    await server.run()

    console.log('RAG MCP Server started successfully')
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
