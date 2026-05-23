// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_MIN_CHUNK_LENGTH, SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { buildChunksAndEmbeddings } from '../ingest/compute.js'
import { prepareVisualPdfChunks } from '../ingest/visual.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import { type BaseDirsConfigError, displayPath } from '../utils/base-dirs.js'
import {
  type ContentFormat,
  extractSourceFromPath,
  generateMetaJsonPath,
  generateRawDataPath,
  isPathInRawDataDir,
  isPathInRawDataDirLexical,
  loadMetaJson,
  looksLikeRawDataPath,
  saveMetaJson,
  saveRawData,
} from '../utils/raw-data-utils.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import {
  appendConfigWarnings,
  buildConfigErrorBlock,
  formatErrorMessage,
  type RagContentBlock,
} from './error-utils.js'
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
  /**
   * One or more allowed document base directories. The single source of
   * truth for both the security boundary (passed to `DocumentParser`) and
   * for scan iteration in `list_files` (P3-T2). Normalized from either the
   * legacy `{ baseDir }` config shape or the new `{ baseDirs }` shape so
   * downstream readers do not need to branch on shape.
   */
  private readonly baseDirs: readonly string[]
  /**
   * Legacy single-root accessor. Derived from `baseDirs[0]`. Preserved so
   * the legacy `ListFilesResult.baseDir` field and any direct readers of
   * `this.baseDir` continue to work; multi-root iteration uses `baseDirs`.
   */
  private readonly baseDir: string
  private readonly cacheDir: string
  // Used by handleListFiles filter to exclude system-managed directories
  private readonly excludePaths: string[]
  private readonly configWarnings: string[]
  /**
   * Structured base-dirs resolution error. When non-null, the server is in
   * degraded mode: `status` remains callable so the user can diagnose the
   * problem via MCP, while root-dependent tools should surface this error
   * (wired in P3-T3). See `resolveBaseDirs` for the error semantics.
   */
  private readonly configError: BaseDirsConfigError | null
  private readonly minChunkLength: number
  private readonly device: string | undefined

  constructor(config: RAGServerConfig) {
    this.dbPath = config.dbPath
    // Normalize both config shapes into a single `baseDirs: string[]`.
    // Exactly one of `baseDir` / `baseDirs` is supplied (enforced by the
    // discriminated union in `RAGServerConfig`); the runtime check below
    // catches misuse from JS-only callers and degraded-mode bugs.
    const normalizedBaseDirs =
      config.baseDirs !== undefined ? [...config.baseDirs] : [config.baseDir]
    const firstBaseDir = normalizedBaseDirs[0]
    // Empty `baseDirs` is accepted ONLY in degraded mode (configError set).
    // In that case the server stays constructible so `status` remains
    // callable, but every root-dependent tool fails fast via
    // `assertConfigOk` before any baseDirs-dependent work. Without
    // configError, an empty array is a misuse: reject up front rather than
    // build a parser that silently rejects every path.
    if (firstBaseDir === undefined && config.configError === undefined) {
      throw new Error(
        'RAGServerConfig must provide either `baseDir` or a non-empty `baseDirs` array (empty `baseDirs` is allowed only in degraded mode with `configError` set).'
      )
    }
    this.baseDirs = normalizedBaseDirs
    // Legacy single-root accessor — empty-string when in degraded mode with
    // an empty `baseDirs` array. `baseDir` is never consulted in degraded
    // mode because `assertConfigOk` fires before any handler reaches it.
    this.baseDir = firstBaseDir ?? ''
    this.cacheDir = config.cacheDir
    this.configWarnings = config.configWarnings ?? []
    this.configError = config.configError ?? null
    this.minChunkLength = config.chunkMinLength ?? DEFAULT_MIN_CHUNK_LENGTH
    this.device = config.device
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
    // Always construct the parser with the multi-root shape — the parser
    // accepts a single-element `baseDirs` array as the byte-equivalent of
    // the legacy `baseDir` shape, so passing `this.baseDirs` covers both
    // config inputs without branching here.
    this.parser = new DocumentParser({
      baseDirs: this.baseDirs,
      maxFileSize: config.maxFileSize,
    })

    this.setupHandlers()
  }

  /**
   * Expose the base-dirs resolution error (if any) for the warning/error
   * attachment layer added in P3-T3. Returns `null` when configuration
   * resolved cleanly. Kept as a method so the field stays `private readonly`
   * — only the handler layer that wires error responses needs read access.
   */
  getConfigError(): BaseDirsConfigError | null {
    return this.configError
  }

  /**
   * Fail-fast guard for root-dependent tools. When a {@link BaseDirsConfigError}
   * is stored on the instance the server is in degraded mode (invalid
   * `BASE_DIRS` — see `resolveBaseDirs`) and every root-dependent tool MUST
   * reject BEFORE any DB / embedder / parser access so the user sees the
   * configuration problem unambiguously. Surfaces the error as an
   * `McpError(InvalidParams)` so MCP clients render it as a structured tool
   * error (per AC-009).
   *
   * `status` deliberately does NOT call this helper; it remains callable in
   * degraded mode and exposes the error via a diagnostic content block so
   * the user can recover via MCP without inspecting stderr.
   */
  private assertConfigOk(): void {
    if (this.configError !== null) {
      throw new McpError(ErrorCode.InvalidParams, this.configError.message)
    }
  }

  /**
   * Append the centralized config-warning blocks to a handler response.
   * Every tool handler funnels through this method so the warning shape
   * stays in exactly one place (design-doc-mandated countermeasure for the
   * "warning shape changes touch many handlers" risk).
   */
  private withWarnings(content: RagContentBlock[]): RagContentBlock[] {
    return appendConfigWarnings(content, this.configWarnings)
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
    console.error('RAGServer initialized')
  }

  /**
   * query_documents tool handler
   */
  async handleQueryDocuments(args: QueryDocumentsInput): Promise<{ content: RagContentBlock[] }> {
    // query_documents operates over the LanceDB only (no baseDirs access), so
    // it stays callable in degraded mode (configError present). The warning
    // and error blocks attached via `withWarnings` / status remain the user-
    // visible diagnostic surface for the config problem.
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

        if (looksLikeRawDataPath(result.filePath)) {
          const source = extractSourceFromPath(result.filePath)
          if (source) {
            queryResult.source = source
          }
        }

        return queryResult
      })

      const content: RagContentBlock[] = [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ]

      // Append config warnings on every call. AC-009 requires visibility on
      // every tool response because MCP clients may hide stderr and may not
      // retain context across calls.
      return { content: this.withWarnings(content) }
    } catch (error) {
      console.error('Failed to query documents:', error)
      throw error
    }
  }

  /**
   * ingest_file tool handler (re-ingestion support, transaction processing, rollback capability)
   */
  async handleIngestFile(args: IngestFileInput): Promise<{ content: RagContentBlock[] }> {
    // Skip the configError gate only for paths structurally inside
    // `<dbPath>/raw-data/` (internal invocation from handleIngestData).
    if (!(await isPathInRawDataDir(args.filePath, this.dbPath))) {
      this.assertConfigOk()
    }
    // Runtime validation (AC-012): the MCP JSON Schema declares `visual` as a
    // boolean and `IngestFileInput.visual` types it as `boolean | undefined`,
    // but tool arguments arrive as `unknown` at the SDK boundary so the
    // structural type is not enforced by the compiler. Validation MUST fire
    // BEFORE any parser/chunker/embedder/vectorStore access.
    const visualArg: unknown = args.visual
    if (visualArg !== undefined && typeof visualArg !== 'boolean') {
      throw new McpError(ErrorCode.InvalidParams, "'visual' must be a boolean if provided")
    }

    // Runtime validation + normalization of `visualQuality`. The MCP boundary
    // receives `unknown`, so the JSON Schema enum is necessary but not
    // sufficient. Some MCP clients send `""` for unspecified optional
    // parameters; accept both `undefined` and `""` and normalize to `'fast'`
    // so the internal `QualityProfile` type stays narrow.
    const visualQualityArg: unknown = (args as { visualQuality?: unknown }).visualQuality
    let visualQuality: 'fast' | 'quality' = 'fast'
    if (visualQualityArg !== undefined && visualQualityArg !== '') {
      if (visualQualityArg !== 'fast' && visualQualityArg !== 'quality') {
        throw new McpError(
          ErrorCode.InvalidParams,
          "'visualQuality' must be 'fast' or 'quality' if provided"
        )
      }
      visualQuality = visualQualityArg
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
      if (await isPathInRawDataDir(args.filePath, this.dbPath)) {
        // Raw-data files: skip parser validation, read directly.
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
        // Visual dispatch — delegates to the shared `prepareVisualPdfChunks`
        // helper (NFR-1: the `pdf-visual` dynamic import lives inside that
        // helper, not here, so the default path's Proxy sentinel — AC-001 —
        // still observes `pdf-visual` untouched). This handler keeps its
        // backup/rollback/optimize/response-shaping persistence semantics
        // (preserved below).
        const visualResult = await prepareVisualPdfChunks(
          args.filePath,
          this.parser,
          this.chunker,
          this.embedder,
          {
            profile: visualQuality,
            cacheDir: this.cacheDir,
            device: this.device,
          }
        )
        chunks = visualResult.chunks
        embeddings = visualResult.embeddings
        text = visualResult.text
        title = visualResult.title
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
            fileName: basename(args.filePath),
            fileSize: text.length,
            fileType: extname(args.filePath).slice(1),
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
        content: this.withWarnings([
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ]),
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
  async handleIngestData(args: IngestDataInput): Promise<{ content: RagContentBlock[] }> {
    // ingest_data writes only to `dbPath`/raw-data — it never reads from a
    // configured `baseDir`. Keeping it callable in degraded mode means a user
    // with invalid BASE_DIRS can still capture raw-data via MCP while they
    // diagnose the config error from `status`. The internal `handleIngestFile`
    // call below operates on a generated raw-data path, which routes
    // around `parser.validateFilePath`, so no baseDirs access happens.
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
   * Bounded BFS scan of a single base directory for supported files,
   * excluding system-managed paths (dbPath, cacheDir). Returns sorted
   * absolute paths plus a list of non-fatal warnings (Finding #10).
   *
   * Behavior contract:
   *  - Depth is bounded by {@link RAGServer.LIST_MAX_DEPTH}, mirroring the
   *    CLI ingest walker so the same "how deep do we look under a root"
   *    boundary applies to every list/ingest surface.
   *  - A `readdir` failure under one directory is captured as a warning
   *    rather than aborting the whole list call. Pre-Finding-#10 behavior
   *    propagated the error, which meant one unreadable root could hide
   *    files under the other roots — the multi-root contract makes this
   *    asymmetry user-visible, so the policy is now best-effort per root.
   *  - Symlinks are skipped (mirrors the CLI ingest walker).
   */
  private async scanBaseDir(baseDir: string): Promise<{ files: string[]; warnings: string[] }> {
    const files: string[] = []
    const warnings: string[] = []
    let depthLimited = false

    const queue: { dirPath: string; depth: number }[] = [{ dirPath: baseDir, depth: 0 }]

    while (queue.length > 0) {
      const { dirPath, depth } = queue.shift()!

      if (depth >= RAGServer.LIST_MAX_DEPTH) {
        depthLimited = true
        continue
      }

      // TypeScript's `readdir` has overloads keyed on the options shape;
      // pin the encoding to `'utf8'` and cast so the loop body operates on
      // string-encoded Dirent entries (matches the rest of the codebase).
      let entries: import('node:fs').Dirent<string>[]
      try {
        entries = (await readdir(dirPath, {
          withFileTypes: true,
          encoding: 'utf8',
        })) as import('node:fs').Dirent<string>[]
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? ((error as NodeJS.ErrnoException).code ?? 'UNKNOWN')
            : 'UNKNOWN'
        warnings.push(`cannot read directory: ${displayPath(dirPath)} (${code})`)
        continue
      }

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)
        if (entry.isSymbolicLink()) continue
        if (this.excludePaths.some((ep) => fullPath.startsWith(ep))) continue
        if (entry.isDirectory()) {
          queue.push({ dirPath: fullPath, depth: depth + 1 })
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(fullPath)
        }
      }
    }

    if (depthLimited) {
      warnings.push(
        `some directories under ${displayPath(baseDir)} were skipped because they exceed the maximum depth (${RAGServer.LIST_MAX_DEPTH})`
      )
    }

    files.sort()
    return { files, warnings }
  }

  /**
   * Maximum directory recursion depth for `list_files` scans. Mirrors the
   * CLI ingest walker's `MAX_DEPTH` so the same boundary applies across
   * every list/ingest surface.
   */
  private static readonly LIST_MAX_DEPTH = 10

  /**
   * list_files tool handler
   *
   * Scans every effective base directory (`this.baseDirs`) for supported
   * files and cross-references with ingested documents. Multi-root contract
   * (P3-T2, AC-008):
   * - Returns top-level `baseDirs` (all effective roots, already realpath-
   *   normalized and nested-root-pruned by `resolveBaseDirs`).
   * - Preserves legacy top-level `baseDir = baseDirs[0]` for clients written
   *   against the single-root shape.
   * - Annotates each file entry with the producing `baseDir`.
   * - De-duplicates exact duplicate file paths across roots (first occurrence
   *   wins, preserving root iteration order).
   * - Preserves raw-data / orphaned DB entries under `sources` with no
   *   producing-root annotation.
   * - Excludes `dbPath` and `cacheDir` uniformly across every root.
   */
  async handleListFiles(): Promise<{ content: RagContentBlock[] }> {
    // Root-dependent tool: fail fast on configError BEFORE any DB / FS access.
    this.assertConfigOk()
    try {
      // Get all ingested entries from the vector store
      const ingested = await this.vectorStore.listFiles()
      const ingestedMap = new Map(ingested.map((f) => [f.filePath, f]))

      // Iterate every effective root and collect entries with their producing
      // root. Deduplicate exact duplicate file paths across roots; the first
      // occurrence wins so iteration order in `this.baseDirs` determines the
      // recorded producing root for files reachable from multiple roots.
      // Per-root scan warnings (Finding #10) are aggregated and surfaced
      // alongside the primary content block via `withWarnings` below.
      const files: FileEntry[] = []
      const seenPaths = new Set<string>()
      const scanWarnings: string[] = []
      for (const baseDir of this.baseDirs) {
        const { files: scanned, warnings: rootWarnings } = await this.scanBaseDir(baseDir)
        for (const w of rootWarnings) {
          scanWarnings.push(`[${baseDir}] ${w}`)
        }
        for (const filePath of scanned) {
          if (seenPaths.has(filePath)) continue
          seenPaths.add(filePath)
          const entry = ingestedMap.get(filePath)
          files.push(
            entry
              ? {
                  filePath,
                  baseDir,
                  ingested: true,
                  chunkCount: entry.chunkCount,
                  timestamp: entry.timestamp,
                }
              : { filePath, baseDir, ingested: false }
          )
        }
      }

      // Content ingested via ingest_data (web pages, clipboard, etc.) plus any
      // orphaned DB entries whose files no longer exist on disk. `seenPaths`
      // is the union across every scanned root, so a DB entry is only a
      // source when it is not reachable from any effective root.
      const sources: SourceEntry[] = ingested
        .filter((f) => !seenPaths.has(f.filePath))
        .map((f) => {
          if (looksLikeRawDataPath(f.filePath)) {
            const source = extractSourceFromPath(f.filePath)
            if (source) return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
          }
          return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
        })

      const result: ListFilesResult = {
        baseDir: this.baseDir,
        baseDirs: [...this.baseDirs],
        files,
        sources,
      }
      // Build the response with the primary JSON block first, then any
      // per-root scan warnings (Finding #10) as additional text blocks so
      // clients see the warnings alongside the file list without needing
      // to inspect stderr. Config-level warnings (`configWarnings`) are
      // still appended via `withWarnings`.
      const content: RagContentBlock[] = [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      for (const w of scanWarnings) {
        content.push({ type: 'text', text: `Warning: ${w}` })
      }
      return { content: this.withWarnings(content) }
    } catch (error) {
      console.error('Failed to list files:', error)
      throw error
    }
  }

  /**
   * status tool handler (Phase 1: basic implementation)
   */
  async handleStatus(): Promise<{ content: RagContentBlock[] }> {
    // `status` remains callable in degraded mode (configError set) so the
    // user can diagnose the root configuration via MCP without inspecting
    // stderr. Do NOT call `assertConfigOk` here.
    try {
      const status = await this.vectorStore.getStatus()
      const content: RagContentBlock[] = [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ]

      // Surface the configError as a diagnostic content block when present.
      // Placed BEFORE warning blocks so it appears with the primary status
      // payload at a higher priority annotation.
      if (this.configError !== null) {
        content.push(buildConfigErrorBlock(this.configError.message))
      }

      return { content: this.withWarnings(content) }
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
  async handleDeleteFile(args: DeleteFileInput): Promise<{ content: RagContentBlock[] }> {
    try {
      let targetPath: string
      let skipValidation = false

      if (args.source) {
        // Generate raw-data path from source (extension is always .md)
        // Internal path generation is secure, skip baseDir validation.
        // The `source` branch never touches `baseDirs`, so it stays callable
        // in degraded mode (configError present).
        targetPath = generateRawDataPath(this.dbPath, args.source, 'markdown')
        skipValidation = true
      } else if (args.filePath) {
        // Root-dependent branch: a user-supplied filePath is validated against
        // the configured roots, so we must fail fast when the config is
        // invalid. Placed AFTER the `source` branch so source-mode requests
        // continue to work in degraded mode.
        this.assertConfigOk()
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

      // Also delete physical raw-data file if applicable.
      if (isPathInRawDataDirLexical(targetPath, this.dbPath)) {
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
        content: this.withWarnings([
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ]),
      }
    } catch (error) {
      // Re-throw McpError as-is so structured tool errors (e.g. from
      // `assertConfigOk` in the filePath branch) preserve their code at the
      // MCP boundary instead of being wrapped in a generic Error.
      if (error instanceof McpError) {
        console.error('Failed to delete file:', error.message)
        throw error
      }
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
  ): Promise<{ content: RagContentBlock[] }> {
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
      //
      // configError gating happens AFTER the input-shape validation but BEFORE
      // any parser/DB access on the user-supplied filePath. The `source` branch
      // never touches `baseDirs`, so it stays callable in degraded mode; the
      // `filePath` branch must fail fast because `parser.validateFilePath`
      // depends on the configured roots being valid.
      let targetPath: string
      let skipValidation = false
      if (hasSource) {
        targetPath = generateRawDataPath(this.dbPath, args.source as string, 'markdown')
        skipValidation = true
      } else {
        // XOR + hasSource === false guarantees filePath is a non-empty string here.
        this.assertConfigOk()
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
      const isRaw = looksLikeRawDataPath(targetPath)
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
        content: this.withWarnings([
          {
            type: 'text',
            text: JSON.stringify(items, null, 2),
          },
        ]),
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
