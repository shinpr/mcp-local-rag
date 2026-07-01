// Health check routes — liveness vs readiness

import type { FastifyInstance } from 'fastify'
import { isApiReady } from '../readiness.js'

const startTime = Date.now()

/** Liveness and readiness probes — registered before listen. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/live', async () => ({
    status: 'alive' as const,
  }))

  app.get('/health', async (_request, reply) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000)

    if (!isApiReady()) {
      return reply.code(503).send({
        status: 'starting' as const,
        version: '0.15.3',
        uptime,
      })
    }

    return {
      status: 'ok' as const,
      version: '0.15.3',
      uptime,
    }
  })
}
