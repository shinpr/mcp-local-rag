// Search route — wraps VectorStore.search with project scoping

import { basename } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Embedder } from '../../embedder/index.js'
import type { VectorStore } from '../../vectordb/index.js'
import type { ApiConfig } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import { searchSchema } from '../schemas/requests.js'

export function registerSearchRoutes(
  app: FastifyInstance,
  _config: ApiConfig,
  vectorStore: VectorStore,
  embedder: Embedder
): void {
  // POST /search
  app.post('/search', { preHandler: [requireAuth], schema: searchSchema }, async (request) => {
    const { projectName, query, limit } = request.body as {
      projectName: string
      query: string
      limit?: number
    }

    // Convert query text to embedding vector
    const queryVector = await embedder.embed(query)

    const results = await vectorStore.search(queryVector, {
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
