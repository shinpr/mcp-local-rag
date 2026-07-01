import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveApiConfig } from '../config.js'
import { closeDb, getDb, resetDb } from '../db/index.js'
import { indexJobs, projects, uploadedFiles, users } from '../db/schema.js'
import { recoverProjectIndexing, recoverStuckIndexing } from '../ingest-recovery.js'

describe('ingest-recovery', () => {
  const databaseUrl =
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://postgres:postgres@localhost:5432/mcp_local_rag_test'

  let config: ReturnType<typeof resolveApiConfig>
  let projectId: number

  beforeAll(async () => {
    await resetDb()
    config = resolveApiConfig({ DATABASE_URL: databaseUrl, JWT_SECRET: 'test-secret' })
    const db = getDb(config.databaseUrl)

    const [user] = await db
      .insert(users)
      .values({
        email: 'recovery@test.local',
        username: 'recovery-user',
        passwordHash: 'hash',
      })
      .returning({ id: users.id })

    const [project] = await db
      .insert(projects)
      .values({ userId: user!.id, name: 'recovery-project' })
      .returning({ id: projects.id })

    projectId = project!.id

    await db.insert(uploadedFiles).values([
      {
        userId: user!.id,
        projectId,
        originalFilename: 'stuck-a.txt',
        storedFilename: 'stuck-a.txt',
        filePath: '/tmp/stuck-a.txt',
        fileType: 'txt',
        fileSize: 1,
        indexingStatus: 'indexing',
      },
      {
        userId: user!.id,
        projectId,
        originalFilename: 'ready-b.txt',
        storedFilename: 'ready-b.txt',
        filePath: '/tmp/ready-b.txt',
        fileType: 'txt',
        fileSize: 1,
        indexingStatus: 'indexed',
        chunkCount: 2,
      },
    ])

    await db.insert(indexJobs).values({
      userId: user!.id,
      projectId,
      status: 'running',
      startedAt: new Date(),
    })
  })

  afterAll(async () => {
    await closeDb()
  })

  it('recoverProjectIndexing fails running jobs and resets indexing files', async () => {
    const result = await recoverProjectIndexing(config, projectId)
    expect(result.jobsFailed).toBe(1)
    expect(result.filesReset).toBe(1)

    const db = getDb(config.databaseUrl)
    const files = await db
      .select({ status: uploadedFiles.indexingStatus })
      .from(uploadedFiles)
      .where(eq(uploadedFiles.projectId, projectId))

    expect(files.filter((f) => f.status === 'pending')).toHaveLength(1)
    expect(files.filter((f) => f.status === 'indexed')).toHaveLength(1)

    const [job] = await db
      .select({ status: indexJobs.status })
      .from(indexJobs)
      .where(eq(indexJobs.projectId, projectId))
      .limit(1)

    expect(job?.status).toBe('failed')
  })

  it('recoverStuckIndexing resets all projects on startup', async () => {
    const db = getDb(config.databaseUrl)

    await db
      .update(uploadedFiles)
      .set({ indexingStatus: 'indexing' })
      .where(eq(uploadedFiles.originalFilename, 'ready-b.txt'))

    await db.insert(indexJobs).values({
      userId: 1,
      projectId,
      status: 'running',
      startedAt: new Date(),
    })

    const result = await recoverStuckIndexing(config)
    expect(result.jobsFailed).toBeGreaterThanOrEqual(1)
    expect(result.filesReset).toBeGreaterThanOrEqual(1)
  })
})
