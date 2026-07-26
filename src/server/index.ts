// RAGServer implementation with MCP tools

import { readFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
import { listDocuments } from '../features/list.js'
import {
  buildChunksAndEmbeddings,
  buildVectorChunks,
  computeContentHash,
} from '../ingest/compute.js'
import { prepareVisualPdfChunks } from '../ingest/visual.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import type { BaseDirsConfigError } from '../utils/base-dirs.js'
import {
  checkRawDataArtifacts,
  extractSourceFromPath,
  generateMetaJsonPath,
  generateRawDataPath,
  isEnoent,
  isManagedRawDataPath,
  isPathInRawDataDir,
  isPathInRawDataDirLexical,
  loadMetaJson,
  saveMetaJson,
  saveRawData,
} from '../utils/raw-data-utils.js'
import { nonAbsolutePrefixes } from '../utils/scope-match.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import {
  appendConfigWarnings,
  buildConfigErrorBlock,
  logError,
  type RagContentBlock,
  type ToMcpErrorContext,
  toMcpError,
} from './error-utils.js'
import { normalizeBaseDirs, scanBaseDir } from './list-scanner.js'
import { toolDefinitions } from './tool-definitions.js'
import {
  parseDeleteFileInput,
  parseIngestDataInput,
  parseIngestFileInput,
  parseListFilesInput,
  parseQueryDocumentsInput,
  parseReadChunkNeighborsInput,
} from './tool-input.js'
import type {
  DeleteFileResult,
  FileEntry,
  IngestDataInput,
  IngestResult,
  ListFilesInput,
  ListFilesResult,
  QueryDocumentsInput,
  QueryResult,
  RAGServerConfig,
  ReadChunkNeighborsResultItem,
  SourceEntry,
} from './types.js'

/**
 * Per-tool client-message policy consumed by the central dispatcher mapper
 * (`toMcpError(error, context)`). The `prefix`, when present, is prepended to
 * the controlled client message ONLY for native / non-`AppError` failures; a
 * recognized `AppError` (e.g. `DatabaseError`, `EmbeddingError`) always keeps
 * its own raw message regardless of the prefix (see `toMcpError`). This table
 * is the single source of truth for the Contract-Delta per-handler policy:
 * - `ingest_file` / `ingest_data` / `delete_file` / `read_chunk_neighbors`
 *   prepend an operation prefix on native errors.
 * - `query_documents` / `list_files` / `status` are prefix-less.
 */
const TOOL_ERROR_CONTEXT: Record<string, ToMcpErrorContext> = {
  ingest_file: { prefix: 'Failed to ingest file' },
  ingest_data: { prefix: 'Failed to ingest data' },
  delete_file: { prefix: 'Failed to delete file' },
  read_chunk_neighbors: { prefix: 'Failed to read chunk neighbors' },
  query_documents: {},
  list_files: {},
  status: {},
}

