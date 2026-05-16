// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  type Annotations,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_MIN_CHUNK_LENGTH, SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { buildChunksAndEmbeddings } from '../ingest/compute.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import {
  extractMarkdownTitle,
  extractPdfTitle,
  extractTxtTitle,
} from '../parser/title-extractor.js'
import {
  type ContentFormat,
  extractSourceFromPath,
  generateMetaJsonPath,
  generateRawDataPath,
  isRawDataPath,
  loadMetaJson,
  saveMetaJson,
  saveRawData,
} from '../utils/raw-data-utils.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import { formatErrorMessage } from './error-utils.js'
import { toolDefinitions } from './tool-definitions.js'
import type {
  DeleteFileInput,
  FileEntry,
  IngestDataInput,
  IngestFileInput,
  IngestResult,
  ListFilesResult,
  QueryDocumentsInput,
  QueryResult,
  RAGServerConfig,
  ReadChunkNeighborsInput,
  ReadChunkNeighborsResultItem,
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
  private readonly cacheDir: string
  // Used by handleListFiles filter to exclude system-managed directories
  private readonly excludePaths: string[]
  private readonly configWarnings: string[]
  private readonly minChunkLength: number
  // Read by the visual dispatch branch (added in T4.4) to construct the captioner
  private readonly vlmModelName: string
  private readonly vlmDtype: string
  private queryWarningsShown = false

  constructor(config: RAGServerConfig) {
    this.dbPath = config.dbPath
    this.baseDir = config.baseDir
    this.cacheDir = config.cacheDir
    this.configWarnings = config.configWarnings ?? []
    this.minChunkLength = config.chunkMinLength ?? DEFAULT_MIN_CHUNK_LENGTH
    this.vlmModelName = config.vlmModelName
    this.vlmDtype = config.vlmDtype
    this.excludePaths = [`${resolve(this.dbPath)}${sep}`, `${resolve(this.cacheDir)}${sep}`]
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
    const embedderConfig: ConstructorParameters<typeof Embedder>[0] = {
      modelPath: config.modelName,
      batchSize: 16,
      cacheDir: config.cacheDir,
    }
    if (config.device !== undefined) {
      embedderConfig.device = config.device
    }
    this.embedder = new Embedder(embedderConfig)
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
          case 'read_chunk_neighbors':
            return await this.handleReadChunkNeighbors(
              request.params.arguments as unknown as ReadChunkNeighborsInput
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
    // VLM config snapshot logged once at startup so the configured values are
    // visible in server logs even when the visual dispatch branch (added in
    // T4.4) has not been exercised yet. `vlmDtype === ''` means the captioner
    // will normalize to `DEFAULT_VLM_DTYPE` at the from_pretrained boundary.
    console.error(
      `RAGServer initialized (vlmModelName=${this.vlmModelName}, vlmDtype=${this.vlmDtype || '(default)'})`
    )
  }

  /**
   * query_documents tool handler
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
    args: IngestFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    // Runtime validation (AC-012): the MCP JSON Schema declares `visual` as a
    // boolean, but tool arguments arrive as `unknown` at the SDK boundary so we
    // re-check here. Validation MUST fire BEFORE any parser/chunker/embedder
    // / vectorStore access. Read via a narrow `unknown` cast so this file
    // doesn't widen the `IngestFileInput` interface (Target Files scope).
    const visualArg = (args as unknown as { visual?: unknown }).visual
    if (visualArg !== undefined && typeof visualArg !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, "'visual' must be a boolean if provided")
    }

    let backup: VectorChunk[] | null = null

    try {
      // Parse file (with header/footer filtering for PDFs)
      // For raw-data files (from ingest_data), read directly without validation
      // since the path is internally generated and content is already processed
      const isPdf = args.filePath.toLowerCase().endsWith('.pdf')
      let text: string
      let title: string | null = null
      let chunks: Awaited<ReturnType<typeof buildChunksAndEmbeddings>>['chunks']
      let embeddings: Awaited<ReturnType<typeof buildChunksAndEmbeddings>>['embeddings']
      if (isRawDataPath(args.filePath)) {
        // Raw-data files: skip validation, read directly
        text = await readFile(args.filePath, 'utf-8')
        const meta = await loadMetaJson(args.filePath)
        title = meta?.title ?? null
        console.error(`Read raw-data file: ${args.filePath} (${text.length} characters)`)
        ;({ chunks, embeddings } = await buildChunksAndEmbeddings(
          text,
          title,
          this.chunker,
          this.embedder
        ))
      } else if (visualArg === true && isPdf) {
        // Visual dispatch — mirrors T4.5's CLI-side algorithm, with this
        // handler's persistence semantics (backup/rollback/optimize) preserved
        // below. NFR-1: load `pdf-visual` via dynamic `await import` ONLY when
        // visual mode is requested on a PDF; the default path must never
        // statically reference `pdf-visual` (AC-001).
        const pdfVisual = await import('../pdf-visual/index.js')
        const captioner = pdfVisual.createCaptioner({
          modelName: this.vlmModelName,
          cacheDir: this.cacheDir,
          dtype: this.vlmDtype,
        })

        const { doc, metadataTitle, pages } = await this.parser.parsePdfPages(
          args.filePath,
          this.embedder
        )
        try {
          const candidates = pdfVisual.detectVisualCandidates(
            pages.map((p) => ({ pageNum: p.pageNum, stextJson: p.stextJson }))
          )
          const enrichedPages = await pdfVisual.enrichPagesWithCaptions(
            pages,
            candidates,
            doc,
            captioner
          )
          text = enrichedPages
            .map((p) => p.text)
            .filter((t) => t.length > 0)
            .join('\n\n')

          // Chunk + embed once on the joined visual+text content. Title is
          // derived AFTER chunking from `chunks[0]?.text` (DD §Title resolution).
          ;({ chunks, embeddings } = await buildChunksAndEmbeddings(
            text,
            null,
            this.chunker,
            this.embedder
          ))

          const titleResult = extractPdfTitle(
            metadataTitle,
            chunks[0]?.text,
            basename(args.filePath),
            pages[0]?.page1FontHint
          )
          title = titleResult.title || null
        } finally {
          // Caller owns `doc` per `parsePdfPages` contract (AC-013) — release the
          // mupdf WASM handle on both success and error paths.
          doc.destroy()
        }
      } else if (isPdf) {
        const result = await this.parser.parsePdf(args.filePath, this.embedder)
        text = result.content
        title = result.title || null
        ;({ chunks, embeddings } = await buildChunksAndEmbeddings(
          text,
          title,
          this.chunker,
          this.embedder
        ))
      } else {
        const result = await this.parser.parseFile(args.filePath)
        text = result.content
        title = result.title || null
        ;({ chunks, embeddings } = await buildChunksAndEmbeddings(
          text,
          title,
          this.chunker,
          this.embedder
        ))
      }

      // Fail-fast: Prevent data loss when chunking produces 0 chunks
      // This check must happen BEFORE delete to preserve existing data on re-ingest
      if (chunks.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No chunks generated from file: ${args.filePath}. The file may be empty or all content was filtered (minimum ${this.minChunkLength} characters required). Existing data has been preserved.`
        )
      }

      // Create backup (if existing data exists)
      try {
        const existingFiles = await this.vectorStore.listFiles()
        const existingFile = existingFiles.find((file) => file.filePath === args.filePath)
        if (existingFile && existingFile.chunkCount > 0) {
          // Backup existing data (retrieve via search)
          const queryVector = embeddings[0] || []
          if (queryVector.length > 0) {
            const allChunks = await this.vectorStore.search(queryVector, undefined, 20) // Retrieve max 20 items
            backup = allChunks
              .filter((chunk) => chunk.filePath === args.filePath)
              .map((chunk) => ({
                id: randomUUID(),
                filePath: chunk.filePath,
                chunkIndex: chunk.chunkIndex,
                text: chunk.text,
                vector: queryVector, // Use dummy vector since actual vector cannot be retrieved
                metadata: chunk.metadata,
                fileTitle: chunk.fileTitle ?? null,
                timestamp: new Date().toISOString(),
              }))
          }
          console.error(`Backup created: ${backup?.length || 0} chunks for ${args.filePath}`)
        }
      } catch (error) {
        // Backup creation failure is warning only (for new files)
        console.warn('Failed to create backup (new file?):', error)
      }

      // Delete existing data
      await this.vectorStore.deleteChunks(args.filePath)
      console.error(`Deleted existing chunks for: ${args.filePath}`)

      // Create vector chunks
      const timestamp = new Date().toISOString()
      const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
        const embedding = embeddings[index]
        if (!embedding) {
          throw new Error(`Missing embedding for chunk ${index}`)
        }
        return {
          id: randomUUID(),
          filePath: args.filePath,
          chunkIndex: chunk.index,
          text: chunk.text,
          vector: embedding,
          metadata: {
            fileName: args.filePath.split('/').pop() || args.filePath,
            fileSize: text.length,
            fileType: args.filePath.split('.').pop() || '',
          },
          fileTitle: title || null,
          timestamp,
        }
      })

      // Insert vectors (transaction processing)
      try {
        await this.vectorStore.insertChunks(vectorChunks)
        console.error(`Inserted ${vectorChunks.length} chunks for: ${args.filePath}`)

        // Optimize once after both delete + insert (not per-operation)
        await this.vectorStore.optimize()

        // Delete backup on success
        backup = null
      } catch (insertError) {
        // Rollback on error
        if (backup && backup.length > 0) {
          console.error('Ingestion failed, rolling back...', insertError)
          try {
            await this.vectorStore.insertChunks(backup)
            await this.vectorStore.optimize()
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

      // Result
      const result: IngestResult = {
        filePath: args.filePath,
        chunkCount: chunks.length,
        timestamp,
        fileTitle: title || null,
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
      // Re-throw McpError as-is to preserve error code
      if (error instanceof McpError) {
        console.error('Failed to ingest file:', error.message)
        throw error
      }

      const errorMessage = formatErrorMessage(error)

      console.error('Failed to ingest file:', errorMessage)

      throw new Error(`Failed to ingest file: ${errorMessage}`)
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
    args: IngestDataInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
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
        return await this.handleIngestFile({ filePath: rawDataPath })
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
    await this.server.close()
    await this.vectorStore.close()
    await this.embedder.dispose()
    console.error('RAGServer stopped')
  }
}
