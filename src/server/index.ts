// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { formatErrorMessage } from './error-utils.js'
import {
  type ContentFormat,
  extractSourceFromPath,
  generateMetaJsonPath,
  generateRawDataPath,
  isRawDataPath,
  loadMetaJson,
  saveMetaJson,
  saveRawData,
} from './raw-data-utils.js'
import { toolDefinitions } from './tool-definitions.js'
import type {
  DeleteFileInput,
  FileEntry,
  IngestDataInput,
  IngestFileInput,
  IngestInProgressResult,
  IngestStartedResult,
  IngestionJob,
  ListFilesResult,
  QueryDocumentsInput,
  QueryResult,
  RAGServerConfig,
  SourceEntry,
} from './types.js'

/** RAG server compliant with MCP Protocol */
export class RAGServer {
  private readonly server: Server
  private readonly vectorStore: VectorStore
  private readonly embedder: Embedder
  private readonly chunker: SemanticChunker
  private readonly parser: DocumentParser
  private readonly dbPath: string
  private readonly baseDir: string
  // Used by handleListFiles filter to exclude system-managed directories
  private readonly excludePaths: string[]

  // In-memory tracking of active and failed ingestion jobs, keyed by filePath
  private readonly ingestionJobs: Map<string, IngestionJob> = new Map()
  // Promises for pending background ingestions, keyed by filePath
  private readonly pendingIngestions: Map<string, Promise<void>> = new Map()

  constructor(config: RAGServerConfig) {
    this.dbPath = config.dbPath
    this.baseDir = config.baseDir
    this.excludePaths = [`${resolve(config.dbPath)}/`, `${resolve(config.cacheDir)}/`]
    this.server = new Server(
      { name: 'rag-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    // Component initialization
    // Only pass quality filter settings if they are defined
    const vectorStoreConfig: ConstructorParameters<typeof VectorStore>[0] = {
      dbPath: config.dbPath,
      tableName: 'chunks',
    }
    if (config.maxDistance !== undefined) {
      vectorStoreConfig.maxDistance = config.maxDistance
    }
    if (config.grouping !== undefined) {
      vectorStoreConfig.grouping = config.grouping
    }
    if (config.hybridWeight !== undefined) {
      vectorStoreConfig.hybridWeight = config.hybridWeight
    }
    if (config.maxFiles !== undefined) {
      vectorStoreConfig.maxFiles = config.maxFiles
    }
    this.vectorStore = new VectorStore(vectorStoreConfig)
    this.embedder = new Embedder({
      modelPath: config.modelName,
      batchSize: 16,
      cacheDir: config.cacheDir,
    })
    this.chunker = new SemanticChunker()
    this.parser = new DocumentParser({
      baseDir: config.baseDir,
      maxFileSize: config.maxFileSize,
    })

    this.setupHandlers()
  }

  /**
   * Set up MCP handlers
   */
  private setupHandlers(): void {
    // Tool list
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolDefinitions,
    }))

