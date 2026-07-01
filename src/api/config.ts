// API server configuration — resolved from env vars with sensible defaults

import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

export interface ApiConfig {
  /** HTTP server port */
  port: number
  /** HTTP server bind address */
  host: string
  /** JWT signing secret */
  jwtSecret: string
  /** JWT token expiry (e.g. '7d', '24h') */
  jwtExpiresIn: string
  /** PostgreSQL connection URL */
  databaseUrl: string
  /** Absolute path to file upload storage directory */
  uploadDir: string
  /** LanceDB path (for VectorStore integration) */
  lanceDbPath: string
  /** Embedding model path */
  modelName: string
  /** Model cache directory */
  cacheDir: string
  /** Compute device */
  device: string
  /** Default admin user — seeded on first startup if all three are set */
  defaultAdminEmail?: string
  defaultAdminUsername?: string
  defaultAdminPassword?: string
}

/**
 * Build PostgreSQL connection URL from individual env vars or DATABASE_URL.
 */
function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  // Allow a single DATABASE_URL to override everything
  if (env['DATABASE_URL']) {
    return env['DATABASE_URL']
  }

  const host = env['DB_HOST'] ?? 'localhost'
  const port = env['DB_PORT'] ?? '5432'
  const user = env['DB_USER'] ?? 'postgres'
  const password = env['DB_PASSWORD'] ?? ''
  const database = env['DB_NAME'] ?? 'mcp_local_rag_db'

  return `postgresql://${user}:${password}@${host}:${port}/${database}`
}

/**
 * Resolve API configuration from environment variables.
 * Called once at server startup.
 */
export function resolveApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const port = Number.parseInt(env['API_PORT'] ?? '3939', 10)
  const host = env['API_HOST'] ?? '127.0.0.1'
  const jwtSecret = env['JWT_SECRET'] ?? randomBytes(32).toString('hex')
  const jwtExpiresIn = env['JWT_EXPIRES_IN'] ?? '7d'
  const lanceDbPath = env['DB_PATH'] ?? './lancedb/'
  const dbDir = resolve(lanceDbPath)
  const databaseUrl = resolveDatabaseUrl(env)
  const uploadDir = resolve(env['UPLOAD_DIR'] ?? join(dbDir, 'uploads'))
  const modelName = env['MODEL_NAME'] ?? 'Xenova/all-MiniLM-L6-v2'
  const cacheDir = env['CACHE_DIR'] ?? './models/'
  const device = env['RAG_DEVICE']?.trim() || 'cpu'

  const defaultAdminEmail = env['DEFAULT_ADMIN_EMAIL']?.trim() || undefined
  const defaultAdminUsername = env['DEFAULT_ADMIN_USERNAME']?.trim() || undefined
  const defaultAdminPassword = env['DEFAULT_ADMIN_PASSWORD']?.trim() || undefined

  return {
    port,
    host,
    jwtSecret,
    jwtExpiresIn,
    databaseUrl,
    uploadDir,
    lanceDbPath,
    modelName,
    cacheDir,
    device,
    ...(defaultAdminEmail && { defaultAdminEmail }),
    ...(defaultAdminUsername && { defaultAdminUsername }),
    ...(defaultAdminPassword && { defaultAdminPassword }),
  }
}
