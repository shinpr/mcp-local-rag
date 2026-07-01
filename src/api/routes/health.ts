// Health check routes — liveness vs readiness

import type { FastifyInstance } from 'fastify'

const startTime = Date.now()

/** Process is up and accepting HTTP (used by Docker liveness probes). */
export function registerLivenessRoute(app: FastifyInstance): void {
  app.get('/health/live', async () => ({
    status: 'alive' as const,
  }))
}

/** Full readiness — registered after embedder, DB migration, and routes are ready. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({
    status: 'ok' as const,
    version: '0.15.3',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  }))
}