    // Tool invocation
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: { params: { name: string; arguments?: unknown } }) => {
        switch (request.params.name) {
          case 'query_documents':
            return await this.handleQueryDocuments(
              request.params.arguments as unknown as QueryDocumentsInput
            )
          case 'ingest_file':
            return await this.handleIngestFile(
              request.params.arguments as unknown as IngestFileInput
            )
          case 'ingest_data':
            return await this.handleIngestData(
              request.params.arguments as unknown as IngestDataInput
            )
          case 'delete_file':
            return await this.handleDeleteFile(
              request.params.arguments as unknown as DeleteFileInput
            )
          case 'list_files':
            return await this.handleListFiles()
          case 'status':
            return await this.handleStatus()
          default:
            throw new Error(`Unknown tool: ${request.params.name}`)
        }
      }
    )
  }

  /**
   * Initialization
   */
  async initialize(): Promise<void> {
    await this.vectorStore.initialize()
    console.error('RAGServer initialized')
  }

  /**
   * query_documents tool handler
   */
  async handleQueryDocuments(
    args: QueryDocumentsInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Generate query embedding
      const queryVector = await this.embedder.embed(args.query)

      // Hybrid search (vector + BM25 keyword matching)
      const searchResults = await this.vectorStore.search(queryVector, args.query, args.limit || 10)

      // Format results with source restoration for raw-data files
      const results: QueryResult[] = searchResults.map((result) => {
        const queryResult: QueryResult = {
          filePath: result.filePath,
          chunkIndex: result.chunkIndex,
          text: result.text,
          score: result.score,
          fileTitle: result.fileTitle ?? null,
        }

        // Restore source for raw-data files (ingested via ingest_data)
        if (isRawDataPath(result.filePath)) {
          const source = extractSourceFromPath(result.filePath)
          if (source) {
            queryResult.source = source
          }
        }

        return queryResult
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      }
    } catch (error) {
      console.error('Failed to query documents:', error)
      throw error
    }
  }

  /**
   * Core ingestion logic executed in the background.
   * On success the job is removed from ingestionJobs (DB is source of truth).
   * On failure the job status is set to 'failed' with an error message.
   * For raw-data paths a failure triggers rollback (file + .meta.json deletion).
   */
  private async _executeFileIngestion(filePath: string): Promise<void> {
    let backup: VectorChunk[] | null = null

    try {
      // Parse file
      const isPdf = filePath.toLowerCase().endsWith('.pdf')
      let text: string
      let title: string | null = null

      if (isRawDataPath(filePath)) {
        text = await readFile(filePath, 'utf-8')
        const meta = await loadMetaJson(filePath)
        title = meta?.title ?? null
        console.error(`Read raw-data file: ${filePath} (${text.length} characters)`)
      } else if (isPdf) {
        const result = await this.parser.parsePdf(filePath, this.embedder)
        text = result.content
        title = result.title || null
      } else {
        const result = await this.parser.parseFile(filePath)
        text = result.content
        title = result.title || null
      }

      // Split text into semantic chunks
      const chunks = await this.chunker.chunkText(text, this.embedder)

      // Fail-fast: Prevent data loss when chunking produces 0 chunks
      // This check must happen BEFORE delete to preserve existing data on re-ingest
      if (chunks.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No chunks generated from file: ${filePath}. The file may be empty or all content was filtered (minimum 50 characters required). Existing data has been preserved.`
        )
      }

      // Generate embeddings for final chunks
      const embeddings = await this.embedder.embedBatch(chunks.map((chunk) => chunk.text))

      // Create backup (if existing data exists)
      try {
        const existingFiles = await this.vectorStore.listFiles()
        const existingFile = existingFiles.find((file) => file.filePath === filePath)
        if (existingFile && existingFile.chunkCount > 0) {
          const queryVector = embeddings[0] || []
          if (queryVector.length > 0) {
            const allChunks = await this.vectorStore.search(queryVector, undefined, 20)
            backup = allChunks
              .filter((chunk) => chunk.filePath === filePath)
              .map((chunk) => ({
                id: randomUUID(),
                filePath: chunk.filePath,
                chunkIndex: chunk.chunkIndex,
                text: chunk.text,
                vector: queryVector,
                metadata: chunk.metadata,
                fileTitle: chunk.fileTitle ?? null,
                timestamp: new Date().toISOString(),
              }))
          }
          console.error(`Backup created: ${backup?.length || 0} chunks for ${filePath}`)
        }
      } catch (error) {
        console.warn('Failed to create backup (new file?):', error)
      }

      // Delete existing data
      await this.vectorStore.deleteChunks(filePath)
      console.error(`Deleted existing chunks for: ${filePath}`)

      // Create vector chunks
      const timestamp = new Date().toISOString()
      const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
        const embedding = embeddings[index]
        if (!embedding) {
          throw new Error(`Missing embedding for chunk ${index}`)
        }
        return {
          id: randomUUID(),
          filePath,
          chunkIndex: chunk.index,
          text: chunk.text,
          vector: embedding,
          metadata: {
            fileName: filePath.split('/').pop() || filePath,
            fileSize: text.length,
            fileType: filePath.split('.').pop() || '',
          },
          fileTitle: title || null,
          timestamp,
        }
      })

      // Insert vectors (with rollback on failure)
      try {
        await this.vectorStore.insertChunks(vectorChunks)
        console.error(`Inserted ${vectorChunks.length} chunks for: ${filePath}`)
        backup = null
      } catch (insertError) {
        if (backup && backup.length > 0) {
          console.error('Ingestion failed, rolling back...', insertError)
          try {
            await this.vectorStore.insertChunks(backup)
            console.error(`Rollback completed: ${backup.length} chunks restored`)
          } catch (rollbackError) {
            console.error('Rollback failed:', rollbackError)
            throw new Error(
              `Failed to ingest file and rollback failed: ${(insertError as Error).message}`
            )
          }
        }
        throw insertError
      }

      // Success: remove job (DB is now the source of truth)
      this.ingestionJobs.delete(filePath)
      console.error(`Background ingestion completed: ${filePath}`)
    } catch (error) {
      // Update job to failed state
      const job = this.ingestionJobs.get(filePath)
      if (job) {
        job.status = 'failed'
        job.error = formatErrorMessage(error)
      }

      // Raw-data files are owned by the server — clean them up on failure so
      // orphaned files don't accumulate in the raw-data directory.
      if (isRawDataPath(filePath)) {
        try {
          await unlink(filePath)
          await unlink(generateMetaJsonPath(filePath))
          console.error(`Rolled back raw-data file: ${filePath}`)
        } catch {
          console.warn(`Failed to rollback raw-data file: ${filePath}`)
        }
      }

      console.error(`Background ingestion failed for ${filePath}:`, error)
    }
  }

  /**
   * Register an ingestion job and start background processing.
   * Returns the 'started' MCP response. Shared by handleIngestFile and handleIngestData.
   */
  private _startIngestionJob(
    filePath: string,
    displayName: string
  ): { content: [{ type: 'text'; text: string }] } {
    const startedAt = new Date().toISOString()
    const job: IngestionJob = { filePath, status: 'processing', startedAt }
    this.ingestionJobs.set(filePath, job)

    const ingestionPromise = this._executeFileIngestion(filePath)
    this.pendingIngestions.set(filePath, ingestionPromise)
    ingestionPromise.finally(() => this.pendingIngestions.delete(filePath))

    const result: IngestStartedResult = {
      filePath,
      status: 'started',
      message: `Ingestion started for: ${displayName}. Use list_files to monitor progress.`,
      startedAt,
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  /**
   * ingest_file tool handler.
   * Validates the file path immediately, then starts ingestion in the background
   * and returns a 'started' response without waiting for completion.
   * If the same file is already being ingested, returns an 'in_progress' response.
   */
  async handleIngestFile(
    args: IngestFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    // Duplicate-ingest guard
    const existingJob = this.ingestionJobs.get(args.filePath)
    if (existingJob?.status === 'processing') {
      const result: IngestInProgressResult = {
        filePath: args.filePath,
        status: 'in_progress',
        message: `Ingestion already in progress for: ${args.filePath}. Use list_files to monitor progress.`,
        startedAt: existingJob.startedAt,
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }

    // Clear any previous failed job for this path
    this.ingestionJobs.delete(args.filePath)

    try {
      // Validate path upfront (fast I/O check) so obvious errors surface immediately
      if (!isRawDataPath(args.filePath)) {
        await this.parser.validateFilePath(args.filePath)
      }
    } catch (error) {
      if (error instanceof McpError) throw error
      throw new Error(`Failed to ingest file: ${formatErrorMessage(error)}`)
    }

    return this._startIngestionJob(args.filePath, args.filePath)
  }

  /**
   * ingest_data tool handler.
   * Saves raw content to raw-data directory synchronously, then starts ingestion
   * in the background and returns a 'started' response without waiting for completion.
   *
   * For HTML content:
   * - Parses HTML and extracts main content using Readability
   * - Converts to Markdown for better chunking
   * - Saves as .md file
   */
  async handleIngestData(
    args: IngestDataInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Determine the storage format upfront so the duplicate guard can run
      // before expensive content processing (e.g. HTML parsing via Readability).
      // HTML is always converted to Markdown before saving.
      const formatToSave: ContentFormat =
        args.metadata.format === 'html' ? 'markdown' : args.metadata.format
      const rawDataPath = generateRawDataPath(this.dbPath, args.metadata.source, formatToSave)

      // Duplicate-ingest guard — checked early to avoid wasted work
      const existingJob = this.ingestionJobs.get(rawDataPath)
      if (existingJob?.status === 'processing') {
        const result: IngestInProgressResult = {
          filePath: rawDataPath,
          status: 'in_progress',
          message: `Ingestion already in progress for: ${args.metadata.source}. Use list_files to monitor progress.`,
          startedAt: existingJob.startedAt,
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }

      // Clear any previous failed job for this path
      this.ingestionJobs.delete(rawDataPath)

      // Per-format title extraction and content preparation
      let contentToSave = args.content
      let title: string | null = null

      if (args.metadata.format === 'html') {
        console.error(`Parsing HTML from: ${args.metadata.source}`)
        const { content: markdown, title: htmlTitle } = await parseHtml(
          args.content,
          args.metadata.source
        )

        if (!markdown.trim()) {
          throw new Error(
            'Failed to extract content from HTML. The page may have no readable content.'
          )
        }

        title = htmlTitle || null
        contentToSave = markdown
        console.error(`Converted HTML to Markdown: ${markdown.length} characters`)
      } else if (args.metadata.format === 'markdown') {
        const result = extractMarkdownTitle(args.content, args.metadata.source)
        title = result.source !== 'filename' ? result.title : null
      } else {
        // text format
        const result = extractTxtTitle(args.content, args.metadata.source)
        title = result.source !== 'filename' ? result.title : null
      }

      // Save content to raw-data directory (uses the same path as rawDataPath)
      await saveRawData(this.dbPath, args.metadata.source, contentToSave, formatToSave)

      // Save metadata sidecar (.meta.json) alongside the raw-data file
      await saveMetaJson(rawDataPath, {
        title,
        source: args.metadata.source,
        format: args.metadata.format,
      })

      console.error(`Saved raw data: ${args.metadata.source} -> ${rawDataPath}`)

      return this._startIngestionJob(rawDataPath, args.metadata.source)
    } catch (error) {
      const errorMessage = formatErrorMessage(error)

      console.error('Failed to ingest data:', errorMessage)

      throw new Error(`Failed to ingest data: ${errorMessage}`)
    }
  }

  /**
   * list_files tool handler.
   * Scans BASE_DIR for supported files, cross-references with ingested documents,
   * and overlays any active or failed ingestion jobs.
   */
  async handleListFiles(): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Get all ingested entries from the vector store
      const ingested = await this.vectorStore.listFiles()
      const ingestedMap = new Map(ingested.map((f) => [f.filePath, f]))

      // Scan BASE_DIR recursively for supported files.
      const entries = await readdir(this.baseDir, { recursive: true, withFileTypes: true })
      const baseDirFiles = entries
        .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
        .map((e) => {
          // parentPath is the Node 21+ name; path is the deprecated Node 20 alias
          // biome-ignore lint/suspicious/noExplicitAny: parentPath not yet in @types/node@20
          const dir = (e as any).parentPath ?? e.path
          return join(dir, e.name)
        })
        .filter((filePath) => !this.excludePaths.some((ep) => filePath.startsWith(ep)))
        .sort()

      const baseDirSet = new Set(baseDirFiles)

      // Files in BASE_DIR with ingestion status, overlaid with active/failed jobs
      const files: FileEntry[] = baseDirFiles.map((filePath) => {
        const dbEntry = ingestedMap.get(filePath)
        const job = this.ingestionJobs.get(filePath)

        if (dbEntry) {
          // Already ingested — show existing data, overlaid with re-ingestion status
          if (job?.status === 'processing') {
            return {
              filePath,
              ingested: true,
              chunkCount: dbEntry.chunkCount,
              timestamp: dbEntry.timestamp,
              ingesting: true,
              startedAt: job.startedAt,
            }
          }
          if (job?.status === 'failed') {
            return {
              filePath,
              ingested: true,
              chunkCount: dbEntry.chunkCount,
              timestamp: dbEntry.timestamp,
              failed: true,
              error: job.error ?? 'Unknown error',
            }
          }
          return {
            filePath,
            ingested: true,
            chunkCount: dbEntry.chunkCount,
            timestamp: dbEntry.timestamp,
          }
        }

        // Not yet ingested — may have an active or failed job
        if (job?.status === 'processing') {
          return { filePath, ingested: false, ingesting: true, startedAt: job.startedAt }
        }
        if (job?.status === 'failed') {
          return { filePath, ingested: false, failed: true, error: job.error ?? 'Unknown error' }
        }
        return { filePath, ingested: false }
      })

      // Content ingested via ingest_data (web pages, clipboard, etc.) plus any
      // orphaned DB entries whose files no longer exist on disk
      const sources: SourceEntry[] = ingested
        .filter((f) => !baseDirSet.has(f.filePath))
        .map((f) => {
          const job = this.ingestionJobs.get(f.filePath)
          if (isRawDataPath(f.filePath)) {
            const source = extractSourceFromPath(f.filePath)
            if (source) {
              if (job?.status === 'processing') {
                return {
                  source,
                  chunkCount: f.chunkCount,
                  timestamp: f.timestamp,
                  ingesting: true,
                  startedAt: job.startedAt,
                }
              }
              if (job?.status === 'failed') {
                return {
                  source,
                  chunkCount: f.chunkCount,
                  timestamp: f.timestamp,
                  failed: true,
                  error: job.error ?? 'Unknown error',
                }
              }
              return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
            }
          }
          return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
        })

      // Append active/failed ingest_data jobs not yet present in the DB
      for (const [jobFilePath, job] of this.ingestionJobs) {
        if (baseDirSet.has(jobFilePath) || ingestedMap.has(jobFilePath)) continue
        if (!isRawDataPath(jobFilePath)) continue
        const source = extractSourceFromPath(jobFilePath)
        if (!source) continue
        if (job.status === 'processing') {
          sources.push({ source, ingesting: true, startedAt: job.startedAt })
        } else if (job.status === 'failed') {
          sources.push({ source, failed: true, error: job.error ?? 'Unknown error' })
        }
      }

      // Append active/failed jobs for files within BASE_DIR that were not found in the
      // filesystem scan (e.g., the file does not exist or was deleted before ingestion
      // could run). This makes failed ingest attempts visible via list_files.
      const resolvedBaseDir = resolve(this.baseDir)
      const baseDirPrefix = resolvedBaseDir.endsWith(sep) ? resolvedBaseDir : resolvedBaseDir + sep
      for (const [jobFilePath, job] of this.ingestionJobs) {
        if (isRawDataPath(jobFilePath)) continue
        if (baseDirSet.has(jobFilePath) || ingestedMap.has(jobFilePath)) continue
        if (!jobFilePath.startsWith(baseDirPrefix)) continue
        if (job.status === 'processing') {
          files.push({
            filePath: jobFilePath,
            ingested: false,
            ingesting: true,
            startedAt: job.startedAt,
          })
        } else if (job.status === 'failed') {
          files.push({
            filePath: jobFilePath,
            ingested: false,
            failed: true,
            error: job.error ?? 'Unknown error',
          })
        }
      }

      const result: ListFilesResult = { baseDir: this.baseDir, files, sources }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      console.error('Failed to list files:', error)
      throw error
    }
  }

  /**
   * status tool handler (Phase 1: basic implementation)
   */
  async handleStatus(): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      const status = await this.vectorStore.getStatus()
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(status, null, 2),
          },
        ],
      }
    } catch (error) {
      console.error('Failed to get status:', error)
      throw error
    }
  }

  /**
   * delete_file tool handler
   * Deletes chunks from VectorDB and physical raw-data files
   * Supports both filePath (for ingest_file) and source (for ingest_data)
   */
  async handleDeleteFile(
    args: DeleteFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      let targetPath: string
      let skipValidation = false

      if (args.source) {
        // Generate raw-data path from source (extension is always .md)
        // Internal path generation is secure, skip baseDir validation
        targetPath = generateRawDataPath(this.dbPath, args.source, 'markdown')
        skipValidation = true
      } else if (args.filePath) {
        targetPath = args.filePath
      } else {
        throw new Error('Either filePath or source must be provided')
      }

      // Only validate user-provided filePath (not internally generated paths)
      if (!skipValidation) {
        await this.parser.validateFilePath(targetPath)
      }

      // Block deletion while an ingestion job is actively running for this path.
      // Without this guard, the background job would re-insert chunks after the
      // delete completes, causing the file to silently reappear.
      const activeJob = this.ingestionJobs.get(targetPath)
      if (activeJob?.status === 'processing') {
        throw new Error(
          `Cannot delete while ingestion is in progress for: ${targetPath}. Wait for ingestion to complete, then retry.`
        )
      }

      // Clear any lingering failed job for this path since the user is deleting it
      this.ingestionJobs.delete(targetPath)

      // Delete chunks from vector database
      await this.vectorStore.deleteChunks(targetPath)

      // Also delete physical raw-data file if applicable
      if (isRawDataPath(targetPath)) {
        try {
          await unlink(targetPath)
          console.error(`Deleted raw-data file: ${targetPath}`)
        } catch {
          console.warn(`Could not delete raw-data file (may not exist): ${targetPath}`)
        }
        try {
          await unlink(generateMetaJsonPath(targetPath))
          console.error(`Deleted meta.json: ${generateMetaJsonPath(targetPath)}`)
        } catch {
          // .meta.json may not exist for old data, silently ignore
        }
      }

      // Return success message
      const result = {
        filePath: targetPath,
        deleted: true,
        timestamp: new Date().toISOString(),
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error)

      console.error('Failed to delete file:', errorMessage)

      throw new Error(`Failed to delete file: ${errorMessage}`)
    }
  }

  /**
   * Wait for a background ingestion to complete.
   * Resolves immediately if no ingestion is pending for the given file path.
   *
   * Useful for programmatic consumers that need synchronous completion semantics,
   * and for tests that must await ingestion before asserting on results.
   */
  async waitForIngestion(filePath: string): Promise<void> {
    const pending = this.pendingIngestions.get(filePath)
    if (pending) await pending
  }

  /**
   * Start the server
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    console.error('RAGServer running on stdio transport')
  }
}
