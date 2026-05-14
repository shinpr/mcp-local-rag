// RAGServer implementation with MCP tools

import { readdir, unlink } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  type Annotations,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { SemanticChunker } from '../chunker/index.js'
import { collectFiles, ingestSingleFile } from '../cli/ingest.js'
import { Embedder } from '../embedder/index.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import {
  type ContentFormat,
  extractSourceFromPath,
  generateMetaJsonPath,
  generateRawDataPath,
  isRawDataPath,
  saveMetaJson,
  saveRawData,
} from '../utils/raw-data-utils.js'
import { createSyncPlan, type SyncFileMetadata, type SyncPlan } from '../utils/sync-utils.js'
import { VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import { formatErrorMessage } from './error-utils.js'
import { toolDefinitions } from './tool-definitions.js'
import type {
  DeleteFileInput,
  FileEntry,
  IngestDataInput,
  IngestFileInput,
  ListFilesResult,
  QueryDocumentsInput,
  QueryResult,
  RAGServerConfig,
  ReadChunkNeighborsInput,
  ReadChunkNeighborsResultItem,
  SourceEntry,
  SyncDataInput,
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
  private readonly configWarnings: string[]
  private queryWarningsShown = false

  private sendChannel(content: string, meta: Record<string, string>): void {
    void (this.server.notification as (n: { method: string; params: unknown }) => Promise<void>)({
      method: 'notifications/claude/channel',
      params: { content, meta },
    }).catch((err) => {
      console.warn(`Channel notification failed: ${err}`)
    })
  }

  constructor(config: RAGServerConfig) {
    this.dbPath = config.dbPath
    this.baseDir = config.baseDir
    this.configWarnings = config.configWarnings ?? []
    this.excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]
    this.server = new Server(
      { name: 'rag-mcp-server', version: '1.0.0' },
      {
        capabilities: {
          tools: {},
          experimental: { 'claude/channel': {} },
        },
        instructions:
          'RAG server for local document ingestion and semantic search. ' +
          'sync_data returns immediately with a plan summary, then fires channel ' +
          'events per file. Watch for event=complete or event=error to know when done.',
      }
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
    this.chunker = new SemanticChunker(
      config.chunkMinLength !== undefined ? { minChunkLength: config.chunkMinLength } : {}
    )
    this.parser = new DocumentParser({
      baseDir: config.baseDir,
      maxFileSize: config.maxFileSize,
    })

    this.setupHandlers()
  }

  /**
   * Build warning content blocks with MCP annotations.
   * Returns an empty array if no warnings exist.
   */
  private buildWarningContentBlocks(): Array<{
    type: 'text'
    text: string
    annotations: Annotations
  }> {
    if (this.configWarnings.length === 0) return []
    return [
      {
        type: 'text' as const,
        text: `Warning: ${this.configWarnings.join(' | ')}`,
        annotations: {
          audience: ['user', 'assistant'] as const,
          priority: 0.3,
        },
      },
    ]
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
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params
      const { signal } = extra

      switch (name) {
        case 'query_documents':
          return await this.handleQueryDocuments(args as unknown as QueryDocumentsInput)
        case 'ingest_file':
          return await this.handleIngestFile(args as unknown as IngestFileInput, signal)
        case 'ingest_data':
          return await this.handleIngestData(args as unknown as IngestDataInput, signal)
        case 'delete_file':
          return await this.handleDeleteFile(args as unknown as DeleteFileInput)
        case 'list_files':
          return await this.handleListFiles()
        case 'status':
          return await this.handleStatus()
        case 'read_chunk_neighbors':
          return await this.handleReadChunkNeighbors(args as unknown as ReadChunkNeighborsInput)
        case 'sync_data':
          return await this.handleSyncData(args as unknown as SyncDataInput, signal)
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
      }
    })
  }

  /**
   * Initialization
   */
  async initialize(): Promise<void> {
    await this.vectorStore.initialize()
    console.error('RAGServer initialized')
  }
  /**
   * handle sync_data tool — returns immediately with plan summary, runs ingestion in background
   */
  private async handleSyncData(
    args: SyncDataInput,
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    try {
      const targetPath = resolve(args.path?.trim() || this.baseDir)

      // 1. Get Disk State
      const fileInfos = await collectFiles(targetPath, this.excludePaths)
      const diskFiles = new Map<string, SyncFileMetadata>(
        fileInfos.map((f) => [f.filePath, { contentHash: f.contentHash }])
      )

      // 2. Get DB State
      const dbFiles = await this.vectorStore.getFileManifest()

      // 3. Create Sync Plan
      const plan = createSyncPlan(diskFiles, dbFiles)

      // 4. Return immediately — background task fires channel events per file
      void this.runSyncBackground(plan, diskFiles, signal)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'started',
              toUpsert: plan.upsertList.length,
              toPrune: plan.pruneList.length,
              toSkip: plan.skipList.length,
            }),
          },
        ],
      }
    } catch (error) {
      if (error instanceof McpError || error instanceof DatabaseError) throw error
      throw new Error(`Failed to sync data: ${formatErrorMessage(error)}`)
    }
  }

  /**
   * Background sync worker — fires channel notifications per file
   */
  private async runSyncBackground(
    plan: SyncPlan,
    diskFiles: Map<string, SyncFileMetadata>,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      if (plan.pruneList.length > 0) {
        if (signal?.aborted) return
        await this.vectorStore.deleteFiles(plan.pruneList)
      }

      let totalChunks = 0
      let upsertCount = 0
      let skippedEmpty = 0

      for (let i = 0; i < plan.upsertList.length; i++) {
        if (signal?.aborted) {
          this.sendChannel(
            `sync_data: aborted after ${upsertCount}/${plan.upsertList.length} files`,
            { tool: 'sync_data', event: 'aborted', upsert_count: String(upsertCount) }
          )
          return
        }

        const filePath = plan.upsertList[i]!
        this.sendChannel(`sync_data: [${i + 1}/${plan.upsertList.length}] ${filePath}`, {
          tool: 'sync_data',
          event: 'file_start',
          file_index: String(i + 1),
          file_total: String(plan.upsertList.length),
        })

        try {
          const contentHash = diskFiles.get(filePath)?.contentHash || ''
          const result = await ingestSingleFile(
            filePath,
            this.parser,
            this.chunker,
            this.embedder,
            this.vectorStore,
            contentHash,
            signal
          )
          totalChunks += result.chunkCount
          upsertCount++
        } catch (error) {
          const message = formatErrorMessage(error)
          if (message.includes('No chunks generated')) {
            skippedEmpty++
            console.warn(`Sync: Skipping empty/short file ${filePath}`)
          } else {
            console.error(`Sync: Failed to ingest ${filePath}:`, message)
            this.sendChannel(`sync_data: error on ${filePath} — ${message}`, {
              tool: 'sync_data',
              event: 'error',
              file_path: filePath,
            })
            return
          }
        }
      }

      if (plan.upsertList.length > 0 || plan.pruneList.length > 0) {
        await this.vectorStore.optimize()
      }

      this.sendChannel(
        `sync_data: complete — ${upsertCount} upserted, ${plan.pruneList.length} pruned, ${plan.skipList.length} unchanged, ${skippedEmpty} skipped (empty), ${totalChunks} total chunks`,
        {
          tool: 'sync_data',
          event: 'complete',
          upsert_count: String(upsertCount),
          prune_count: String(plan.pruneList.length),
          skip_count: String(plan.skipList.length),
          skipped_empty: String(skippedEmpty),
          total_chunks: String(totalChunks),
        }
      )
    } catch (error) {
      this.sendChannel(`sync_data: fatal error — ${formatErrorMessage(error)}`, {
        tool: 'sync_data',
        event: 'error',
      })
    }
  }

  /**
 * query_documents tool handler
...
   */
  async handleQueryDocuments(
    args: QueryDocumentsInput
  ): Promise<{ content: Array<{ type: 'text'; text: string; annotations?: Annotations }> }> {
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

      const content: Array<{ type: 'text'; text: string; annotations?: Annotations }> = [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ]

      // Append config warnings on first query call only
      if (!this.queryWarningsShown) {
        content.push(...this.buildWarningContentBlocks())
        this.queryWarningsShown = true
      }

      return { content }
    } catch (error) {
      console.error('Failed to query documents:', error)
      throw error
    }
  }

  /**
   * ingest_file tool handler (re-ingestion support, transaction processing, rollback capability)
   */
  async handleIngestFile(
    args: IngestFileInput,
    signal?: AbortSignal
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Validate file path (S-002) - bypass for internally managed raw-data files
      if (!isRawDataPath(args.filePath)) {
        await this.parser.validateFilePath(args.filePath)
      }

      this.sendChannel(`ingest_file: starting — ${args.filePath}`, {
        tool: 'ingest_file',
        event: 'start',
      })

      const result = await ingestSingleFile(
        args.filePath,
        this.parser,
        this.chunker,
        this.embedder,
        this.vectorStore,
        undefined,
        signal
      )

      // Optimize after successful ingestion
      await this.vectorStore.optimize()

      this.sendChannel(`ingest_file: done — ${result.chunkCount} chunks from ${args.filePath}`, {
        tool: 'ingest_file',
        event: 'complete',
        chunk_count: String(result.chunkCount),
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      if (error instanceof McpError || error instanceof DatabaseError) throw error
      throw new Error(`Failed to ingest file: ${formatErrorMessage(error)}`)
    }
  }

  /**
   * ingest_data tool handler
   * Saves raw content to raw-data directory and calls handleIngestFile internally
   *
   * For HTML content:
   * - Parses HTML and extracts main content using Readability
   * - Converts to Markdown for better chunking
   * - Saves as .md file
   */
  async handleIngestData(
    args: IngestDataInput,
    signal?: AbortSignal
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      if (signal?.aborted) throw new Error('Operation aborted')
      let contentToSave = args.content
      let formatToSave: ContentFormat = args.metadata.format
      let title: string | null = null

      // Per-format title extraction and content preparation
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
        formatToSave = 'markdown' // Save as .md file
        console.error(`Converted HTML to Markdown: ${markdown.length} characters`)
      } else if (args.metadata.format === 'markdown') {
        const result = extractMarkdownTitle(args.content, args.metadata.source)
        title = result.source !== 'filename' ? result.title : null
      } else {
        // text format
        const result = extractTxtTitle(args.content, args.metadata.source)
        title = result.source !== 'filename' ? result.title : null
      }

      if (signal?.aborted) throw new Error('Operation aborted')

      // Save content to raw-data directory
      const rawDataPath = await saveRawData(
        this.dbPath,
        args.metadata.source,
        contentToSave,
        formatToSave
      )

      // Save metadata sidecar (.meta.json) alongside the raw-data file
      await saveMetaJson(rawDataPath, {
        title,
        source: args.metadata.source,
        format: args.metadata.format,
      })

      console.error(`Saved raw data: ${args.metadata.source} -> ${rawDataPath}`)

      // Call existing ingest_file internally with rollback on failure
      try {
        const ingestResult = await this.handleIngestFile({ filePath: rawDataPath }, signal)
        this.sendChannel(`ingest_data: done — "${args.metadata.source}"`, {
          tool: 'ingest_data',
          event: 'complete',
          source: args.metadata.source,
          format: args.metadata.format,
        })
        return ingestResult
      } catch (ingestError) {
        // Rollback: delete the raw-data file and .meta.json if ingest fails
        try {
          await unlink(rawDataPath)
          await unlink(generateMetaJsonPath(rawDataPath))
          console.error(`Rolled back raw-data file: ${rawDataPath}`)
        } catch {
          console.warn(`Failed to rollback raw-data file: ${rawDataPath}`)
        }
        throw ingestError
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error)

      console.error('Failed to ingest data:', errorMessage)

      throw new Error(`Failed to ingest data: ${errorMessage}`)
    }
  }

  /**
   * list_files tool handler
   * Scans BASE_DIR for supported files and cross-references with ingested documents
   */
  async handleListFiles(): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Get all ingested entries from the vector store
      const ingested = await this.vectorStore.listFiles()
      const ingestedMap = new Map(ingested.map((f) => [f.filePath, f]))

      // Scan BASE_DIR recursively for supported files.
      // Errors propagate to the outer catch: if readdir fails, ingest_file and
      // delete_file won't work either, so surfacing the error is appropriate.
      const entries = await readdir(this.baseDir, { recursive: true, withFileTypes: true })
      const baseDirFiles = entries
        .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
        .map((e) => {
          const dir = e.parentPath
          return join(dir, e.name)
        })
        .filter((filePath) => !this.excludePaths.some((ep) => filePath.startsWith(ep)))
        .sort()

      const baseDirSet = new Set(baseDirFiles)

      // Files in BASE_DIR with ingestion status
      const files: FileEntry[] = baseDirFiles.map((filePath) => {
        const entry = ingestedMap.get(filePath)
        return entry
          ? { filePath, ingested: true, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
          : { filePath, ingested: false }
      })

      // Content ingested via ingest_data (web pages, clipboard, etc.) plus any
      // orphaned DB entries whose files no longer exist on disk
      const sources: SourceEntry[] = ingested
        .filter((f) => !baseDirSet.has(f.filePath))
        .map((f) => {
          if (isRawDataPath(f.filePath)) {
            const source = extractSourceFromPath(f.filePath)
            if (source) return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
          }
          return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
        })

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
  async handleStatus(): Promise<{
    content: Array<{ type: 'text'; text: string; annotations?: Annotations }>
  }> {
    try {
      const status = await this.vectorStore.getStatus()
      const content: Array<{ type: 'text'; text: string; annotations?: Annotations }> = [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ]

      // Always append config warnings to status responses
      content.push(...this.buildWarningContentBlocks())

      return { content }
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

      // Delete chunks from vector database
      await this.vectorStore.deleteChunks(targetPath)
      await this.vectorStore.optimize()

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
   * read_chunk_neighbors tool handler
   * Returns chunks around a target chunkIndex within a single ingested document.
   * Context-expansion utility — not a search tool. Mirrors handleDeleteFile's
   * dual-input (filePath XOR source) resolution pattern.
   */
  async handleReadChunkNeighbors(
    args: ReadChunkNeighborsInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Validation (all before DB access, per Design Doc §Main Components → Handler).
      // Intentional: use McpError(InvalidParams) (upgrade from handleDeleteFile's plain Error).
      // See Design Doc §Main Components → Handler and §Risks — this asymmetry is documented;
      // do not "fix" it.
      if (!Number.isInteger(args.chunkIndex) || args.chunkIndex < 0) {
        throw new McpError(ErrorCode.InvalidParams, 'chunkIndex must be a non-negative integer')
      }
      const before = args.before ?? 2
      if (!Number.isInteger(before) || before < 0) {
        throw new McpError(ErrorCode.InvalidParams, 'before must be a non-negative integer')
      }
      if (before > 50) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `before must be between 0 and 50 (got ${before})`
        )
      }
      const after = args.after ?? 2
      if (!Number.isInteger(after) || after < 0) {
        throw new McpError(ErrorCode.InvalidParams, 'after must be a non-negative integer')
      }
      if (after > 50) {
        throw new McpError(ErrorCode.InvalidParams, `after must be between 0 and 50 (got ${after})`)
      }
      const hasFilePath = typeof args.filePath === 'string' && args.filePath.trim().length > 0
      const hasSource = typeof args.source === 'string' && args.source.trim().length > 0
      if (hasFilePath && hasSource) {
        throw new McpError(ErrorCode.InvalidParams, 'Provide either filePath or source, not both')
      }
      if (!hasFilePath && !hasSource) {
        throw new McpError(ErrorCode.InvalidParams, 'Either filePath or source must be provided')
      }

      // Dual-input resolution (mirrors handleDeleteFile).
      // Use the same non-empty predicates as the XOR check above so an empty
      // string ('' / whitespace-only) is ignored here too, not just in validation.
      let targetPath: string
      let skipValidation = false
      if (hasSource) {
        targetPath = generateRawDataPath(this.dbPath, args.source as string, 'markdown')
        skipValidation = true
      } else {
        // XOR + hasSource === false guarantees filePath is a non-empty string here.
        targetPath = args.filePath as string
      }
      if (!skipValidation) {
        await this.parser.validateFilePath(targetPath)
      }

      // Range composition (handler-side clamp; primitive stays feature-agnostic).
      const minIdx = Math.max(0, args.chunkIndex - before)
      const maxIdx = args.chunkIndex + after

      // Primitive call.
      const rows = await this.vectorStore.getChunksByRange(targetPath, minIdx, maxIdx)

      // Post-fetch marking: isTarget per item; source attached for raw-data rows.
      const isRaw = isRawDataPath(targetPath)
      const sourceForAll = isRaw ? extractSourceFromPath(targetPath) : null
      const items: ReadChunkNeighborsResultItem[] = rows.map((row) => {
        const item: ReadChunkNeighborsResultItem = {
          filePath: row.filePath,
          chunkIndex: row.chunkIndex,
          text: row.text,
          isTarget: row.chunkIndex === args.chunkIndex,
          fileTitle: row.fileTitle ?? null,
        }
        if (sourceForAll) item.source = sourceForAll
        return item
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(items, null, 2),
          },
        ],
      }
    } catch (error) {
      // Re-throw McpError / DatabaseError as-is to preserve semantics.
      if (error instanceof McpError || error instanceof DatabaseError) {
        throw error
      }
      const errorMessage = formatErrorMessage(error)
      console.error('Failed to read chunk neighbors:', errorMessage)
      throw new Error(`Failed to read chunk neighbors: ${errorMessage}`)
    }
  }

  /**
   * Start the server
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    console.error('RAGServer running on stdio transport')
  }

  /**
   * Stop the server and release resources
   */
  async close(): Promise<void> {
    await this.vectorStore.close()
    console.error('RAGServer stopped')
  }
}
