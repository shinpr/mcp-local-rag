// CLI `serve` subcommand — starts the Fastify HTTP server

import { resolveApiConfig } from '../api/config.js'
import { buildApp } from '../api/server.js'
import { Embedder } from '../embedder/index.js'
import { VectorStore } from '../vectordb/index.js'
import type { GlobalOptions } from './options.js'

const HELP_TEXT = `Usage: mcp-local-rag serve [options]

Start the HTTP API server for managing projects, files, and search.

Options:
  -h, --help    Show this help

Environment variables:
  API_PORT          HTTP server port (default: 3939)
  API_HOST          HTTP server bind address (default: 127.0.0.1)
  JWT_SECRET        JWT signing secret (auto-generated if not set)
  JWT_EXPIRES_IN    JWT token expiry (default: 7d)
  DATABASE_URL      PostgreSQL connection URL (overrides DB_* vars)
  DB_HOST           PostgreSQL host (default: localhost)
  DB_PORT           PostgreSQL port (default: 5432)
  DB_USER           PostgreSQL user (default: postgres)
  DB_PASSWORD       PostgreSQL password
  DB_NAME           PostgreSQL database name (default: mcp_local_rag_db)
  UPLOAD_DIR        File upload storage directory (default: <DB_PATH>/uploads/)
  DB_PATH           LanceDB database path (default: ./lancedb/)
  MODEL_NAME        Embedding model (default: Xenova/all-MiniLM-L6-v2)
  CACHE_DIR         Model cache directory (default: ./models/)
  RAG_DEVICE        Compute device (default: cpu)
`

export async function runServe(args: string[], _globalOptions: GlobalOptions = {}): Promise<void> {
  // Handle --help
  if (args.includes('-h') || args.includes('--help')) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  const config = resolveApiConfig(process.env)

  console.error('Starting API server...')
  console.error(`  LanceDB path: ${config.lanceDbPath}`)
  console.error(`  Database URL: ${config.databaseUrl.replace(/:[^:@]+@/, ':***@')}`)
  console.error(`  Upload dir:   ${config.uploadDir}`)

  // Initialize shared RAG components
  const vectorStore = new VectorStore({
    dbPath: config.lanceDbPath,
    tableName: 'chunks',
  })
  await vectorStore.initialize()

  const embedder = new Embedder({
    modelPath: config.modelName,
    batchSize: 16,
    cacheDir: config.cacheDir,
    device: config.device,
  })
  await embedder.initialize()

  // Build and start Fastify (async — runs PostgreSQL migration)
  const app = await buildApp(config, vectorStore, embedder)

  try {
    await app.listen({ port: config.port, host: config.host })
    console.error(`API server listening on http://${config.host}:${config.port}`)
  } catch (error) {
    console.error('Failed to start API server:', error)
    process.exit(1)
  }
}
