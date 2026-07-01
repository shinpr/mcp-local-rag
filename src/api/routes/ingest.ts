// File indexing routes — background ingestion jobs

import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { indexJobs, projects, uploadedFiles } from '../db/schema.js'
import { recoverProjectIndexing } from '../ingest-recovery.js'
import { ingestFile } from '../ingest-worker.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import type { RagServices } from '../rag-services.js'
import { getEmbedder, getVectorStore } from '../rag-services.js'
import { emptyBodySchema, indexProjectSchema, reindexProjectSchema } from '../schemas/requests.js'
import { resolveStoredFilePath } from '../upload-utils.js'

type FileRow = typeof uploadedFiles.$inferSelect

const RETRYABLE_STATUSES = ['pending', 'failed', 'indexing'] as const

function isRetryableStatus(status: string): boolean {
  return (RETRYABLE_STATUSES as readonly string[]).includes(status)
}

interface IndexJobResult {
  jobId: number
  status: 'running'
  filesQueued: number
}

export function registerIngestRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  services: RagServices
): void {
  const db = getDb(config.databaseUrl)

  const hasActiveIndexJob = async (projectId: number): Promise<boolean> => {
    const [job] = await db
      .select({ id: indexJobs.id })
      .from(indexJobs)
      .where(and(eq(indexJobs.projectId, projectId), eq(indexJobs.status, 'running')))
      .limit(1)
    return !!job
  }

  const selectIndexableFiles = async (
    projectId: number,
    userId: number,
    fileIds?: number[]
  ): Promise<FileRow[]> => {
    const allProjectFiles = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.userId, userId)))

    const activeJob = await hasActiveIndexJob(projectId)

    if (fileIds && fileIds.length > 0) {
      return allProjectFiles.filter((f) => {
        if (!fileIds.includes(f.id) || !isRetryableStatus(f.indexingStatus)) return false
        if (f.indexingStatus === 'indexing' && activeJob) return false
        return true
      })
    }

    return allProjectFiles.filter((f) => {
      if (f.indexingStatus === 'pending') return true
      if (f.indexingStatus === 'indexing' && !activeJob) return true
      return false
    })
  }

  const runIngestionJob = (jobId: number, projectName: string, filesToIndex: FileRow[]): void => {
    const totalFiles = filesToIndex.length

    ;(async () => {
      let succeeded = 0
      let attempted = 0
      let totalChunks = 0

      for (const file of filesToIndex) {
        await db
          .update(uploadedFiles)
          .set({ indexingStatus: 'indexing', errorMessage: null })
          .where(eq(uploadedFiles.id, file.id))

        try {
          const absolutePath = resolveStoredFilePath(file.filePath, config.uploadDir, {
            projectId: file.projectId,
            storedFilename: file.storedFilename,
          })
          const chunkCount = await ingestFile({
            filePath: file.filePath,
            projectId: file.projectId,
            storedFilename: file.storedFilename,
            projectName,
            vectorStore: getVectorStore(services),
            embedder: getEmbedder(services),
            config,
          })

          await db
            .update(uploadedFiles)
            .set({
              indexingStatus: 'indexed',
              chunkCount,
              indexedAt: new Date(),
              filePath: absolutePath,
            })
            .where(eq(uploadedFiles.id, file.id))

          succeeded++
          totalChunks += chunkCount
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await db
            .update(uploadedFiles)
            .set({ indexingStatus: 'failed', errorMessage: message })
            .where(eq(uploadedFiles.id, file.id))
        }

        attempted++
        await db
          .update(indexJobs)
          .set({
            filesProcessed: attempted,
            chunksCreated: totalChunks,
          })
          .where(eq(indexJobs.id, jobId))
      }

      await db
        .update(indexJobs)
        .set({
          status: succeeded === totalFiles ? 'completed' : 'failed',
          filesProcessed: attempted,
          chunksCreated: totalChunks,
          finishedAt: new Date(),
          errorMessage: succeeded < totalFiles ? `${totalFiles - succeeded} file(s) failed` : null,
        })
        .where(eq(indexJobs.id, jobId))
    })()
  }

  const startIndexJob = async (
    userId: number,
    projectId: number,
    projectName: string,
    filesToIndex: FileRow[]
  ): Promise<IndexJobResult> => {
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

    runIngestionJob(job.id, projectName, filesToIndex)

    return {
      jobId: job.id,
      status: 'running',
      filesQueued: filesToIndex.length,
    }
  }

  // POST /projects/:id/reset-stuck — fail orphaned jobs and reset indexing files to pending
  app.post(
    '/projects/:id/reset-stuck',
    { preHandler: [requireAuth], schema: emptyBodySchema },
    async (request, reply) => {
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

      const result = await recoverProjectIndexing(config, projectId)
      return reply.code(200).send(result)
    }
  )

  // POST /projects/:id/index
  app.post(
    '/projects/:id/index',
    { preHandler: [requireAuth], schema: indexProjectSchema },
    async (request, reply) => {
      const userId = (request.user as JwtPayload).id
      const { id } = request.params as { id: string }
      const projectId = Number.parseInt(id, 10)
      const { fileIds } = (request.body as { fileIds?: number[] }) ?? {}

      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
        .limit(1)

      if (!project) {
        return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
      }

      await recoverProjectIndexing(config, projectId)

      const filesToIndex: FileRow[] = await selectIndexableFiles(projectId, userId, fileIds)

      if (filesToIndex.length === 0) {
        return reply.code(400).send({
          error: 'Bad Request',
          message:
            'No files to index — upload files or use Reindex all for already-indexed documents',
        })
      }

      const result = await startIndexJob(userId, projectId, project.name, filesToIndex)
      return reply.code(202).send(result)
    }
  )

  const selectReindexableFiles = async (
    projectId: number,
    userId: number,
    fileIds?: number[]
  ): Promise<FileRow[]> => {
    const projectFiles = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.userId, userId)))

    const activeJob = await hasActiveIndexJob(projectId)

    const candidates =
      fileIds && fileIds.length > 0
        ? projectFiles.filter((f) => fileIds.includes(f.id))
        : projectFiles

    return candidates.filter((f) => {
      if (f.indexingStatus === 'indexing' && activeJob) return false
      return true
    })
  }

  // POST /projects/:id/reindex
  app.post(
    '/projects/:id/reindex',
    { preHandler: [requireAuth], schema: reindexProjectSchema },
    async (request, reply) => {
      const userId = (request.user as JwtPayload).id
      const { id } = request.params as { id: string }
      const projectId = Number.parseInt(id, 10)
      const { fileIds } = (request.body as { fileIds?: number[] }) ?? {}

      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
        .limit(1)

      if (!project) {
        return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
      }

      await recoverProjectIndexing(config, projectId)

      const filesToReindex = await selectReindexableFiles(projectId, userId, fileIds)

      if (filesToReindex.length === 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No files to reindex' })
      }

      const fileIdList = filesToReindex.map((f) => f.id)

      await db
        .update(uploadedFiles)
        .set({ indexingStatus: 'pending', chunkCount: 0, errorMessage: null, indexedAt: null })
        .where(inArray(uploadedFiles.id, fileIdList))

      const refreshedFiles = await db
        .select()
        .from(uploadedFiles)
        .where(inArray(uploadedFiles.id, fileIdList))

      const result = await startIndexJob(userId, projectId, project.name, refreshedFiles)
      return reply.code(202).send(result)
    }
  )

  // POST /files/:id/reindex
  app.post(
    '/files/:id/reindex',
    { preHandler: [requireAuth], schema: emptyBodySchema },
    async (request, reply) => {
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

      if (file.indexingStatus === 'indexing') {
        const activeJob = await hasActiveIndexJob(file.projectId)
        if (activeJob) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'File is already being indexed',
          })
        }
      }

      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, file.projectId), eq(projects.userId, userId)))
        .limit(1)

      if (!project) {
        return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
      }

      await recoverProjectIndexing(config, file.projectId)

      await db
        .update(uploadedFiles)
        .set({ indexingStatus: 'pending', chunkCount: 0, errorMessage: null, indexedAt: null })
        .where(eq(uploadedFiles.id, fileId))

      const [refreshedFile] = await db
        .select()
        .from(uploadedFiles)
        .where(eq(uploadedFiles.id, fileId))
        .limit(1)

      if (!refreshedFile) {
        throw new Error('Failed to refresh file record')
      }

      const result = await startIndexJob(userId, file.projectId, project.name, [refreshedFile])
      return reply.code(202).send(result)
    }
  )

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
