// Resolves per-user embedding settings and delegates to local or remote clients

import { eq } from 'drizzle-orm'
import type { Embedder } from '../../embedder/index.js'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { userSettings } from '../db/schema.js'
import {
  buildDefaultEmbeddingInfo,
  defaultApiBaseUrl,
  resolveDefaultModelName,
} from './defaults.js'
import { RemoteEmbedder } from './remote-embedder.js'
import { decryptApiKey } from './settings-crypto.js'
import type { EmbeddingClient, EmbeddingProvider, ResolvedEmbeddingSettings } from './types.js'

export class EmbeddingService {
  private readonly config: ApiConfig
  private readonly localEmbedder: Embedder
  private readonly clientCache = new Map<number, EmbeddingClient>()

  constructor(config: ApiConfig, localEmbedder: Embedder) {
    this.config = config
    this.localEmbedder = localEmbedder
  }

  getDefaultEmbeddingInfo() {
    return buildDefaultEmbeddingInfo(this.config)
  }

  invalidateUser(userId: number): void {
    this.clientCache.delete(userId)
  }

  async getClientForUser(userId: number): Promise<EmbeddingClient> {
    const cached = this.clientCache.get(userId)
    if (cached) return cached

    const settings = await this.loadSettings(userId)
    const client = this.createClient(settings)
    this.clientCache.set(userId, client)
    return client
  }

  async loadSettings(userId: number): Promise<ResolvedEmbeddingSettings> {
    const db = getDb(this.config.databaseUrl)
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)

    if (!row) {
      return {
        provider: 'local',
        apiBaseUrl: null,
        apiKey: null,
        modelName: resolveDefaultModelName(this.config),
      }
    }

    let apiKey: string | null = null
    if (row.apiKeyEncrypted) {
      apiKey = decryptApiKey(row.apiKeyEncrypted, this.config.jwtSecret)
    }

    return {
      provider: row.embeddingProvider as EmbeddingProvider,
      apiBaseUrl: row.apiBaseUrl,
      apiKey,
      modelName: row.modelName ?? resolveDefaultModelName(this.config),
    }
  }

  private createClient(settings: ResolvedEmbeddingSettings): EmbeddingClient {
    if (settings.provider === 'local') {
      return this.localEmbedder
    }

    const apiBaseUrl = settings.apiBaseUrl ?? defaultApiBaseUrl(settings.provider)
    if (!apiBaseUrl) {
      throw new Error(`API base URL is required for provider "${settings.provider}"`)
    }

    const requiresKey = settings.provider === 'openai' || settings.provider === 'nvidia_nim'
    if (requiresKey && !settings.apiKey) {
      throw new Error(`API key is required for provider "${settings.provider}"`)
    }

    return new RemoteEmbedder({
      apiBaseUrl,
      apiKey: settings.apiKey,
      modelName: settings.modelName,
    })
  }
}
