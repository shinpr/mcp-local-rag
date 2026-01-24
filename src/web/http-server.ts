// HTTP server for web frontend

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import cors from 'cors'
import express, { type Express } from 'express'
import multer from 'multer'
import type { RAGServer } from '../server/index.js'
import { createApiRouter } from './api-routes.js'

/**
 * HTTP server configuration
 */
export interface HttpServerConfig {
  /** Port to listen on */
  port: number
  /** Upload directory for temporary files */
  uploadDir: string
  /** Static files directory (for production builds) */
  staticDir?: string
}

/**
 * Create and configure Express app
 */
export async function createHttpServer(
  ragServer: RAGServer,
  config: HttpServerConfig
): Promise<Express> {
  const app = express()

  // Middleware
  app.use(cors())
  app.use(express.json({ limit: '50mb' }))

  // Ensure upload directory exists
  if (!existsSync(config.uploadDir)) {
    await mkdir(config.uploadDir, { recursive: true })
  }

  // Configure multer for file uploads
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, config.uploadDir)
    },
    filename: (_req, file, cb) => {
      // Preserve original filename with timestamp prefix
      const timestamp = Date.now()
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')
      cb(null, `${timestamp}-${safeName}`)
    },
  })

  const upload = multer({
    storage,
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
    },
    fileFilter: (_req, file, cb) => {
      // Allow common document types
      const allowedTypes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'text/markdown',
        'text/html',
        'application/json',
      ]
      const allowedExtensions = ['.pdf', '.docx', '.txt', '.md', '.html', '.json']

      const ext = path.extname(file.originalname).toLowerCase()
      if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
        cb(null, true)
      } else {
        cb(new Error(`File type not allowed: ${file.mimetype}`))
      }
    },
  })

  // API routes
  const apiRouter = createApiRouter(ragServer)

  // Apply multer middleware to upload endpoint
  app.use('/api/v1/files/upload', upload.single('file'), (_req, _res, next) => {
    // Multer adds file to req.file
    next()
  })

  app.use('/api/v1', apiRouter)

  // Serve static files in production
  if (config.staticDir && existsSync(config.staticDir)) {
    app.use(express.static(config.staticDir))

    // SPA fallback - serve index.html for all non-API routes
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(config.staticDir as string, 'index.html'))
      }
    })
  }

  // Error handling middleware
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('Server error:', err)
      res.status(500).json({ error: err.message })
    }
  )

  return app
}

/**
 * Start HTTP server
 */
export function startServer(app: Express, port: number): Promise<void> {
  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`Web server running at http://localhost:${port}`)
      resolve()
    })
  })
}
