// Search route — wraps VectorStore.search with project scoping

import { basename } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import type { RagServices } from '../rag-services.js'
import { getEmbedder, getVectorStore } from '../rag-services.js'
import { searchSchema } from '../schemas/requests.js'

export function registerSearchRoutes(
  app: FastifyInstance,
  _config: ApiConfig,
  services: RagServices
): void {
  // POST /search
  app.post('/search', { preHandler: [requireAuth], schema: searchSchema }, async (request) => {
    const { projectName, query, limit } = request.body as {
      projectName: string
      query: string
      limit?: number
    }

    // Convert query text to embedding vector
    const queryVector = await getEmbedder(services).embed(query)

    const results = await getVectorStore(services).search(queryVector, {
      queryText: query,
      limit: limit ?? 10,
      projectName,
    })

    return {
      projectName,
      query,
      results: results.map((r) => ({
        content: r.text,
        source: r.filePath,
        filename: basename(r.filePath),
        chunkIndex: r.chunkIndex,
        score: r.score,
      })),
    }
  })
}
