// Auth routes: register, login, me

import { compare, hash } from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { users } from '../db/schema.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import { loginSchema, registerSchema } from '../schemas/requests.js'

const SALT_ROUNDS = 10

export function registerAuthRoutes(app: FastifyInstance, config: ApiConfig): void {
  const db = getDb(config.databaseUrl)

  // POST /auth/register
  app.post('/auth/register', { schema: registerSchema }, async (request, reply) => {
    const { email, username, password } = request.body as {
      email: string
      username: string
      password: string
    }

    // Check for existing email
    const [existingEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (existingEmail) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' })
    }

    // Check for existing username
    const [existingUsername] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1)
    if (existingUsername) {
      return reply.code(409).send({ error: 'Conflict', message: 'Username already taken' })
    }

    const passwordHash = await hash(password, SALT_ROUNDS)

    const [result] = await db
      .insert(users)
      .values({ email, username, passwordHash })
      .returning({ id: users.id })

    if (!result) {
      throw new Error('Failed to create user')
    }

    const token = app.jwt.sign({ id: result.id, email, username })

    return reply.code(201).send({ id: result.id, email, username, token })
  })

  // POST /auth/login
  app.post('/auth/login', { schema: loginSchema }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid email or password' })
    }

    const valid = await compare(password, user.passwordHash)
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid email or password' })
    }

    const token = app.jwt.sign({ id: user.id, email: user.email, username: user.username })

    return { id: user.id, email: user.email, username: user.username, token }
  })

  // GET /auth/me (requires JWT)
  app.get('/auth/me', { preHandler: [requireAuth] }, async (request) => {
    const payload = request.user as JwtPayload
    const [user] = await db
      .select({ id: users.id, email: users.email, username: users.username })
      .from(users)
      .where(eq(users.id, payload.id))
      .limit(1)

    if (!user) {
      throw new Error('User not found')
    }

    return user
  })
}