const packageVersion = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version

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
      { name: 'rag-mcp-server', version: packageVersion },
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
    if (config.dtype !== undefined) {
      embedderConfig.dtype = config.dtype
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
   * configuration problem unambiguously. Throws the stored
   * {@link BaseDirsConfigError} (kind `config`) so the central dispatcher
   * mapper renders it as `McpError(InvalidParams)` — error→code ownership
   * stays in exactly one place instead of being hand-built here.
   *
   * `status` deliberately does NOT call this helper; it remains callable in
   * degraded mode and exposes the error via a diagnostic content block so
   * the user can recover via MCP without inspecting stderr.
   */
  private assertConfigOk(): void {
    if (this.configError !== null) {
      throw this.configError
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

    // Tool invocation. The handlers are gutted of error mapping — every error
    // they throw (with its ORIGINAL identity) is routed through the single
    // central catch below, which logs the full cause chain to stderr and maps
    // the error to an `McpError` for the client via `toMcpError(error,
    // context)`. The per-tool `context` (see `TOOL_ERROR_CONTEXT`) encodes each
    // handler's client-message prefix policy so the Contract-Delta per-handler
    // table is preserved in exactly one place.
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: { params: { name: string; arguments?: unknown } }) => {
        const toolName = request.params.name
        try {
          switch (toolName) {
            case 'query_documents':
              return await this.handleQueryDocuments(
                parseQueryDocumentsInput(request.params.arguments)
              )
            case 'ingest_file':
              return await this.handleIngestFile(request.params.arguments)
            case 'ingest_data':
              return await this.handleIngestData(parseIngestDataInput(request.params.arguments))
            case 'delete_file':
              return await this.handleDeleteFile(request.params.arguments)
            case 'read_chunk_neighbors':
              return await this.handleReadChunkNeighbors(request.params.arguments)
            case 'list_files':
              return await this.handleListFiles(parseListFilesInput(request.params.arguments))
            case 'status':
              return await this.handleStatus()
            default:
              throw new Error(`Unknown tool: ${toolName}`)
          }
        } catch (error) {
          const context = TOOL_ERROR_CONTEXT[toolName] ?? {}
          logError(toolName, error)
          throw toMcpError(error, context)
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
    //
    // No local catch: any failure propagates with original identity to the
    // central dispatcher mapper (prefix-less context for this tool).
    // Generate query embedding
    const queryVector = await this.embedder.embed(args.query)

    // `args.scope` is parser-validated; array-wrap without re-validating, and
    // omit the key when absent (exactOptionalPropertyTypes) to keep the scope-absent path.
    const searchResults = await this.vectorStore.search(queryVector, {
      queryText: args.query,
      limit: args.limit ?? 10,
      ...(args.scope !== undefined
        ? { scope: Array.isArray(args.scope) ? args.scope : [args.scope] }
        : {}),
    })

    // Format results with source restoration for raw-data files
    const results: QueryResult[] = searchResults.map((result) => {
      const queryResult: QueryResult = {
        filePath: result.filePath,
        chunkIndex: result.chunkIndex,
        text: result.text,
        score: result.score,
        fileTitle: result.fileTitle ?? null,
      }

      if (isManagedRawDataPath(result.filePath, this.dbPath)) {
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
  }

  /**
   * ingest_file tool handler (re-ingestion support, transaction processing, rollback capability)
   */
  async handleIngestFile(raw: unknown): Promise<{ content: RagContentBlock[] }> {
    const args = parseIngestFileInput(raw)
    // Skip the configError gate only for paths structurally inside
    // `<dbPath>/raw-data/` (internal invocation from handleIngestData).
    if (!(await isPathInRawDataDir(args.filePath, this.dbPath))) {
      this.assertConfigOk()
    }
    // `args.filePath` is the DB key (backup/delete/insert/result), stored
    // verbatim so lookups match (realpath stays in validateFilePath; see
    // BaseDirsConfig for the path policy).
    const visualArg = args.visual
    const visualQuality = args.visualQuality ?? 'fast'

    let backup: VectorChunk[] | null = null

    // No outer error-mapping catch: failures propagate with original identity
    // to the central dispatcher mapper. The inner insert/rollback try/catch
    // below is retained — it is local-effect (data rollback) only.
    // Parse file (with header/footer filtering for PDFs)
    // For raw-data files (from ingest_data), read directly without validation
    // since the path is internally generated and content is already processed
    const isPdf = args.filePath.toLowerCase().endsWith('.pdf')
    let text: string
    let title: string | null = null
    let chunks: Awaited<ReturnType<typeof buildChunksAndEmbeddings>>['chunks']
    let embeddings: Awaited<ReturnType<typeof buildChunksAndEmbeddings>>['embeddings']
    // Set only by the raw-data branch, which already reads the whole file, so
    // the contentHash below costs no second read there.
    let sourceBytes: Buffer | undefined
    if (await isPathInRawDataDir(args.filePath, this.dbPath)) {
      // Raw-data files: skip parser validation, read directly.
      sourceBytes = await readFile(args.filePath)
      text = sourceBytes.toString('utf-8')
      const meta = await loadMetaJson(args.filePath)
      title = meta?.title ?? null
      console.error(`Read raw-data file: ${args.filePath} (${text.length} characters)`)
      ;({ chunks, embeddings } = await buildChunksAndEmbeddings(text, this.chunker, this.embedder))
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
      ;({ chunks, embeddings } = await buildChunksAndEmbeddings(text, this.chunker, this.embedder))
    } else {
      const result = await this.parser.parseFile(args.filePath)
      text = result.content
      title = result.title || null
      ;({ chunks, embeddings } = await buildChunksAndEmbeddings(text, this.chunker, this.embedder))
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

    // Create vector chunks BEFORE the destructive delete, so a construction
    // failure (e.g. a missing embedding) cannot leave the file with no rows.
    // The hash covers the raw file bytes, not the decoded text; parser branches
    // read them here, after the parser's size limit has been enforced.
    const vectorChunks = buildVectorChunks({
      filePath: args.filePath,
      chunks,
      embeddings,
      fileSize: text.length,
      fileTitle: title || null,
      contentHash: computeContentHash(sourceBytes ?? (await readFile(args.filePath))),
    })

    // Delete existing data
    await this.vectorStore.deleteChunks(args.filePath)
    console.error(`Deleted existing chunks for: ${args.filePath}`)

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
          // Rollback also failed: throw a distinct error (cause = insertError)
          // so the client learns the prior data may be lost, not just that the insert failed.
          console.error('Rollback failed:', rollbackError)
          throw new DatabaseError(
            `Ingest failed and rollback failed for ${args.filePath}; existing data may not have been restored. Original insert error: ${(insertError as Error).message}`,
            insertError as Error
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
    //
    // No outer error-mapping catch: failures propagate with original identity
    // to the central dispatcher mapper. The inner raw-data rollback try/catch
    // below is retained — it is local-effect (file cleanup) only.
    let contentToSave = args.content
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
    const rawDataPath = await saveRawData(this.dbPath, args.metadata.source, contentToSave)

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
  async handleListFiles(input: ListFilesInput = {}): Promise<{ content: RagContentBlock[] }> {
    // Root-dependent tool: fail fast on configError BEFORE any DB / FS access.
    // `assertConfigOk` throws `BaseDirsConfigError` (mapped to InvalidParams by
    // the central dispatcher); no local error-mapping catch here.
    this.assertConfigOk()
    // `input.scope` is parser-normalized to `string[]`, but the shared input
    // type admits `string | string[]`; array-wrap once (mirrors query_documents)
    // so scope threads uniformly into the walker and the sources classifier.
    // Undefined scope leaves both the scan and the sources split unchanged.
    const scope =
      input.scope === undefined
        ? undefined
        : Array.isArray(input.scope)
          ? input.scope
          : [input.scope]
    const ingested = await this.vectorStore.listFiles()
    const listed = await listDocuments({
      roots: this.rawBaseDirs,
      dbPath: this.dbPath,
      ingested,
      scope,
      scan: (baseDir, scanScope) => scanBaseDir(baseDir, this.excludePaths, scanScope),
    })
    const files: FileEntry[] = listed.files
    const sources: SourceEntry[] = listed.sources

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
    for (const warning of listed.warnings) {
      content.push({
        type: 'text',
        text: `Warning: [${warning.baseDir}] ${warning.message}`,
      })
    }
    // A non-absolute scope prefix matches nothing (the scan is absolute-path
    // based) but yields no result-level signal, so surface it as a non-fatal
    // warning block. Result semantics are unchanged — the prefix still matches
    // nothing; this only makes the silent miss visible to the client.
    if (scope !== undefined) {
      for (const prefix of nonAbsolutePrefixes(scope)) {
        content.push({
          type: 'text',
          text: `Warning: scope prefix "${prefix}" is not absolute; it matches nothing.`,
        })
      }
    }
    return { content: this.withWarnings(content) }
  }

  /**
   * status tool handler
   */
  async handleStatus(): Promise<{ content: RagContentBlock[] }> {
    // `status` remains callable in degraded mode (configError set) so the
    // user can diagnose the root configuration via MCP without inspecting
    // stderr. Do NOT call `assertConfigOk` here — status surfaces the config
    // error as a diagnostic content block instead of throwing. No local
    // error-mapping catch: genuine DB failures propagate (prefix-less) to the
    // central dispatcher mapper.
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
  }

  /**
   * delete_file tool handler
   * Deletes chunks from VectorDB and physical raw-data files
   * Supports both filePath (for ingest_file) and source (for ingest_data)
   */
  async handleDeleteFile(raw: unknown): Promise<{ content: RagContentBlock[] }> {
    const args = parseDeleteFileInput(raw)
    // No outer error-mapping catch: the inline `McpError(InvalidParams)` and
    // `assertConfigOk` throw propagate with original identity to the central
    // dispatcher mapper. The inner unlink try/catch blocks below are
    // local-effect (best-effort file cleanup) and are retained.
    let targetPath: string
    let skipValidation = false

    if ('source' in args) {
      // Generate raw-data path from source (extension is always .md)
      // Internal path generation is secure, skip baseDir validation.
      // The `source` branch never touches `baseDirs`, so it stays callable
      // in degraded mode (configError present).
      targetPath = generateRawDataPath(this.dbPath, args.source)
      skipValidation = true
    } else {
      // Root-dependent branch: a user-supplied filePath is validated against
      // the configured roots, so we must fail fast when the config is
      // invalid. Placed AFTER the `source` branch so source-mode requests
      // continue to work in degraded mode.
      this.assertConfigOk()
      // DB key = the verbatim resolve()-stored path; look up as-is (realpath
      // stays in validateFilePath; see BaseDirsConfig for the path policy).
      targetPath = args.filePath
    }

    // Only validate user-provided filePath (not internally generated paths)
    if (!skipValidation) {
      await this.parser.validateFilePath(targetPath)
    }

    // Delete chunks from vector database
    const removedChunks = await this.vectorStore.deleteChunks(targetPath)
    // Optimize immediately after the DB delete: a later raw-data unlink failure
    // must not skip compaction once the rows are already gone.
    await this.vectorStore.optimize()

    let rawDataExisted = false
    let metaExisted = false

    // Also delete physical raw-data file if applicable.
    if (isPathInRawDataDirLexical(targetPath, this.dbPath)) {
      // Pre-unlink existence (shared with the CLI delete path).
      const artifacts = await checkRawDataArtifacts(targetPath)
      rawDataExisted = artifacts.rawDataExisted
      metaExisted = artifacts.metaExisted

      try {
        await unlink(targetPath)
        console.error(`Deleted raw-data file: ${targetPath}`)
      } catch (error: unknown) {
        if (!isEnoent(error)) {
          throw error
        }
        console.warn(`Could not delete raw-data file (may not exist): ${targetPath}`)
      }
      try {
        await unlink(generateMetaJsonPath(targetPath))
        console.error(`Deleted meta.json: ${generateMetaJsonPath(targetPath)}`)
      } catch (error: unknown) {
        if (!isEnoent(error)) {
          throw error
        }
      }
    }

    const result: DeleteFileResult = {
      filePath: targetPath,
      deleted: true,
      removedChunks,
      existed: removedChunks > 0 || rawDataExisted || metaExisted,
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
  }

  /**
   * read_chunk_neighbors tool handler
   * Returns chunks around a target chunkIndex within a single ingested document.
   * Context-expansion utility — not a search tool. Mirrors handleDeleteFile's
   * dual-input (filePath XOR source) resolution pattern.
   */
  async handleReadChunkNeighbors(raw: unknown): Promise<{ content: RagContentBlock[] }> {
    const args = parseReadChunkNeighborsInput(raw)
    // No local error-mapping catch: `assertConfigOk` errors propagate with original identity to the
    // central dispatcher mapper. A `DatabaseError` reaches the mapper as a
    // recognized `AppError` and so stays prefix-less (no "Failed to read chunk
    // neighbors" prefix); only a native error picks up that prefix.
    const before = args.before ?? 2
    const after = args.after ?? 2

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
    if ('source' in args) {
      targetPath = generateRawDataPath(this.dbPath, args.source)
      skipValidation = true
    } else {
      this.assertConfigOk()
      // DB key = the verbatim resolve()-stored path; look up as-is (realpath
      // stays in validateFilePath; see BaseDirsConfig for the path policy).
      targetPath = args.filePath
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
    const isRaw = isManagedRawDataPath(targetPath, this.dbPath)
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
