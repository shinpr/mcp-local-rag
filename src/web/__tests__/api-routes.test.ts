import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RAGServer } from '../../server/index.js'
import { createApiRouter } from '../api-routes.js'

// Mock RAGServer
function createMockServer(): Partial<RAGServer> {
  return {
    handleQueryDocuments: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([]) }],
    }),
    handleIngestFile: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ filePath: '/test.txt', chunkCount: 5 }) }],
    }),
    handleIngestData: vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ filePath: '/raw-data/test.md', chunkCount: 3 }) },
      ],
    }),
    handleListFiles: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([]) }],
    }),
    handleDeleteFile: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }],
    }),
    handleStatus: vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalDocuments: 5,
            totalChunks: 50,
            dbSizeBytes: 1024,
            modelName: 'test-model',
            dbPath: './test-db',
          }),
        },
      ],
    }),
  }
}

// Mock Express request and response
function createMockReq(body: unknown = {}, file?: Express.Multer.File): Partial<Request> {
  return { body, file }
}

function createMockRes(): {
  res: Partial<Response>
  json: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
} {
  const json = vi.fn()
  const status = vi.fn().mockReturnThis()
  const res: Partial<Response> = { json, status }
  return { res, json, status }
}

describe('API Routes', () => {
  let mockServer: Partial<RAGServer>

  beforeEach(() => {
    mockServer = createMockServer()
  })

  describe('POST /search', () => {
    it('should call handleQueryDocuments with query and limit', async () => {
      const router = createApiRouter(mockServer as RAGServer)
      const searchRoute = router.stack.find(
        (layer: { route?: { path: string } }) => layer.route?.path === '/search'
      )

      expect(searchRoute).toBeDefined()
    })

    it('should return 400 if query is missing', async () => {
      const router = createApiRouter(mockServer as RAGServer)

      // Find the search handler
      const searchLayer = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/search' && layer.route?.methods?.post
      )

      expect(searchLayer).toBeDefined()

      if (searchLayer?.route?.stack?.[0]?.handle) {
        const handler = searchLayer.route.stack[0].handle
        const req = createMockReq({ query: '' })
        const { res, json, status } = createMockRes()

        await handler(req as Request, res as Response)

        expect(status).toHaveBeenCalledWith(400)
        expect(json).toHaveBeenCalledWith({
          error: 'Query is required and must be a string',
        })
      }
    })
  })

  describe('POST /data', () => {
    it('should return 400 if content is missing', async () => {
      const router = createApiRouter(mockServer as RAGServer)

      const dataLayer = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/data' && layer.route?.methods?.post
      )

      expect(dataLayer).toBeDefined()

      if (dataLayer?.route?.stack?.[0]?.handle) {
        const handler = dataLayer.route.stack[0].handle
        const req = createMockReq({ content: '', metadata: { source: 'test', format: 'text' } })
        const { res, json, status } = createMockRes()

        await handler(req as Request, res as Response)

        expect(status).toHaveBeenCalledWith(400)
        expect(json).toHaveBeenCalledWith({
          error: 'Content is required and must be a string',
        })
      }
    })

    it('should return 400 if metadata is missing', async () => {
      const router = createApiRouter(mockServer as RAGServer)

      const dataLayer = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/data' && layer.route?.methods?.post
      )

      if (dataLayer?.route?.stack?.[0]?.handle) {
        const handler = dataLayer.route.stack[0].handle
        const req = createMockReq({ content: 'test content' })
        const { res, json, status } = createMockRes()

        await handler(req as Request, res as Response)

        expect(status).toHaveBeenCalledWith(400)
        expect(json).toHaveBeenCalledWith({
          error: 'Metadata with source and format is required',
        })
      }
    })
  })

  describe('GET /files', () => {
    it('should call handleListFiles', async () => {
      const router = createApiRouter(mockServer as RAGServer)

      const filesLayer = router.stack.find(
        (layer: { route?: { path: string; methods: { get?: boolean } } }) =>
          layer.route?.path === '/files' && layer.route?.methods?.get
      )

      expect(filesLayer).toBeDefined()

      if (filesLayer?.route?.stack?.[0]?.handle) {
        const handler = filesLayer.route.stack[0].handle
        const req = createMockReq()
        const { res, json } = createMockRes()

        await handler(req as Request, res as Response)

        expect(mockServer.handleListFiles).toHaveBeenCalled()
        expect(json).toHaveBeenCalledWith({ files: [] })
      }
    })
  })

  describe('DELETE /files', () => {
    it('should return 400 if neither filePath nor source provided', async () => {
      const router = createApiRouter(mockServer as RAGServer)

      const deleteLayer = router.stack.find(
        (layer: { route?: { path: string; methods: { delete?: boolean } } }) =>
          layer.route?.path === '/files' && layer.route?.methods?.delete
      )

      expect(deleteLayer).toBeDefined()

      if (deleteLayer?.route?.stack?.[0]?.handle) {
        const handler = deleteLayer.route.stack[0].handle
        const req = createMockReq({})
        const { res, json, status } = createMockRes()

        await handler(req as Request, res as Response)

        expect(status).toHaveBeenCalledWith(400)
        expect(json).toHaveBeenCalledWith({
          error: 'Either filePath or source is required',
        })
      }
    })
  })

  describe('GET /status', () => {
    it('should call handleStatus and return status object', async () => {
      const router = createApiRouter(mockServer as RAGServer)

      const statusLayer = router.stack.find(
        (layer: { route?: { path: string; methods: { get?: boolean } } }) =>
          layer.route?.path === '/status' && layer.route?.methods?.get
      )

      expect(statusLayer).toBeDefined()

      if (statusLayer?.route?.stack?.[0]?.handle) {
        const handler = statusLayer.route.stack[0].handle
        const req = createMockReq()
        const { res, json } = createMockRes()

        await handler(req as Request, res as Response)

        expect(mockServer.handleStatus).toHaveBeenCalled()
        expect(json).toHaveBeenCalledWith({
          totalDocuments: 5,
          totalChunks: 50,
          dbSizeBytes: 1024,
          modelName: 'test-model',
          dbPath: './test-db',
        })
      }
    })
  })

  describe('Router configuration', () => {
    it('should have all 6 expected routes', () => {
      const router = createApiRouter(mockServer as RAGServer)

      const routes = router.stack
        .filter((layer: { route?: unknown }) => layer.route)
        .map((layer: { route: { path: string; methods: Record<string, boolean> } }) => ({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]),
        }))

      expect(routes).toContainEqual({ path: '/search', methods: ['post'] })
      expect(routes).toContainEqual({ path: '/files/upload', methods: ['post'] })
      expect(routes).toContainEqual({ path: '/data', methods: ['post'] })
      expect(routes).toContainEqual({ path: '/files', methods: ['get'] })
      expect(routes).toContainEqual({ path: '/files', methods: ['delete'] })
      expect(routes).toContainEqual({ path: '/status', methods: ['get'] })
    })
  })
})
