// File indexing routes — background ingestion jobs

import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Embedder } from '../../embedder/index.js'
import type { VectorStore } from '../../vectordb/index.js'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { indexJobs, projects, uploadedFiles } from '../db/schema.js'
import { ingestFile } from '../ingest-worker.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import { indexProjectSchema } from '../schemas/requests.js'

export function registerIngestRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  vectorStore: VectorStore,
  embedder: Embedder
): void {
  const db = getDb(config.databaseUrl)

  // POST /projects/:id/index
  app.post(
    '/projects/:id/index',
    { preHandler: [requireAuth], schema: indexProjectSchema },
    async (request, reply) => {
      const userId = (request.user as JwtPayload).id
      const { id } = request.params as { id: string }
      const projectId = Number.parseInt(id, 10)
      const { fileIds } = (request.body as { fileIds?: number[] }) ?? {}

      // Verify project belongs to user
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
        .limit(1)

      if (!project) {
        return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
      }

      // Get files to index
      let filesToIndex: Awaited<ReturnType<typeof db.select>> = []
      if (fileIds && fileIds.length > 0) {
        const allProjectFiles = await db
          .select()
          .from(uploadedFiles)
          .where(and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.userId, userId)))
        filesToIndex = allProjectFiles.filter((f) => fileIds.includes(f.id))
      } else {
        filesToIndex = await db
          .select()
          .from(uploadedFiles)
          .where(eq(uploadedFiles.projectId, projectId))
      }

      if (filesToIndex.length === 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No files to index' })
      }

      // Create index job
      const [job] = await db
        .insert(indexJobs)
        .values({
          userId,
          projectId,
          status: 'running',
          startedAt: new Date(),
        })
        .returning({ id: indexJobs.id })

      if (!job) {
        throw new Error('Failed to create index job')
      }

      // Mark files as indexing
      for (const file of filesToIndex) {
        await db
          .update(uploadedFiles)
          .set({ indexingStatus: 'indexing' })
          .where(eq(uploadedFiles.id, file.id))
      }

      // Run ingestion in background (non-blocking)
      const jobId = job.id
      const projectName = project.name

      ;(async () => {
        let processed = 0
        let totalChunks = 0

        for (const file of filesToIndex) {
          try {
            const chunkCount = await ingestFile({
              filePath: file.filePath,
              projectName,
              vectorStore,
              embedder,
              config,
            })

            await db
              .update(uploadedFiles)
              .set({
                indexingStatus: 'indexed',
                chunkCount,
                indexedAt: new Date(),
              })
              .where(eq(uploadedFiles.id, file.id))

            processed++
            totalChunks += chunkCount
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await db
              .update(uploadedFiles)
              .set({ indexingStatus: 'failed', errorMessage: message })
              .where(eq(uploadedFiles.id, file.id))
          }
        }

        // Update job status
        await db
          .update(indexJobs)
          .set({
            status: processed === filesToIndex.length ? 'completed' : 'failed',
            filesProcessed: processed,
            chunksCreated: totalChunks,
            finishedAt: new Date(),
            errorMessage:
              processed < filesToIndex.length
                ? `${filesToIndex.length - processed} file(s) failed`
                : null,
          })
          .where(eq(indexJobs.id, jobId))
      })()

      return reply.code(202).send({
        jobId: job.id,
        status: 'running',
        filesQueued: filesToIndex.length,
      })
    }
  )

  // POST /projects/:id/reindex
  app.post('/projects/:id/reindex', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { id } = request.params as { id: string }
    const projectId = Number.parseInt(id, 10)

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1)

    if (!project) {
      return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
    }

    // Reset all file statuses to pending
    await db
      .update(uploadedFiles)
      .set({ indexingStatus: 'pending', chunkCount: 0, errorMessage: null, indexedAt: null })
      .where(eq(uploadedFiles.projectId, projectId))

    // Create job (actual reindexing happens on next /index call)
    const [job] = await db
      .insert(indexJobs)
      .values({
        userId,
        projectId,
        status: 'pending',
      })
      .returning({ id: indexJobs.id })

    if (!job) {
      throw new Error('Failed to create index job')
    }

    return { jobId: job.id, status: 'pending' }
  })

  // POST /files/:id/reindex
  app.post('/files/:id/reindex', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { id } = request.params as { id: string }
    const fileId = Number.parseInt(id, 10)

    const [file] = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.id, fileId), eq(uploadedFiles.userId, userId)))
      .limit(1)

    if (!file) {
      return reply.code(404).send({ error: 'Not Found', message: 'File not found' })
    }

    // Reset file status
    await db
      .update(uploadedFiles)
      .set({ indexingStatus: 'pending', chunkCount: 0, errorMessage: null, indexedAt: null })
      .where(eq(uploadedFiles.id, fileId))

    // Create job
    const [job] = await db
      .insert(indexJobs)
      .values({
        userId: file.userId,
        projectId: file.projectId,
        status: 'pending',
      })
      .returning({ id: indexJobs.id })

    if (!job) {
      throw new Error('Failed to create index job')
    }

    return { jobId: job.id, status: 'pending' }
  })

  // GET /jobs/:id
  app.get('/jobs/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { id } = request.params as { id: string }
    const jobId = Number.parseInt(id, 10)

    const [job] = await db
      .select()
      .from(indexJobs)
      .where(and(eq(indexJobs.id, jobId), eq(indexJobs.userId, userId)))
      .limit(1)

    if (!job) {
      return reply.code(404).send({ error: 'Not Found', message: 'Job not found' })
    }

    return {
      id: job.id,
      status: job.status,
      filesProcessed: job.filesProcessed,
      chunksCreated: job.chunksCreated,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt?.toISOString(),
      finishedAt: job.finishedAt?.toISOString(),
    }
  })
}
