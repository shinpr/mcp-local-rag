#!/usr/bin/env node
// Entry point for RAG Web Server

import path from 'node:path'
import type { GroupingMode } from '../vectordb/index.js'

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
 * Parse hybrid weight from environment variable
 */
function parseHybridWeight(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.error(
      `Invalid RAG_HYBRID_WEIGHT value: "${value}". Expected 0.0-1.0. Using default (0.6).`
    )
    return undefined
  }
  return parsed
}

/**
 * Entry point - Start RAG Web Server
 */
async function main(): Promise<void> {
  try {
    // Dynamic imports to avoid loading heavy modules at CLI parse time
    const { RAGServer } = await import('../server/index.js')
    const { createHttpServer, startServer } = await import('./http-server.js')

    // Configuration from environment
    const port = Number.parseInt(process.env['WEB_PORT'] || '3000', 10)
    const dbPath = process.env['DB_PATH'] || './lancedb/'
    const uploadDir = process.env['UPLOAD_DIR'] || './uploads/'

    // Determine static files directory
    // Check relative to cwd for development and relative to dist for production
    let staticDir: string | undefined
    const cwd = process.cwd()
    const devStaticPath = path.resolve(cwd, 'web-ui/dist')
    const prodStaticPath = path.resolve(cwd, 'dist/web-ui')

    // Check which exists
    const { existsSync } = await import('node:fs')
    if (existsSync(devStaticPath)) {
      staticDir = devStaticPath
    } else if (existsSync(prodStaticPath)) {
      staticDir = prodStaticPath
    }

    // RAGServer configuration
    const config: ConstructorParameters<typeof RAGServer>[0] = {
      dbPath,
      modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: process.env['CACHE_DIR'] || './models/',
      baseDir: process.env['BASE_DIR'] || process.cwd(),
      maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10),
    }

    // Add quality filter settings only if defined
    const maxDistance = parseMaxDistance(process.env['RAG_MAX_DISTANCE'])
    const grouping = parseGroupingMode(process.env['RAG_GROUPING'])
    const hybridWeight = parseHybridWeight(process.env['RAG_HYBRID_WEIGHT'])
    if (maxDistance !== undefined) {
      config.maxDistance = maxDistance
    }
    if (grouping !== undefined) {
      config.grouping = grouping
    }
    if (hybridWeight !== undefined) {
      config.hybridWeight = hybridWeight
    }

    console.log('Starting RAG Web Server...')
    console.log('Configuration:', { ...config, port, uploadDir, staticDir })

    // Initialize RAGServer
    const ragServer = new RAGServer(config)
    await ragServer.initialize()

    // Create and start HTTP server
    const httpConfig: Parameters<typeof createHttpServer>[1] = {
      port,
      uploadDir,
    }
    if (staticDir !== undefined) {
      httpConfig.staticDir = staticDir
    }

    const app = await createHttpServer(ragServer, httpConfig)

    await startServer(app, port)

    console.log('RAG Web Server started successfully')
    if (staticDir) {
      console.log(`Serving UI from: ${staticDir}`)
    } else {
      console.log('No UI build found. Run "pnpm ui:build" to build the frontend.')
    }
  } catch (error) {
    console.error('Failed to start RAG Web Server:', error)
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
