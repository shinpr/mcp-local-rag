// JWT authentication preHandler hook for Fastify

import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Typed JWT payload. Use this to access `request.user` after `jwtVerify()`.
 * Cast via `(request.user as JwtPayload)` in route handlers.
 */
export interface JwtPayload {
  id: number
  email: string
  username: string
}

/**
 * Pre-handler hook: verifies the JWT from `Authorization: Bearer <token>`.
 * Attaches the decoded payload to `request.user`.
 * Returns 401 if the token is missing or invalid.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    reply
      .code(401)
      .send({ error: 'Unauthorized', message: 'Invalid or missing authentication token' })
  }
}
