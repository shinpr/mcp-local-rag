// File upload and management routes

import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { projects, uploadedFiles } from '../db/schema.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import type { RagServices } from '../rag-services.js'
import { getVectorStore } from '../rag-services.js'
import {
  deleteStoredFileChunks,
  readMultipartFile,
  resolveStoredFilePath,
  sanitizeFilename,
  UploadValidationError,
} from '../upload-utils.js'

function projectUploadDir(config: ApiConfig, projectId: number): string {
  const dir = join(config.uploadDir, String(projectId))
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileResponse(
  file: Pick<
    typeof uploadedFiles.$inferSelect,
    | 'id'
    | 'originalFilename'
    | 'fileType'
    | 'fileSize'
    | 'sha256Hash'
    | 'indexingStatus'
    | 'chunkCount'
    | 'errorMessage'
  >,
  extra?: Record<string, unknown>
) {
  return {
    id: file.id,
    originalFilename: file.originalFilename,
    fileType: file.fileType,
    fileSize: file.fileSize,
    sha256Hash: file.sha256Hash,
    indexingStatus: file.indexingStatus,
    chunkCount: file.chunkCount,
    errorMessage: file.errorMessage,
    ...extra,
  }
}

export function registerFileRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  services: RagServices
): void {
  const db = getDb(config.databaseUrl)

  mkdirSync(config.uploadDir, { recursive: true })

  // POST /projects/:id/files/upload
  app.post('/projects/:id/files/upload', { preHandler: [requireAuth] }, async (request, reply) => {
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

    const data = await request.file()
    if (!data) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No file provided' })
    }

    let parsed: Awaited<ReturnType<typeof readMultipartFile>>
    try {
      parsed = await readMultipartFile(data)
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return reply.code(400).send({ error: 'Bad Request', message: error.message })
      }
      throw error
    }

    const { buffer, originalFilename, fileType, sha256Hash } = parsed

    const [duplicate] = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.sha256Hash, sha256Hash)))
      .limit(1)

    if (duplicate) {
      return reply.code(200).send(
        fileResponse(duplicate, {
          duplicate: true,
          message: `Already uploaded as "${duplicate.originalFilename}"`,
        })
      )
    }

    const ext = extname(originalFilename) || `.${fileType}`
    const storedFilename = `${randomUUID()}${ext}`
    const uploadDir = projectUploadDir(config, projectId)
    const filePath = resolve(join(uploadDir, storedFilename))

    await writeFile(filePath, buffer)

    const [result] = await db
      .insert(uploadedFiles)
      .values({
        userId,
        projectId,
        originalFilename,
        storedFilename,
        filePath,
        fileType,
        fileSize: buffer.length,
        sha256Hash,
        indexingStatus: 'pending',
      })
      .returning()

    if (!result) {
      throw new Error('Failed to save uploaded file')
    }

    return reply.code(201).send(fileResponse(result, { duplicate: false }))
  })

  // GET /projects/:id/files
  app.get('/projects/:id/files', { preHandler: [requireAuth] }, async (request, reply) => {
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

    const files = await db
      .select({
        id: uploadedFiles.id,
        originalFilename: uploadedFiles.originalFilename,
        fileType: uploadedFiles.fileType,
        fileSize: uploadedFiles.fileSize,
        indexingStatus: uploadedFiles.indexingStatus,
        chunkCount: uploadedFiles.chunkCount,
        errorMessage: uploadedFiles.errorMessage,
      })
      .from(uploadedFiles)
      .where(eq(uploadedFiles.projectId, projectId))

    return files
  })

  // GET /files/:id/download — download the persisted original file
  app.get('/files/:id/download', { preHandler: [requireAuth] }, async (request, reply) => {
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

    const safeName = sanitizeFilename(file.originalFilename)
    const storedPath = resolveStoredFilePath(file.filePath, config.uploadDir, {
      projectId: file.projectId,
      storedFilename: file.storedFilename,
    })

    if (!existsSync(storedPath)) {
      return reply.code(404).send({
        error: 'Not Found',
        message:
          'Original file is not on this server. Re-upload the file, or mount UPLOAD_DIR from the machine where it was stored.',
      })
    }

    return reply
      .header('Content-Disposition', `attachment; filename="${safeName}"`)
      .type(`application/octet-stream`)
      .send(createReadStream(storedPath))
  })

  // POST /files/:id/replace — replace document content, clear vectors, reset to pending
  app.post('/files/:id/replace', { preHandler: [requireAuth] }, async (request, reply) => {
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

    const data = await request.file()
    if (!data) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No file provided' })
    }

    let parsed: Awaited<ReturnType<typeof readMultipartFile>>
    try {
      parsed = await readMultipartFile(data)
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return reply.code(400).send({ error: 'Bad Request', message: error.message })
      }
      throw error
    }

    const { buffer, originalFilename, fileType, sha256Hash } = parsed

    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, file.projectId))
      .limit(1)

    const storedPath = resolveStoredFilePath(file.filePath, config.uploadDir, {
      projectId: file.projectId,
      storedFilename: file.storedFilename,
    })

    if (project) {
      await deleteStoredFileChunks(
        getVectorStore(services),
        file.filePath,
        config.uploadDir,
        { projectId: file.projectId, storedFilename: file.storedFilename },
        project.name
      )
    }

    try {
      await unlink(storedPath)
    } catch {
      // Old file may already be gone
    }

    const ext = extname(originalFilename) || `.${fileType}`
    const storedFilename = `${randomUUID()}${ext}`
    const uploadDir = projectUploadDir(config, file.projectId)
    const newFilePath = resolve(join(uploadDir, storedFilename))

    await writeFile(newFilePath, buffer)

    const [updated] = await db
      .update(uploadedFiles)
      .set({
        originalFilename,
        storedFilename,
        filePath: newFilePath,
        fileType,
        fileSize: buffer.length,
        sha256Hash,
        indexingStatus: 'pending',
        chunkCount: 0,
        errorMessage: null,
        indexedAt: null,
      })
      .where(eq(uploadedFiles.id, fileId))
      .returning()

    if (!updated) {
      throw new Error('Failed to update file record')
    }

    return fileResponse(updated, { replaced: true })
  })

  // DELETE /files/:id — delete file from disk, remove from DB, delete vectors from LanceDB
  app.delete('/files/:id', { preHandler: [requireAuth] }, async (request, reply) => {
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

    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, file.projectId))
      .limit(1)

    const storedPath = resolveStoredFilePath(file.filePath, config.uploadDir, {
      projectId: file.projectId,
      storedFilename: file.storedFilename,
    })

    if (project) {
      await deleteStoredFileChunks(
        getVectorStore(services),
        file.filePath,
        config.uploadDir,
        { projectId: file.projectId, storedFilename: file.storedFilename },
        project.name
      )
    }

    try {
      await unlink(storedPath)
    } catch {
      // File may already be deleted
    }

    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId))

    return { deleted: true }
  })
}
