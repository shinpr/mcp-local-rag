// Fastify app factory — assembles all plugins, hooks, and route modules

import fastifyJwt from '@fastify/jwt'
import fastifyMultipart from '@fastify/multipart'
import { hash } from 'bcryptjs'
import { eq, or } from 'drizzle-orm'
import Fastify from 'fastify'

import type { Embedder } from '../embedder/index.js'
import type { VectorStore } from '../vectordb/index.js'
import type { ApiConfig } from './config.js'
import { getDb, migrateDb } from './db/index.js'
import { users } from './db/schema.js'
import { EmbeddingService } from './embedding/embedding-service.js'
import { repairRelativeFilePaths } from './file-path-repair.js'
import { recoverStuckIndexing } from './ingest-recovery.js'
import { blockUntilReady } from './middleware/ready.js'
import { createRagServices, type RagServices } from './rag-services.js'
import { markApiReady } from './readiness.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerCursorRoutes } from './routes/cursor.js'
import { registerFileRoutes } from './routes/files.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerIngestRoutes } from './routes/ingest.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerSkillRoutes } from './routes/skill.js'

function createLoggerConfig() {
  return {
    level: 'info' as const,
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
    },
  }
}

function logMigrationFailure(config: ApiConfig, error: unknown): void {
  console.error('PostgreSQL migration failed — cannot connect or run schema setup.')
  console.error(`  Database: ${config.databaseUrl.replace(/:[^:@]+@/, ':***@')}`)
  console.error(
    '  From Docker, DB_HOST must be a LAN IP reachable from the container (not localhost).'
  )
  if (error instanceof Error) {
    console.error(`  Error: ${error.message}`)
  } else {
    console.error('  Error:', error)
  }
}

export interface AppShell {
  app: ReturnType<typeof Fastify>
  services: RagServices
}

/**
 * Fastify shell with plugins and all routes — safe to listen before embedder init.
 * Business routes return 503 until finalizeApp marks the API ready.
 */
function uploadLimitMb(config: ApiConfig): number {
  return Math.round(config.maxUploadSizeBytes / (1024 * 1024))
}

export async function createAppShell(config: ApiConfig): Promise<AppShell> {
  const app = Fastify({
    logger: createLoggerConfig(),
    bodyLimit: config.maxUploadSizeBytes,
  })
  const services = createRagServices()

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  })
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxUploadSizeBytes,
    },
  })

  const limitMb = uploadLimitMb(config)
  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, _request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: 'Payload Too Large',
        message: `File exceeds the ${limitMb} MB upload limit. Increase MAX_UPLOAD_SIZE_MB in .env (current limit: ${limitMb} MB).`,
      })
    }
    const statusCode = error.statusCode ?? 500
    return reply.code(statusCode).send({
      error: error.name ?? 'Internal Server Error',
      message: error.message,
    })
  })

  app.addHook('onRequest', blockUntilReady)

  registerHealthRoutes(app)
  registerAuthRoutes(app, config)
  registerProjectRoutes(app, config, services)
  registerFileRoutes(app, config, services)
  registerIngestRoutes(app, config, services)
  registerSearchRoutes(app, config, services)
  registerSettingsRoutes(app, config, services)
  registerCursorRoutes(app)
  registerSkillRoutes(app, config)

  return { app, services }
}

/**
 * Finish startup on an already-listening app: migrate DB, seed, wire RAG services.
 */
export async function finalizeApp(
  _app: AppShell['app'],
  config: ApiConfig,
  services: RagServices,
  vectorStore: VectorStore,
  embedder: Embedder
) {
  try {
    await migrateDb(config.databaseUrl)
  } catch (error) {
    logMigrationFailure(config, error)
    throw error
  }

  await repairRelativeFilePaths(config)
  await recoverStuckIndexing(config)
  await seedDefaultAdmin(config)

  getDb(config.databaseUrl)

  services.vectorStore = vectorStore
  services.embedder = embedder
  services.embeddingService = new EmbeddingService(config, embedder)
  markApiReady()
}

/**
 * Build and configure a Fastify application instance.
 *
 * Shared components (VectorStore, Embedder) are passed in — the HTTP server
 * reuses the same core RAG components as MCP and CLI, with zero duplication.
 */
export async function buildApp(config: ApiConfig, vectorStore: VectorStore, embedder: Embedder) {
  const { app, services } = await createAppShell(config)
  await finalizeApp(app, config, services, vectorStore, embedder)
  return app
}

/**
 * Seed a default admin user on first startup.
 * Skipped silently if env vars are not set or user already exists.
 */
async function seedDefaultAdmin(config: ApiConfig): Promise<void> {
  const { defaultAdminEmail, defaultAdminUsername, defaultAdminPassword } = config
  if (!defaultAdminEmail || !defaultAdminUsername || !defaultAdminPassword) return

  const db = getDb(config.databaseUrl)
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.email, defaultAdminEmail), eq(users.username, defaultAdminUsername)))
    .limit(1)

  if (existing) return

  const passwordHash = await hash(defaultAdminPassword, 10)
  try {
    await db.insert(users).values({
      email: defaultAdminEmail,
      username: defaultAdminUsername,
      passwordHash,
    })
    console.log(`Seeded default admin user: ${defaultAdminEmail}`)
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  )
}
