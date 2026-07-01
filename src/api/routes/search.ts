// Search route — wraps VectorStore.search with project scoping

import { basename } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { projects, uploadedFiles } from '../db/schema.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import type { RagServices } from '../rag-services.js'
import { getEmbeddingClientForUser, getVectorStore } from '../rag-services.js'
import { searchSchema } from '../schemas/requests.js'

const MAX_SEARCH_LIMIT = 20

export function registerSearchRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  services: RagServices
): void {
  const db = getDb(config.databaseUrl)

  // POST /search
  app.post(
    '/search',
    { preHandler: [requireAuth], schema: searchSchema },
    async (request, reply) => {
      const userId = (request.user as JwtPayload).id
      const { projectName, query, limit } = request.body as {
        projectName: string
        query: string
        limit?: number
      }

      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.name, projectName), eq(projects.userId, userId)))
        .limit(1)

      if (!project) {
        return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
      }

      const effectiveLimit = Math.min(limit ?? 10, MAX_SEARCH_LIMIT)

      const embedder = await getEmbeddingClientForUser(services, userId)
      const queryVector = await embedder.embed(query)

      const results = await getVectorStore(services).search(queryVector, {
        queryText: query,
        limit: effectiveLimit,
        projectName: project.name,
      })

      let warning: string | undefined
      if (results.length === 0) {
        const indexedFiles = await db
          .select({ chunkCount: uploadedFiles.chunkCount })
          .from(uploadedFiles)
          .where(
            and(
              eq(uploadedFiles.projectId, project.id),
              eq(uploadedFiles.userId, userId),
              eq(uploadedFiles.indexingStatus, 'indexed')
            )
          )

        const metadataChunkCount = indexedFiles.reduce((sum, file) => sum + file.chunkCount, 0)
        if (metadataChunkCount > 0) {
          warning =
            `No vectors found for project "${project.name}" in LanceDB at ${config.lanceDbPath}, ` +
            `but metadata shows ${metadataChunkCount} indexed chunk(s). ` +
            'Re-index the project or point DB_PATH at the LanceDB directory that contains your vectors.'
        }
      }

      return {
        projectName: project.name,
        query,
        results: results.map((r) => ({
          content: r.text,
          source: r.filePath,
          filename: basename(r.filePath),
          chunkIndex: r.chunkIndex,
          score: r.score,
        })),
        ...(warning !== undefined ? { warning } : {}),
      }
    }
  )
}
