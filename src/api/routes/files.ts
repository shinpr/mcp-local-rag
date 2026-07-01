// File upload and management routes

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { VectorStore } from '../../vectordb/index.js'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { projects, uploadedFiles } from '../db/schema.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md'])

export function registerFileRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  vectorStore: VectorStore
): void {
  const db = getDb(config.databaseUrl)

  // Ensure upload directory exists
  mkdirSync(config.uploadDir, { recursive: true })

  // POST /projects/:id/files/upload
  app.post('/projects/:id/files/upload', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { id } = request.params as { id: string }
    const projectId = Number.parseInt(id, 10)

    // Verify project belongs to user
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1)

    if (!project) {
      return reply.code(404).send({ error: 'Not Found', message: 'Project not found' })
    }

    // Get uploaded file from multipart
    const data = await request.file()
    if (!data) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No file provided' })
    }

    // Validate file type
    const ext = extname(data.filename)
    const fileType = ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(fileType)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: `Unsupported file type: .${fileType}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
      })
    }

    const chunks: Buffer[] = []
    for await (const chunk of data.file) {
      chunks.push(chunk)
    }
    const fileBuffer = Buffer.concat(chunks)

    // Compute hash
    const sha256Hash = createHash('sha256').update(fileBuffer).digest('hex')

    // Check for duplicate file in same project
    const [duplicate] = await db
      .select()
      .from(uploadedFiles)
      .where(and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.sha256Hash, sha256Hash)))
      .limit(1)

    if (duplicate) {
      return reply.code(409).send({
        error: 'Conflict',
        message: `Duplicate file: "${duplicate.originalFilename}" with the same content already exists in this project`,
      })
    }

    // Generate stored filename
    const storedFilename = `${randomUUID()}${ext}`
    const filePath = join(config.uploadDir, storedFilename)

    // Write file to disk
    await writeFile(filePath, fileBuffer)

    // Insert record
    const [result] = await db
      .insert(uploadedFiles)
      .values({
        userId,
        projectId,
        originalFilename: data.filename,
        storedFilename,
        filePath,
        fileType,
        fileSize: fileBuffer.length,
        sha256Hash,
        indexingStatus: 'pending',
      })
      .returning({
        id: uploadedFiles.id,
        originalFilename: uploadedFiles.originalFilename,
        fileType: uploadedFiles.fileType,
        fileSize: uploadedFiles.fileSize,
        sha256Hash: uploadedFiles.sha256Hash,
        indexingStatus: uploadedFiles.indexingStatus,
      })

    return reply.code(201).send(result)
  })

  // GET /projects/:id/files
  app.get('/projects/:id/files', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = (request.user as JwtPayload).id
    const { id } = request.params as { id: string }
    const projectId = Number.parseInt(id, 10)

    // Verify project belongs to user
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

    // Get project name for vector cleanup
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, file.projectId))
      .limit(1)

    // Delete vectors from LanceDB
    if (project) {
      try {
        await vectorStore.deleteChunks(file.filePath, project.name)
      } catch {
        // Vector cleanup is best-effort
      }
    }

    // Delete file from disk (best-effort)
    try {
      await unlink(file.filePath)
    } catch {
      // File may already be deleted
    }

    // Delete record
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, fileId))

    return { deleted: true }
  })
}
