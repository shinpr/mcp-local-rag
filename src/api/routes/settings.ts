// User settings routes — embedding provider configuration

import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { userSettings } from '../db/schema.js'
import { defaultApiBaseUrl, isEmbeddingProvider } from '../embedding/defaults.js'
import { encryptApiKey, maskApiKey } from '../embedding/settings-crypto.js'
import type { EmbeddingProvider } from '../embedding/types.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import type { RagServices } from '../rag-services.js'
import { getEmbeddingService } from '../rag-services.js'
import { updateSettingsSchema } from '../schemas/requests.js'

interface SettingsResponse {
  embeddingProvider: EmbeddingProvider
  apiBaseUrl: string | null
  modelName: string
  apiKeySet: boolean
  apiKeyMasked: string | null
  matchesDefaultEmbedding: boolean
  updatedAt: string | null
  defaultEmbedding: ReturnType<ReturnType<typeof getEmbeddingService>['getDefaultEmbeddingInfo']>
}

function matchesDefaultEmbedding(
  provider: EmbeddingProvider,
  modelName: string,
  defaultInfo: SettingsResponse['defaultEmbedding']
): boolean {
  if (provider === 'local' && modelName === defaultInfo.modelName) return true
  const equivalent = defaultInfo.equivalentProviderOptions.find((opt) => opt.provider === provider)
  if (!equivalent) return false
  return modelName === equivalent.modelName
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  services: RagServices
): void {
  const db = getDb(config.databaseUrl)

  // GET /settings
  app.get('/settings', { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as JwtPayload).id
    const embeddingService = getEmbeddingService(services)
    const defaultEmbedding = embeddingService.getDefaultEmbeddingInfo()
    const resolved = await embeddingService.loadSettings(userId)

    const [row] = await db
      .select({ updatedAt: userSettings.updatedAt })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)

    const response: SettingsResponse = {
      embeddingProvider: resolved.provider,
      apiBaseUrl: resolved.apiBaseUrl ?? defaultApiBaseUrl(resolved.provider),
      modelName: resolved.modelName,
      apiKeySet: Boolean(resolved.apiKey),
      apiKeyMasked: resolved.apiKey ? maskApiKey(resolved.apiKey) : null,
      matchesDefaultEmbedding: matchesDefaultEmbedding(
        resolved.provider,
        resolved.modelName,
        defaultEmbedding
      ),
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      defaultEmbedding,
    }

    return response
  })

  // PUT /settings
  app.put(
    '/settings',
    { preHandler: [requireAuth], schema: updateSettingsSchema },
    async (request, reply) => {
      const userId = (request.user as JwtPayload).id
      const body = request.body as {
        embeddingProvider: string
        apiBaseUrl?: string | null
        apiKey?: string | null
        modelName?: string | null
      }

      if (!isEmbeddingProvider(body.embeddingProvider)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Invalid embedding provider: ${body.embeddingProvider}`,
        })
      }

      const provider = body.embeddingProvider
      const embeddingService = getEmbeddingService(services)
      const defaultEmbedding = embeddingService.getDefaultEmbeddingInfo()

      const modelName =
        body.modelName?.trim() ||
        (provider === 'local'
          ? defaultEmbedding.modelName
          : (defaultEmbedding.equivalentProviderOptions.find((o) => o.provider === provider)
              ?.modelName ?? defaultEmbedding.modelName))

      const apiBaseUrl =
        body.apiBaseUrl === undefined
          ? defaultApiBaseUrl(provider)
          : body.apiBaseUrl?.trim() || null

      if (provider !== 'local' && !apiBaseUrl) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'API base URL is required for remote embedding providers',
        })
      }

      const [existing] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1)

      let apiKeyEncrypted: string | null = existing?.apiKeyEncrypted ?? null
      if (body.apiKey !== undefined) {
        const trimmed = body.apiKey?.trim()
        apiKeyEncrypted = trimmed ? encryptApiKey(trimmed, config.jwtSecret) : null
      }

      const values = {
        embeddingProvider: provider,
        apiBaseUrl: provider === 'local' ? null : apiBaseUrl,
        apiKeyEncrypted: provider === 'local' ? null : apiKeyEncrypted,
        modelName,
        updatedAt: new Date(),
      }

      if (existing) {
        await db.update(userSettings).set(values).where(eq(userSettings.userId, userId))
      } else {
        await db.insert(userSettings).values({ userId, ...values })
      }

      embeddingService.invalidateUser(userId)

      const resolved = await embeddingService.loadSettings(userId)
      const response: SettingsResponse = {
        embeddingProvider: resolved.provider,
        apiBaseUrl: resolved.apiBaseUrl ?? defaultApiBaseUrl(resolved.provider),
        modelName: resolved.modelName,
        apiKeySet: Boolean(resolved.apiKey),
        apiKeyMasked: resolved.apiKey ? maskApiKey(resolved.apiKey) : null,
        matchesDefaultEmbedding: matchesDefaultEmbedding(
          resolved.provider,
          resolved.modelName,
          defaultEmbedding
        ),
        updatedAt: values.updatedAt.toISOString(),
        defaultEmbedding,
      }

      return reply.send(response)
    }
  )
}
