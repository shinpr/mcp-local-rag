// Blocks business routes until API startup (DB migration, embedder) completes

import type { FastifyReply, FastifyRequest } from 'fastify'
import { isApiReady } from '../readiness.js'

const EXEMPT_PATHS = new Set(['/health/live', '/health'])

export async function blockUntilReady(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = request.url.split('?')[0] ?? request.url
  if (EXEMPT_PATHS.has(path)) return

  if (!isApiReady()) {
    reply.code(503).send({ status: 'starting', message: 'API is initializing' })
  }
}
