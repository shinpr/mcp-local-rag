// CLI `serve` subcommand — starts the Fastify HTTP server

import 'dotenv/config'
import { resolveApiConfig } from '../api/config.js'
import { createAppShell, finalizeApp } from '../api/server.js'
import { Embedder } from '../embedder/index.js'
import { VectorStore } from '../vectordb/index.js'
import type { GlobalOptions } from './options.js'

console.error(`[mcp-rag-api] serve module loaded (pid=${process.pid})`)

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
  console.error(`[mcp-rag-api] runServe() entered (pid=${process.pid})`)

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

  const app = await createAppShell(config)

  try {
    await app.listen({ port: config.port, host: config.host })
    console.error(`Liveness endpoint ready at http://${config.host}:${config.port}/health/live`)
  } catch (error) {
    console.error('Failed to bind HTTP server:', error)
    process.exit(1)
  }

  try {
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

    await finalizeApp(app, config, vectorStore, embedder)
    console.error(`API server ready at http://${config.host}:${config.port}`)
  } catch (error) {
    console.error('API startup failed:', error)
    process.exit(1)
  }
}
