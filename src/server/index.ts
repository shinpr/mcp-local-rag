// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { readFile, stat, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
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
  runSync,
  type SyncCollaborators,
  type SyncCoverage,
  type SyncError,
} from '../features/sync.js'
import {
  buildChunksAndEmbeddings,
  buildVectorChunks,
  computeContentHash,
} from '../ingest/compute.js'
import { prepareVisualPdfChunks } from '../ingest/visual.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser, ValidationError } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import { type BaseDirsConfigError, displayPath } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
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
import {
  bfsCollectSupportedFiles,
  canonicalizeRequestedPath,
  classifyRequestedPath,
} from '../utils/scan.js'
import { nonAbsolutePrefixes } from '../utils/scope-match.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import {
  appendConfigWarnings,
  buildConfigErrorBlock,
  formatErrorForClient,
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
  parseSyncStartInput,
  parseSyncStatusInput,
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
  SyncStartInput,
  SyncStatusInput,
  SyncStatusResult,
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
  sync_start: { prefix: 'Failed to start sync' },
  query_documents: {},
  list_files: {},
  status: {},
  sync_status: {},
}

/**
 * Tools that mutate the index and therefore pass through the one server-instance
 * mutation guard (SYNC-007). Read-only tools are deliberately absent: they stay
 * callable while a sync holds the guard.
 */
const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'sync_start',
  'ingest_file',
  'ingest_data',
  'delete_file',
])

const packageVersion = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version

/**
 * Zero-chunk outcome of {@link RAGServer.handleIngestFile}, raised before any
 * destructive work so the existing index is preserved.
 *
 * An `McpError` subclass rather than a separate error type: the code and message
 * a client sees are unchanged, while the internal sync collaborator can tell
 * "this file produced nothing" apart from a genuine ingest failure and count it
 * as `empty` instead of failing the whole job.
 */
class NoChunksError extends McpError {}

/**
 * Render the scanner's coverage facts as caller-facing warnings, one per
 * unobserved region, because each one is a reason prune was withheld there. The
 * wording is not a contract. Carried as JSON strings on the job record rather
 * than as content blocks, because status is a single pollable record — the
 * `list_files` warning blocks are unchanged.
 *
 * Paths go through `displayPath`, as `list_files` already does with the same
 * walker facts: the MCP client is remote to the operator's account, so the home
 * directory (and with it the OS username) is abbreviated to `~`. The CLI variant
 * deliberately prints the full path — that terminal belongs to the operator.
 */
function coverageWarnings(coverage: SyncCoverage, maxFileSize: number): string[] {
  return [
    ...coverage.unreadableDirs.map(
      ({ dirPath, code }) =>
        `Warning: cannot read directory (${code}), so its indexed files were kept: ${displayPath(dirPath)}`
    ),
    ...coverage.depthLimitedDirs.map(
      (dirPath) =>
        `Warning: not scanned because it exceeds the maximum depth (${MAX_SCAN_DEPTH}), so its indexed files were kept: ${displayPath(dirPath)}`
    ),
    ...coverage.skippedSymlinks.map(
      (linkPath) =>
        `Warning: symbolic link not followed, so its indexed files were kept: ${displayPath(linkPath)}`
    ),
    ...coverage.oversizedFiles.map(
      (filePath) =>
        `Warning: not read because it exceeds the maximum file size (${maxFileSize} bytes), so its indexed chunks were kept: ${displayPath(filePath)}`
    ),
  ]
}

/**
 * The one controlled error string a failed job exposes. Scope and existence
 * messages already name the path, while a per-file ingest failure ("Missing
 * embedding for chunk 1") does not — there the suffix is the only thing
 * identifying the file, so it is appended exactly once.
 */
