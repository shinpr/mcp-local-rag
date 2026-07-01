// Stage 2 API integration tests — auth, projects, files, search, health

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testModelCacheDir } from '../../__tests__/test-device.js'
import { Embedder } from '../../embedder/index.js'
import { VectorStore } from '../../vectordb/index.js'
import { resolveApiConfig } from '../config.js'
import { closeDb, resetDb } from '../db/index.js'
import { buildApp } from '../server.js'

/**
 * Full API integration test: boots a Fastify test server with real
 * VectorStore + Embedder, exercises every endpoint group.
 */
describe('Stage 2 — API integration', () => {
  const lanceDbPath = resolve('./tmp/test-api-lancedb')
  const uploadDir = resolve('./tmp/test-api-uploads')
  const cacheDir = testModelCacheDir(resolve('./tmp/test-api-models'))
  const testFileDir = resolve('./tmp/test-api-files')

  let app: Awaited<ReturnType<typeof buildApp>>
  let authToken: string
  let projectId: number

  beforeAll(async () => {
    // Clean up
    for (const dir of [lanceDbPath, uploadDir, testFileDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true })
    }
    mkdirSync(testFileDir, { recursive: true })

    // Create test file
    writeFileSync(
      resolve(testFileDir, 'test-doc.txt'),
      'This is a test document about machine learning. Neural networks are a subset of machine learning inspired by the structure of the human brain.'
    )

    // Reset DB singleton for test isolation
    await resetDb()

    // Build config — use DATABASE_URL from env or default test database
    const databaseUrl =
      process.env['TEST_DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/mcp_local_rag_test'

    const config = resolveApiConfig({
      DATABASE_URL: databaseUrl,
      DB_PATH: lanceDbPath,
      UPLOAD_DIR: uploadDir,
      MODEL_NAME: 'Xenova/all-MiniLM-L6-v2',
      CACHE_DIR: cacheDir,
      RAG_DEVICE: 'cpu',
      JWT_SECRET: 'test-secret-key-for-integration',
    })

    // Initialize shared components
    const vectorStore = new VectorStore({ dbPath: config.lanceDbPath, tableName: 'chunks' })
    await vectorStore.initialize()

    const embedder = new Embedder({
      modelPath: config.modelName,
      batchSize: 16,
      cacheDir: config.cacheDir,
      device: 'cpu',
    })
    await embedder.initialize()

    // Build Fastify app (async — runs migration)
    app = await buildApp(config, vectorStore, embedder)
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    if (app) await app.close()
    await closeDb()
    for (const dir of [lanceDbPath, uploadDir, testFileDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true })
    }
  })

  // ============================================
  // Health
  // ============================================

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.status).toBe('ok')
      expect(body.version).toBeDefined()
      expect(body.uptime).toBeGreaterThanOrEqual(0)
    })
  })

  // ============================================
  // Auth
  // ============================================

  describe('Auth', () => {
    it('registers a new user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'test@example.com', username: 'testuser', password: 'password123' },
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.id).toBeDefined()
      expect(body.email).toBe('test@example.com')
      expect(body.username).toBe('testuser')
      expect(body.token).toBeDefined()
      authToken = body.token
    })

    it('rejects duplicate email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'test@example.com', username: 'other', password: 'password123' },
      })
      expect(response.statusCode).toBe(409)
    })

    it('rejects duplicate username', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'other@example.com', username: 'testuser', password: 'password123' },
      })
      expect(response.statusCode).toBe(409)
    })

    it('logs in with valid credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'test@example.com', password: 'password123' },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.token).toBeDefined()
      expect(body.email).toBe('test@example.com')
    })

    it('rejects invalid password', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'test@example.com', password: 'wrongpassword' },
      })
      expect(response.statusCode).toBe(401)
    })

    it('returns user info from /auth/me', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.email).toBe('test@example.com')
      expect(body.username).toBe('testuser')
    })

    it('rejects requests without token', async () => {
      const response = await app.inject({ method: 'GET', url: '/auth/me' })
      expect(response.statusCode).toBe(401)
    })
  })

  // ============================================
  // Projects
  // ============================================

  describe('Projects', () => {
    it('creates a project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { name: 'my-project', description: 'Test project' },
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.name).toBe('my-project')
      expect(body.description).toBe('Test project')
      projectId = body.id
    })

    it('rejects duplicate project name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { name: 'my-project' },
      })
      expect(response.statusCode).toBe(409)
    })

    it('lists projects', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toHaveLength(1)
      expect(body[0].name).toBe('my-project')
    })

    it('gets project details', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.name).toBe('my-project')
      expect(body.stats).toBeDefined()
      expect(body.stats.documentCount).toBe(0)
    })

    it('returns 404 for non-existent project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/projects/9999',
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(404)
    })

    it('rejects requests without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/projects' })
      expect(response.statusCode).toBe(401)
    })
  })

  // ============================================
  // Files
  // ============================================

  describe('Files', () => {
    let fileId: number

    it('uploads a file', async () => {
      const fileContent = Buffer.from('Test file content for upload')
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/files/upload`,
        headers: {
          authorization: `Bearer ${authToken}`,
          'content-type': 'multipart/form-data; boundary=test-boundary',
        },
        payload: Buffer.from(
          `--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\n${fileContent.toString()}\r\n--test-boundary--\r\n`
        ),
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.originalFilename).toBe('test.txt')
      expect(body.indexingStatus).toBe('pending')
      fileId = body.id
    })

    it('lists files in a project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/files`,
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toHaveLength(1)
      expect(body[0].originalFilename).toBe('test.txt')
    })

    it('deletes a file', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/files/${fileId}`,
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().deleted).toBe(true)
    })
  })

  // ============================================
  // Search
  // ============================================

  describe('Search', () => {
    it('returns empty results for empty project', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/search',
        headers: { authorization: `Bearer ${authToken}` },
        payload: { projectName: 'my-project', query: 'machine learning' },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.results).toBeDefined()
      expect(body.projectName).toBe('my-project')
    })
  })

  // ============================================
  // Delete project
  // ============================================

  describe('DELETE /projects/:id', () => {
    it('deletes a project', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().deleted).toBe(true)
    })

    it('returns 404 for deleted project', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${authToken}` },
      })
      expect(response.statusCode).toBe(404)
    })
  })
})
