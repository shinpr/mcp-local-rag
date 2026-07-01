// Project CRUD routes

import { unlink } from 'node:fs/promises'
import { and, count, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { VectorStore } from '../../vectordb/index.js'
import type { ApiConfig } from '../config.js'
import { getDb } from '../db/index.js'
import { projects, uploadedFiles } from '../db/schema.js'
import { type JwtPayload, requireAuth } from '../middleware/auth.js'
import { createProjectSchema } from '../schemas/requests.js'

export function registerProjectRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  vectorStore: VectorStore
): void {
  const db = getDb(config.databaseUrl)

  // POST /projects
  app.post(
    '/projects',
    { preHandler: [requireAuth], schema: createProjectSchema },
    async (request, reply) => {
      const userId = (request.user as JwtPayload).id
      const { name, description } = request.body as {
        name: string
        description?: string
      }

      // Check for duplicate project name for this user
      const [existing] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.userId, userId), eq(projects.name, name)))
        .limit(1)

      if (existing) {
        return reply
          .code(409)
          .send({ error: 'Conflict', message: 'Project with this name already exists' })
      }

      const [result] = await db
        .insert(projects)
        .values({
          userId,
          name,
          description: description ?? null,
        })
        .returning({
          id: projects.id,
          name: projects.name,
          description: projects.description,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
        })

      if (!result) {
        throw new Error('Failed to create project')
      }

      return reply.code(201).send({
        ...result,
        createdAt: result.createdAt?.toISOString(),
        updatedAt: result.updatedAt?.toISOString(),
      })
    }
  )

  // GET /projects
  app.get('/projects', { preHandler: [requireAuth] }, async (request) => {
    const userId = (request.user as JwtPayload).id
    const userProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.userId, userId))

    return userProjects.map((p) => ({
      ...p,
      createdAt: p.createdAt?.toISOString(),
      updatedAt: p.updatedAt?.toISOString(),
    }))
  })

  // GET /projects/:id
  app.get('/projects/:id', { preHandler: [requireAuth] }, async (request, reply) => {
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

    // Get file stats
    const [stats] = await db
      .select({
        documentCount: count(),
      })
      .from(uploadedFiles)
      .where(eq(uploadedFiles.projectId, projectId))

    // Get actual chunk count sum
    const allFiles = await db
      .select({ chunkCount: uploadedFiles.chunkCount })
      .from(uploadedFiles)
      .where(eq(uploadedFiles.projectId, projectId))

    const totalChunks = allFiles.reduce((sum, f) => sum + f.chunkCount, 0)

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      createdAt: project.createdAt?.toISOString(),
      updatedAt: project.updatedAt?.toISOString(),
      stats: {
        documentCount: stats?.documentCount ?? 0,
        chunkCount: totalChunks,
      },
    }
  })

  // DELETE /projects/:id
  app.delete('/projects/:id', { preHandler: [requireAuth] }, async (request, reply) => {
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

    // Delete LanceDB chunks for this project
    try {
      await vectorStore.deleteProject(project.name)
    } catch {
      // LanceDB delete is best-effort; project may have no chunks
    }

    // Delete uploaded files from disk
    const projectFiles = await db
      .select({ filePath: uploadedFiles.filePath })
      .from(uploadedFiles)
      .where(eq(uploadedFiles.projectId, projectId))

    for (const file of projectFiles) {
      try {
        await unlink(file.filePath)
      } catch {
        // File may already be deleted
      }
    }

    // Delete uploaded files records
    await db.delete(uploadedFiles).where(eq(uploadedFiles.projectId, projectId))

    // Delete the project
    await db.delete(projects).where(eq(projects.id, projectId))

    return { deleted: true }
  })
}