function syncErrorText({ message, filePath }: SyncError): string {
  return filePath === null || message.includes(filePath) ? message : `${message} (${filePath})`
}

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
  /**
   * Configured byte ceiling for one ingested file. The parser enforces it for
   * parsing; sync also needs it before hashing, where nothing else bounds the
   * read.
   */
  private readonly maxFileSize: number
  private readonly device: string | undefined
  /**
   * The one current-or-latest sync job this process retains (SYNC-006). A new
   * `sync_start` replaces a terminal record, so the older id becomes unknown,
   * and process exit simply discards it: there is no history, persistence,
   * eviction policy, or recovery.
   */
  private syncJob: SyncStatusResult | null = null
  /**
   * True while one external mutation is in flight (SYNC-007). A request-scoped
   * mutation clears it when the request completes; a sync keeps it until its
   * job reaches a terminal state.
   */
  private mutationInFlight = false

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
    this.maxFileSize = config.maxFileSize
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
   * Take the single external-mutation slot, or describe the overlap.
   *
   * Returns `null` when the slot was free (the caller now holds it), otherwise
   * the responsive overlap result: an ordinary tool result with `isError: true`
   * rather than a thrown error, so it never passes through `toMcpError`. When a
   * sync holds the guard the message names its job id and points at
   * `sync_status`, which is the only way for the caller to learn when to retry.
   */
  private acquireMutation(): { content: RagContentBlock[]; isError: true } | null {
    if (!this.mutationInFlight) {
      this.mutationInFlight = true
      return null
    }
    const runningJob = this.syncJob?.state === 'running' ? this.syncJob : null
    const text =
      runningJob === null
        ? 'Another write operation is already running on this server. Retry when it finishes.'
        : `A sync job is running (jobId: ${runningJob.jobId}). Poll sync_status with that jobId and retry once it is no longer running.`
    return { content: this.withWarnings([{ type: 'text', text }]), isError: true }
  }

  private releaseMutation(): void {
    this.mutationInFlight = false
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
        // The mutation guard sits here, on the external dispatch path only, so
        // an internal call such as `handleIngestData` -> `handleIngestFile`
        // cannot reacquire it and self-deadlock.
        if (MUTATION_TOOLS.has(toolName)) {
          const overlap = this.acquireMutation()
          if (overlap !== null) return overlap
        }
        // `sync_start` hands the guard to the job it schedules, which releases
        // it on the terminal transition; every other mutation is request-scoped
        // and releases below whether it succeeds or throws.
        let releaseWhenRequestEnds = MUTATION_TOOLS.has(toolName)
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
            case 'sync_start': {
              const started = await this.handleSyncStart(
                parseSyncStartInput(request.params.arguments)
              )
              // Reached only once a job is registered and scheduled; a throw
              // above leaves the flag set so the `finally` frees the guard.
              releaseWhenRequestEnds = false
              return started
            }
            case 'sync_status':
              return await this.handleSyncStatus(parseSyncStatusInput(request.params.arguments))
            default:
              throw new Error(`Unknown tool: ${toolName}`)
          }
        } catch (error) {
          const context = TOOL_ERROR_CONTEXT[toolName] ?? {}
          logError(toolName, error)
          throw toMcpError(error, context)
        } finally {
          if (releaseWhenRequestEnds) this.releaseMutation()
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
   * Hash the source file's raw bytes for `contentHash`, before anything parses it.
   *
   * This read is now the first thing to touch a client-supplied path, so the three
   * checks the parse used to perform ahead of it run here instead:
   *  - `validateFilePath` refuses a path outside every configured root, or one that
   *    reaches outside through a symlinked ancestor. It makes no judgement about
   *    what kind of file the path names.
   *  - `validateFileSize` keeps a whole oversized file out of memory, which is the
   *    bound the old post-parse position relied on.
   *  - the regular-file check refuses everything the read cannot safely consume:
   *    `readFile` on a directory fails with a native `EISDIR` (an `InternalError`
   *    at this boundary, where the format dispatch used to answer `InvalidParams`),
   *    and on a FIFO it blocks forever — which would hold this tool's mutation slot
   *    until the process restarts, the same trigger sync's `classifyRequestedPath`
   *    closed on its own route. Neither parser check rejects those: a directory has
   *    a small size and a FIFO reports size 0.
   *
   * `validateFilePath` and `validateFileSize` are re-run idempotently by the parse
   * that follows; a regular file with an unsupported extension is still rejected
   * there, by the parser, with its own message.
   */
  private async readPreParseContentHash(filePath: string): Promise<string> {
    await this.parser.validateFilePath(filePath)
    this.parser.validateFileSize(filePath)
    if (!(await stat(filePath)).isFile()) {
      throw new ValidationError(`Ingest source is not a regular file: ${filePath}`)
    }
    return computeContentHash(await readFile(filePath))
  }

  /**
   * ingest_file tool handler (re-ingestion support, transaction processing, rollback capability)
   *
   * `options.skipOptimize` is internal: sync compacts once per run, so its reuse
   * of this handler must not compact once per file (a 100-file sync would
   * otherwise perform 101 compactions). The `ingest_file` and `ingest_data` tools
   * omit it and keep compacting per call, which is the behavior they always had.
   */
  async handleIngestFile(
    raw: unknown,
    options: { skipOptimize?: boolean } = {}
  ): Promise<{ content: RagContentBlock[] }> {
    const args = parseIngestFileInput(raw)
    const isRawData = await isPathInRawDataDir(args.filePath, this.dbPath)
    // Skip the configError gate only for paths structurally inside
    // `<dbPath>/raw-data/` (internal invocation from handleIngestData).
    if (!isRawData) {
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
    const sourceBytes = isRawData ? await readFile(args.filePath) : undefined
    // The hash covers the raw file bytes as they were BEFORE the parse, so a file
    // rewritten during the parse/chunk/embed window leaves a hash that is OLDER
    // than the disk bytes and the next sync re-ingests it. Hashing afterwards
    // stored the new bytes' hash against chunks built from the old ones, and every
    // later sync then read `disk hash == stored hash` and skipped the file forever.
    const contentHash =
      sourceBytes === undefined
        ? await this.readPreParseContentHash(args.filePath)
        : computeContentHash(sourceBytes)
    if (sourceBytes !== undefined) {
      // Raw-data files: skip parser validation, read directly.
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
      throw new NoChunksError(
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
    const vectorChunks = buildVectorChunks({
      filePath: args.filePath,
      chunks,
      embeddings,
      fileSize: text.length,
      fileTitle: title || null,
      contentHash,
    })

    // Delete existing data
    await this.vectorStore.deleteChunks(args.filePath)
    console.error(`Deleted existing chunks for: ${args.filePath}`)

    // Insert vectors (transaction processing)
    try {
      await this.vectorStore.insertChunks(vectorChunks)
      console.error(`Inserted ${vectorChunks.length} chunks for: ${args.filePath}`)

      // Optimize once after both delete + insert (not per-operation), unless the
      // caller compacts once for the whole batch.
      if (options.skipOptimize !== true) {
        await this.vectorStore.optimize()
      }

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
   * sync_start tool handler
   *
   * Registers the one current job, schedules the run, and answers with its id
   * without waiting for any of it: the caller polls `sync_status` (SYNC-006).
   * The scheduled promise is deliberately floating — an unexpected rejection is
   * captured into the job record instead of escaping, and the run holds the
   * external-mutation guard until it is terminal.
   */
  async handleSyncStart(input: SyncStartInput): Promise<{ content: RagContentBlock[] }> {
    // Root-dependent tool: fail fast on configError before registering a job.
    this.assertConfigOk()

    const jobId = randomUUID()
    this.syncJob = {
      jobId,
      state: 'running',
      total: null,
      completed: 0,
      summary: { upserted: 0, skipped: 0, empty: 0, pruned: 0 },
      warnings: [],
      error: null,
    }

    void this.runSyncJob(jobId, input.path)
      .catch((error: unknown) => {
        // Only an unexpected orchestration failure lands here: `runSync` already
        // returns its own controlled error. One error, no rollback, no retry.
        this.updateSyncJob(jobId, { state: 'failed', error: formatErrorForClient(error) })
      })
      .finally(() => {
        this.releaseMutation()
      })

    return {
      content: this.withWarnings([{ type: 'text', text: JSON.stringify({ jobId }, null, 2) }]),
    }
  }

  /**
   * sync_status tool handler
   *
   * Read-only, so it stays callable while a sync holds the mutation guard. Any
   * id other than the current one is unknown: the record was replaced by a newer
   * `sync_start` or lost with a previous server process.
   */
  async handleSyncStatus(input: SyncStatusInput): Promise<{ content: RagContentBlock[] }> {
    const job = this.syncJob
    if (job === null || job.jobId !== input.jobId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown sync job: ${input.jobId}. Only the current or latest job is kept: it is replaced by a newer sync_start and discarded when the server process exits.`
      )
    }
    return {
      content: this.withWarnings([{ type: 'text', text: JSON.stringify(job, null, 2) }]),
    }
  }

  /** Patch the current job, ignoring a write aimed at a record already replaced. */
  private updateSyncJob(jobId: string, patch: Partial<SyncStatusResult>): void {
    if (this.syncJob === null || this.syncJob.jobId !== jobId) return
    this.syncJob = { ...this.syncJob, ...patch }
  }

  /**
   * The scheduled body of one sync job: supply the real collaborators to the
   * shared core (`src/features/sync.ts`) and fold its result into the pollable
   * record. Planning, prune eligibility, and the stop-on-first-error policy stay
   * in the core; path classification and depth therefore match the CLI exactly.
   */
  private async runSyncJob(jobId: string, requestedPath: string | undefined): Promise<void> {
    let hashedFiles = 0
    let ingestedFiles = 0

    const collaborators: SyncCollaborators = {
      // The containment boundary for a client-supplied path: the core compares
      // this canonical form against the realpath'd roots, which is the only way
      // to see that an intermediate component is a symbolic link out of the root.
      // `ingest_file` validates the same way, so both tools refuse the same paths.
      canonicalizeRequestedPath,
      // The walker's own predicates, so an explicitly requested path is subject
      // to the same rules as a discovered one and is refused before it is read.
      // A path whose read would never return (a FIFO) is refused here too, which
      // matters more on this surface than on the CLI: the mutation guard is
      // released by this job's promise settling, and nothing else would.
      classifyPath: async (path: string) => await classifyRequestedPath(path, this.excludePaths),
      // No `scope` argument, on purpose: a scope-pruned directory appears in
      // none of the coverage arrays, which would hide an unobserved region and
      // make prune unsafe.
      scanDir: async (rootPath: string) =>
        await bfsCollectSupportedFiles(rootPath, this.excludePaths, MAX_SCAN_DEPTH),
      // Size first, bytes second: `maxFileSize` is otherwise enforced inside the
      // parser, which runs long after the whole file would already be in memory
      // here. Declining (`null`) keeps the rest of the run usable instead of
      // failing every future sync of the whole root on one oversized file.
      //
      // The bound holds only against a non-racing filesystem: a writer that grows
      // the file, or replaces it with a FIFO, between the `stat` and the
      // `readFile` restores the unbounded read or an indefinite block. That actor
      // needs local write access as this same user and can already reach the
      // database directly, so this is a recorded limitation rather than a defended
      // boundary — as with the watchdog limitation noted on the mutation guard.
      hashFile: async (filePath: string) => {
        if ((await stat(filePath)).size > this.maxFileSize) return null
        const contentHash = computeContentHash(await readFile(filePath))
        hashedFiles += 1
        return contentHash
      },
      loadDbManifest: async () => {
        // The core hashes every scanned file before it loads the manifest, so
        // this is the first moment the supported-file count is final.
        this.updateSyncJob(jobId, { total: hashedFiles })
        return await this.vectorStore.listChunkHashes()
      },
      ingestFile: async (filePath: string) => {
        const chunkCount = await this.ingestFileForSync(filePath)
        ingestedFiles += 1
        this.updateSyncJob(jobId, { completed: ingestedFiles })
        return chunkCount
      },
      deleteExactPath: async (filePath: string) => await this.vectorStore.deleteChunks(filePath),
      optimize: async () => {
        await this.vectorStore.optimize()
      },
    }

    const result = await runSync({
      roots: this.rawBaseDirs,
      // The realpath'd counterpart of the same roots, which is what the core
      // decides requested-path containment in (the parser's boundary domain).
      canonicalRoots: this.baseDirs,
      dbPath: this.dbPath,
      excludePaths: this.excludePaths,
      platform: process.platform,
      // resolve() (never realpath) so the requested path is spelled like the
      // stored DB keys; the core validates it against the configured roots.
      ...(requestedPath === undefined ? {} : { requestedPath: resolve(requestedPath) }),
      collaborators,
    })

    this.updateSyncJob(jobId, {
      state: result.error === null ? 'succeeded' : 'failed',
      // Skips are only known once the plan has run, so the final value can only
      // grow: a poll never sees `completed` go backwards.
      completed: result.upserted + result.skipped + result.empty,
      summary: {
        upserted: result.upserted,
        skipped: result.skipped,
        empty: result.empty,
        pruned: result.pruned,
      },
      warnings: coverageWarnings(result.coverage, this.maxFileSize),
      error: result.error === null ? null : syncErrorText(result.error),
    })
  }

  /**
   * Sync's `ingestFile` collaborator: the ordinary MCP ingest path, so a sync
   * upsert keeps the same backup/rollback semantics as `ingest_file`, reduced to
   * the chunk count the core needs. The zero-chunk file is the one difference —
   * `handleIngestFile` rejects it to protect the existing index, while sync
   * counts it as `empty` and leaves its prior rows alone.
   *
   * The count is read back out of the handler's own response block rather than
   * duplicating the handler to return it twice.
   *
   * Compaction is the second difference: the sync core runs one `optimize()` for
   * the whole run, so the per-file one is skipped here. A rollback still compacts
   * — that path restores rows and then aborts the run, so no later `optimize()`
   * follows it.
   */
  private async ingestFileForSync(filePath: string): Promise<number> {
    try {
      const response = await this.handleIngestFile({ filePath }, { skipOptimize: true })
      const { chunkCount } = JSON.parse(response.content[0]?.text ?? '{}') as {
        chunkCount?: number
      }
      return chunkCount ?? 0
    } catch (error) {
      if (error instanceof NoChunksError) return 0
      throw error
    }
  }

  /**
   * Serve this instance's tool registration over `transport`.
   *
   * Exposed because the registration itself — not a re-registered copy of it —
   * is what an MCP client talks to, and `this.server` is private. `run()` passes
   * the stdio transport; a test passes an in-memory pair.
   *
   * One instance serves at most one client: the sync job record and the mutation
   * slot are per-process, so a transport that multiplexed clients would share one
   * caller's job state and one caller's write lock with every other caller.
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport)
  }

  /**
   * Start the server
   */
  async run(): Promise<void> {
    await this.connect(new StdioServerTransport())
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
