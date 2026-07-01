// Health check route

import type { FastifyInstance } from 'fastify'

const startTime = Date.now()

export function registerHealthRoutes(app: FastifyInstance): void {
  // GET /health
  app.get('/health', async () => {
    return {
      status: 'ok' as const,
      version: '0.15.3',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    }
  })
}
