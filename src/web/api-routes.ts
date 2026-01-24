// REST API routes for web frontend

import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import type { RAGServer } from '../server/index.js'

/**
 * Search request body
 */
interface SearchRequest {
  query: string
  limit?: number
}

/**
 * Ingest data request body
 */
interface IngestDataRequest {
  content: string
  metadata: {
    source: string
    format: 'text' | 'html' | 'markdown'
  }
}

/**
 * Delete file request body
 */
interface DeleteFileRequest {
  filePath?: string
  source?: string
}

/**
 * Create API router with all endpoints
 */
export function createApiRouter(server: RAGServer): Router {
  const router = createRouter()

  // POST /api/v1/search - Search documents
  router.post('/search', async (req: Request, res: Response) => {
    try {
      const { query, limit } = req.body as SearchRequest

      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'Query is required and must be a string' })
        return
      }

      const queryInput: { query: string; limit?: number } = { query }
      if (limit !== undefined) {
        queryInput.limit = limit
      }
      const result = await server.handleQueryDocuments(queryInput)
      const data = JSON.parse(result.content[0].text)
      res.json({ results: data })
    } catch (error) {
      console.error('Search error:', error)
      res.status(500).json({ error: (error as Error).message })
    }
  })

  // POST /api/v1/files/upload - Upload files (multipart)
  router.post('/files/upload', async (req: Request, res: Response) => {
    try {
      // File is attached by multer middleware
      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' })
        return
      }

      // Use the uploaded file path
      const result = await server.handleIngestFile({ filePath: file.path })
      const data = JSON.parse(result.content[0].text)
      res.json(data)
    } catch (error) {
      console.error('Upload error:', error)
      res.status(500).json({ error: (error as Error).message })
    }
  })

  // POST /api/v1/data - Ingest content strings
  router.post('/data', async (req: Request, res: Response) => {
    try {
      const { content, metadata } = req.body as IngestDataRequest

      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'Content is required and must be a string' })
        return
      }

      if (!metadata || !metadata.source || !metadata.format) {
        res.status(400).json({ error: 'Metadata with source and format is required' })
        return
      }

      const result = await server.handleIngestData({ content, metadata })
      const data = JSON.parse(result.content[0].text)
      res.json(data)
    } catch (error) {
      console.error('Ingest data error:', error)
      res.status(500).json({ error: (error as Error).message })
    }
  })

  // GET /api/v1/files - List ingested files
  router.get('/files', async (_req: Request, res: Response) => {
    try {
      const result = await server.handleListFiles()
      const data = JSON.parse(result.content[0].text)
      res.json({ files: data })
    } catch (error) {
      console.error('List files error:', error)
      res.status(500).json({ error: (error as Error).message })
    }
  })

  // DELETE /api/v1/files - Delete file/source
  router.delete('/files', async (req: Request, res: Response) => {
    try {
      const { filePath, source } = req.body as DeleteFileRequest

      if (!filePath && !source) {
        res.status(400).json({ error: 'Either filePath or source is required' })
        return
      }

      const deleteInput: { filePath?: string; source?: string } = {}
      if (filePath !== undefined) {
        deleteInput.filePath = filePath
      }
      if (source !== undefined) {
        deleteInput.source = source
      }
      const result = await server.handleDeleteFile(deleteInput)
      const data = JSON.parse(result.content[0].text)
      res.json(data)
    } catch (error) {
      console.error('Delete file error:', error)
      res.status(500).json({ error: (error as Error).message })
    }
  })

  // GET /api/v1/status - System status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const result = await server.handleStatus()
      const data = JSON.parse(result.content[0].text)
      res.json(data)
    } catch (error) {
      console.error('Status error:', error)
      res.status(500).json({ error: (error as Error).message })
    }
  })

  return router
}
