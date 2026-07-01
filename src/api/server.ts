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
import { repairRelativeFilePaths } from './file-path-repair.js'
import { recoverStuckIndexing } from './ingest-recovery.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerCursorRoutes } from './routes/cursor.js'
import { registerFileRoutes } from './routes/files.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerIngestRoutes } from './routes/ingest.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerSkillRoutes } from './routes/skill.js'

/**
 * Build and configure a Fastify application instance.
 *
 * Shared components (VectorStore, Embedder) are passed in — the HTTP server
 * reuses the same core RAG components as MCP and CLI, with zero duplication.
 */
export async function buildApp(config: ApiConfig, vectorStore: VectorStore, embedder: Embedder) {
  // Run PostgreSQL migration first
  await migrateDb(config.databaseUrl)

  // Repair legacy relative file paths before handling requests
  await repairRelativeFilePaths(config)

  // Reset files/jobs stuck in running/indexing after a crash or restart
  await recoverStuckIndexing(config)

  // Seed default admin user if configured
  await seedDefaultAdmin(config)

  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    },
  })

  // Plugins
  app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  })
  app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB max upload
    },
  })

  // Initialize PostgreSQL DB (triggers singleton creation)
  getDb(config.databaseUrl)

  // Routes
  registerAuthRoutes(app, config)
  registerProjectRoutes(app, config, vectorStore)
  registerFileRoutes(app, config, vectorStore)
  registerIngestRoutes(app, config, vectorStore, embedder)
  registerSearchRoutes(app, config, vectorStore, embedder)
  registerCursorRoutes(app)
  registerSkillRoutes(app, config)
  registerHealthRoutes(app)

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
    // biome-ignore lint/suspicious/noConsole: startup seeding log
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
