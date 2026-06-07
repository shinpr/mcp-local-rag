// RAGServer implementation with MCP tools

import { readFile, unlink } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
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
import { buildChunksAndEmbeddings, buildVectorChunks } from '../ingest/compute.js'
import { prepareVisualPdfChunks } from '../ingest/visual.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import type { BaseDirsConfigError } from '../utils/base-dirs.js'
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
import { realpathForMatch } from '../utils/scan.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import {
  appendConfigWarnings,
  buildConfigErrorBlock,
  formatErrorMessage,
  type RagContentBlock,
} from './error-utils.js'
import { normalizeBaseDirs, scanBaseDir } from './list-scanner.js'
import { toolDefinitions } from './tool-definitions.js'
import { parseIngestDataInput, parseQueryDocumentsInput } from './tool-input.js'
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
   * One or more allowed document base directories — REALPATH-normalized
   * (the validation/security domain). Passed to `DocumentParser` as the
   * security boundary. NOT used for `list_files` scanning/display; that uses
   * the NORMAL-path `rawBaseDirs` below. Normalized from either the legacy
   * `{ baseDir }` config shape or the new `{ baseDirs }` shape so downstream
   * readers do not need to branch on shape.
   */
  private readonly baseDirs: readonly string[]
  /**
   * Normal-path (resolve()) roots, index-aligned with `baseDirs`, for
   * user-facing `list_files` scan/display. Falls back to `baseDirs` for legacy
   * `{ baseDir }` callers. See {@link BaseDirsConfig} for the path policy.
   */
  private readonly rawBaseDirs: readonly string[]
  /** Legacy single-root accessor for `rawBaseDirs`. Derived from `rawBaseDirs[0]`. */
  private readonly rawBaseDir: string
  private readonly cacheDir: string
  // Used by handleListFiles filter to exclude system-managed directories
  private readonly excludePaths: string[]
  private readonly configWarnings: string[]
  /**
   * Structured base-dirs resolution error. When non-null, the server is in
   * degraded mode: `status` remains callable so the user can diagnose the
   * problem via MCP, while root-dependent tools should surface this error
   * before doing DB or filesystem work. See `resolveBaseDirs` for the error
   * semantics.
   */
  private readonly configError: BaseDirsConfigError | null
  private readonly minChunkLength: number
  private readonly device: string | undefined

  constructor(config: RAGServerConfig) {
    this.dbPath = config.dbPath
    // Normalize both config shapes into a single `baseDirs: string[]` plus the
    // legacy single-root accessor. See `normalizeBaseDirs` for the degraded-
    // mode and misuse semantics.
    const { baseDirs, baseDir } = normalizeBaseDirs(config)
    this.baseDirs = baseDirs
    // Normal-path roots for user-facing scanning; fall back to the realpath'd
    // roots for legacy `{ baseDir }` callers.
    const rawBaseDirs = config.rawBaseDirs !== undefined ? [...config.rawBaseDirs] : [...baseDirs]
    this.rawBaseDirs = rawBaseDirs
    this.rawBaseDir = rawBaseDirs[0] ?? baseDir
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
   * Fail-fast guard for root-dependent tools. When a {@link BaseDirsConfigError}
   * is stored on the instance the server is in degraded mode (invalid
   * `BASE_DIRS` — see `resolveBaseDirs`) and every root-dependent tool MUST
   * reject BEFORE any DB / embedder / parser access so the user sees the
   * configuration problem unambiguously. Surfaces the error as an
   * `McpError(InvalidParams)` so MCP clients render it as a structured tool
   * error.
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
              parseQueryDocumentsInput(request.params.arguments)
            )
          case 'ingest_file':
            return await this.handleIngestFile(
              request.params.arguments as unknown as IngestFileInput
            )
          case 'ingest_data':
            return await this.handleIngestData(parseIngestDataInput(request.params.arguments))
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

      // Append config warnings on every call because MCP clients may hide
      // stderr and may not retain context across calls.
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
    // `args.filePath` is the DB key (backup/delete/insert/result), stored
    // verbatim so lookups match (realpath stays in validateFilePath; see
    // BaseDirsConfig for the path policy).
    // Runtime validation: the MCP JSON Schema declares `visual` as a
    // boolean and `IngestFileInput.visual` types it as `boolean | undefined`,
    // but tool arguments arrive as `unknown` at the SDK boundary so the
    // structural type is not enforced by the compiler. Validation fires
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
        // Visual dispatch delegates to `prepareVisualPdfChunks`, which owns
        // the dynamic `pdf-visual` import so the default path does not load
        // visual dependencies. This handler keeps its backup/rollback/
        // optimize/response-shaping persistence semantics.
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

      // Back up existing chunks BEFORE the destructive delete, with their real
      // stored vectors and the full chunk set, so a failed re-ingest can be
      // rolled back without data loss or vector corruption (TD-7). Read this
      // before deleting; if the read fails it propagates here — leaving the
      // existing data untouched — rather than proceeding into the delete with
      // an empty/partial backup.
      backup = await this.vectorStore.getChunksByFilePath(args.filePath)
      if (backup.length > 0) {
        console.error(`Backup created: ${backup.length} chunks for ${args.filePath}`)
      }

      // Delete existing data
      await this.vectorStore.deleteChunks(args.filePath)
      console.error(`Deleted existing chunks for: ${args.filePath}`)

      // Create vector chunks
      const vectorChunks = buildVectorChunks({
        filePath: args.filePath,
        chunks,
        embeddings,
        fileSize: text.length,
        fileTitle: title || null,
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
        timestamp: new Date().toISOString(),
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
   * list_files tool handler
   *
   * Scans the normal-path roots (`this.rawBaseDirs`) so scanned paths match the
   * resolve()-stored DB keys (see {@link BaseDirsConfig} for the path policy).
   *
   * Scans every effective base directory (`this.rawBaseDirs`) for supported
   * files and cross-references with ingested documents. Multi-root contract:
   * - Returns top-level `baseDirs` (all effective roots in normal-path space,
   *   nested-root-pruned by `resolveBaseDirs`).
   * - Preserves legacy top-level `baseDir = rawBaseDirs[0]` for clients written
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
      // Get all ingested entries and index them by file IDENTITY (realpath), so
      // a file ingested via a different spelling (symlinked prefix or alias)
      // still matches the scan. Storage/display stay normal-path; realpath is
      // used here only for the "same file?" comparison (see BaseDirsConfig).
      const ingested = await this.vectorStore.listFiles()
      const ingestedKeyed = await Promise.all(
        ingested.map(async (f) => ({ entry: f, key: await realpathForMatch(f.filePath) }))
      )
      const ingestedByKey = new Map(ingestedKeyed.map(({ entry, key }) => [key, entry]))

      // Scan each effective root (normal-path `rawBaseDirs`), dedup by identity
      // key (a file reachable from multiple roots appears once, first root wins),
      // and cross-reference by that key. Per-root scan warnings are surfaced via
      // `withWarnings` below.
      const files: FileEntry[] = []
      const seenKeys = new Set<string>()
      const matchedKeys = new Set<string>()
      const scanWarnings: string[] = []
      for (const baseDir of this.rawBaseDirs) {
        const { files: scanned, warnings: rootWarnings } = await scanBaseDir(
          baseDir,
          this.excludePaths
        )
        for (const w of rootWarnings) {
          scanWarnings.push(`[${baseDir}] ${w}`)
        }
        for (const scannedPath of scanned) {
          const key = await realpathForMatch(scannedPath)
          if (seenKeys.has(key)) continue
          seenKeys.add(key)
          const entry = ingestedByKey.get(key)
          // Ingested rows display the stored (normal) path so it round-trips
          // into delete/read; not-ingested rows display the scanned path.
          files.push(
            entry
              ? {
                  filePath: entry.filePath,
                  baseDir,
                  ingested: true,
                  chunkCount: entry.chunkCount,
                  timestamp: entry.timestamp,
                }
              : { filePath: scannedPath, baseDir, ingested: false }
          )
          if (entry) matchedKeys.add(key)
        }
      }

      // Content ingested via ingest_data plus orphaned DB entries: ingested
      // entries whose identity key matched no scanned file.
      const sources: SourceEntry[] = ingestedKeyed
        .filter(({ key }) => !matchedKeys.has(key))
        .map(({ entry: f }) => {
          if (looksLikeRawDataPath(f.filePath)) {
            const source = extractSourceFromPath(f.filePath)
            if (source) return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
          }
          return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
        })

      const result: ListFilesResult = {
        baseDir: this.rawBaseDir,
        baseDirs: [...this.rawBaseDirs],
        files,
        sources,
      }
      // Build the response with the primary JSON block first, then any
      // per-root scan warnings as additional text blocks so
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
   * status tool handler
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
        // DB key = the verbatim resolve()-stored path; look up as-is (realpath
        // stays in validateFilePath; see BaseDirsConfig for the path policy).
        targetPath = args.filePath
      } else {
        // Missing required input is a client error → InvalidParams (matches
        // read_chunk_neighbors); a plain Error would surface as InternalError.
        throw new McpError(ErrorCode.InvalidParams, 'Either filePath or source must be provided')
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
      // Validate everything before DB access. This handler intentionally uses
      // structured InvalidParams errors for input validation.
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
        // DB key = the verbatim resolve()-stored path; look up as-is (realpath
        // stays in validateFilePath; see BaseDirsConfig for the path policy).
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
