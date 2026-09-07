// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  type Annotations,
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_MIN_CHUNK_LENGTH, SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { listDocuments } from '../features/list.js'
import {
  formatSyncError,
  runSync,
  type SyncCollaborators,
  type SyncCoverage,
  type SyncIngestOptions,
} from '../features/sync.js'
import {
  buildChunksAndEmbeddings,
  buildVectorChunks,
  computeContentHash,
} from '../ingest/compute.js'
import {
  buildPreparedFileVectorChunks,
  type PreparedFileIngest,
  prepareFileForIngest,
} from '../ingest/file.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser, ValidationError } from '../parser/index.js'
import { extractMarkdownTitle, extractTxtTitle } from '../parser/title-extractor.js'
import { type BaseDirsConfigError, displayPath } from '../utils/base-dirs.js'
import { toError } from '../utils/errors.js'
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
import { isRecord } from '../utils/type-guards.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'
import {
  appendConfigWarnings,
  buildConfigErrorBlock,
  formatErrorForClient,
  logError,
  type RagContentBlock,
  type RagTextContentBlock,
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
  DeleteFileInput,
  DeleteFileResult,
  FileEntry,
  IngestDataInput,
  IngestFileInput,
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
 * Per-tool client-message policy for `toMcpError`. A `prefix` is prepended
 * only to native / non-`AppError` failures; a recognized `AppError` keeps its
 * own message.
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

const ATTACHMENT_WARNING_ANNOTATIONS = {
  audience: ['user', 'assistant'],
  priority: 0.3,
} satisfies Annotations

type QueryContent = [RagTextContentBlock, ...RagContentBlock[]]

/**
 * What one ingest source contributed before rows are stored. Raw-data sources
 * arrive as finished `vectorChunks`; parsed files arrive as a `preparedFile`
 * whose rows are built later, after the backup read.
 */
interface PreparedIngestSource {
  title: string | null
  omittedImageCount: number
  vectorChunks?: VectorChunk[]
  preparedFile?: PreparedFileIngest
}

/** Wrap a parser-normalized scalar-or-array input into an array. */
function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

function attachmentOmissionWarning(omittedCount: number): RagTextContentBlock {
  return {
    type: 'text',
    text: `Warning: Visual attachments omitted ${omittedCount} unavailable or invalid attachment${omittedCount === 1 ? '' : 's'}. Text search results are unchanged.`,
    annotations: ATTACHMENT_WARNING_ANNOTATIONS,
  }
}

function attachmentHydrationFailureWarning(): RagTextContentBlock {
  return {
    type: 'text',
    text: 'Warning: Visual attachments could not be loaded. Text search results are unchanged.',
    annotations: ATTACHMENT_WARNING_ANNOTATIONS,
  }
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

const packageManifest: unknown = createRequire(import.meta.url)('../../package.json')
const packageVersion =
  isRecord(packageManifest) && typeof packageManifest['version'] === 'string'
    ? packageManifest['version']
    : '0.0.0'

/**
 * Zero-chunk outcome of {@link RAGServer.handleIngestFile}, raised before any
 * destructive work so the existing index survives.
 *
 * An `McpError` subclass so the client sees an unchanged code and message,
 * while sync can count it as `empty` rather than as a failed job.
 */
class NoChunksError extends McpError {}

/**
 * Render the scanner's coverage facts as warnings — each unobserved region is
 * a reason prune was withheld there. The wording is not a contract.
 *
 * Paths go through `displayPath`, as `list_files` does: the MCP client is
 * remote to the operator's account, so `~` hides the OS username. The CLI
 * variant prints full paths, since that terminal belongs to the operator.
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

/** RAG server compliant with MCP Protocol */
/** Formats whose embedded images this server can extract. */
function supportsEmbeddedImages(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.pdf') || lower.endsWith('.docx')
}

export class RAGServer {
  private readonly server: Server
  private readonly vectorStore: VectorStore
  private readonly embedder: Embedder
  private readonly chunker: SemanticChunker
  private readonly parser: DocumentParser
  private readonly dbPath: string
  /**
   * Allowed document roots, REALPATH-normalized — the security boundary handed
   * to `DocumentParser`. `list_files` scanning and display use the normal-path
   * `rawBaseDirs` below instead.
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
   * When non-null the server is in degraded mode: `status` stays callable so the
   * user can diagnose over MCP, while root-dependent tools must reject first.
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
  private readonly storeImages: boolean
  /**
   * The one current-or-latest sync job this process retains. A new `sync_start`
   * replaces a terminal record, so the older id becomes unknown; there is no
   * history, persistence or recovery.
   */
  private syncJob: SyncStatusResult | null = null
  /**
   * True while one external mutation is in flight (SYNC-007). A request-scoped
   * mutation clears it when the request completes; a sync keeps it until its
   * job reaches a terminal state.
   */
  private mutationInFlight: boolean = false

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
    this.storeImages = config.storeImages ?? false
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
   * Fail-fast guard for root-dependent tools in degraded mode: reject before any
   * DB / embedder / parser access. Throws the stored error so the dispatcher
   * mapper owns the code, rather than hand-building one here.
   *
   * `status` deliberately does not call this — it stays callable and reports the
   * error in a diagnostic block, so recovery does not need stderr.
   */
  private assertConfigOk(): void {
    if (this.configError !== null) {
      throw this.configError
    }
  }

  /** Every handler funnels through here, so the warning shape lives in one place. */
  private withWarnings<T extends RagContentBlock[]>(content: T): T {
    return appendConfigWarnings(content, this.configWarnings)
  }

  /**
   * Take the single external-mutation slot, or describe the overlap.
   *
   * Returns `null` when the slot was free. Otherwise an ordinary result with
   * `isError: true` rather than a thrown error, naming the holding job id and
   * pointing at `sync_status` — the only way to learn when to retry.
   */
  private acquireMutation(): { content: RagTextContentBlock[]; isError: true } | null {
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

    // The handlers carry no error mapping: every error reaches the single catch
    // below with its ORIGINAL identity, which logs the full cause chain to
    // stderr and maps it for the client. `TOOL_ERROR_CONTEXT` holds each
    // handler's message policy, so that table lives in one place.
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: { params: { name: string; arguments?: unknown } }) => {
        const toolName = request.params.name
        // The mutation guard sits here, on the external dispatch path only, so
        // an internal call such as `handleIngestData` -> `handleIngestFile`
        // cannot reacquire it and self-deadlock.
        if (MUTATION_TOOLS.has(toolName)) {
          const overlap = this.acquireMutation()
          if (overlap !== null) {
            return overlap
          }
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
          if (releaseWhenRequestEnds) {
            this.releaseMutation()
          }
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
  async handleQueryDocuments(args: QueryDocumentsInput): Promise<{ content: QueryContent }> {
    // query_documents reads only LanceDB, so it stays callable in degraded
    // mode; `withWarnings` and `status` remain the diagnostic surface.
    const queryVector = await this.embedder.embed(args.query)

    // `args.scope` is parser-validated; array-wrap without re-validating, and
    // omit the key when absent (exactOptionalPropertyTypes) to keep the scope-absent path.
    const searchResults = await this.vectorStore.search(queryVector, {
      queryText: args.query,
      limit: args.limit ?? 10,
      ...(args.scope !== undefined ? { scope: toArray(args.scope) } : {}),
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

    let hydratedRows: Awaited<ReturnType<VectorStore['hydrateVisualAttachments']>>['rows'] = []
    let attachmentWarning: RagContentBlock | null = null
    try {
      const hydration = await this.vectorStore.hydrateVisualAttachments(searchResults)
      hydratedRows = hydration.rows
      if (hydration.omittedCount > 0) {
        attachmentWarning = attachmentOmissionWarning(hydration.omittedCount)
      }
    } catch {
      attachmentWarning = attachmentHydrationFailureWarning()
    }

    const content: QueryContent = [
      {
        type: 'text',
        text: JSON.stringify(results, null, 2),
      },
    ]

    const attachmentsByIdentity = new Map(hydratedRows.map((row) => [row.id, row.attachments]))
    for (const [resultIndex, result] of results.entries()) {
      const attachments = attachmentsByIdentity.get(searchResults[resultIndex]?.id ?? '') ?? []
      for (const attachment of attachments) {
        content.push({
          type: 'text',
          text: JSON.stringify({
            type: 'visual_attachment',
            result: {
              filePath: result.filePath,
              chunkIndex: result.chunkIndex,
              ...(result.source === undefined ? {} : { source: result.source }),
            },
            imageIndex: attachment.imageIndex,
            mimeType: attachment.mimeType,
          }),
        })
        content.push({
          type: 'image',
          data: attachment.data,
          mimeType: attachment.mimeType,
        })
      }
    }

    if (attachmentWarning) {
      content.push(attachmentWarning)
    }

    // Append config warnings on every call because MCP clients may hide
    // stderr and may not retain context across calls.
    return { content: this.withWarnings(content) }
  }

  /**
   * `options.skipOptimize` is internal: sync compacts once per run, so its reuse
   * of this handler must not compact once per file (a 100-file sync would
   * otherwise perform 101 compactions). The tools omit it and compact per call.
   */
  async handleIngestFile(
    raw: unknown,
    options: { skipOptimize?: boolean; images?: boolean } = {}
  ): Promise<{ content: RagTextContentBlock[] }> {
    const result = await this.ingestFile(parseIngestFileInput(raw), options)
    // Insertion has committed. Maintenance errors must not restore old rows.
    if (options.skipOptimize !== true) {
      await this.vectorStore.optimize()
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

  /** What one ingest source contributed, before rows are built and stored. */
  private async prepareRawDataIngest(filePath: string): Promise<PreparedIngestSource> {
    // Raw-data files: skip parser validation, read directly.
    const sourceBytes = await readFile(filePath)
    const text = sourceBytes.toString('utf-8')
    const meta = await loadMetaJson(filePath)
    const title = meta?.title ?? null
    console.error(`Read raw-data file: ${filePath} (${text.length} characters)`)
    const { chunks, embeddings } = await buildChunksAndEmbeddings(text, this.chunker, this.embedder)
    return {
      title,
      omittedImageCount: 0,
      vectorChunks: buildVectorChunks({
        filePath,
        chunks,
        embeddings,
        fileSize: text.length,
        fileTitle: title,
        contentHash: computeContentHash(sourceBytes),
      }),
    }
  }

  private async prepareSourceFileIngest(
    filePath: string,
    options: Parameters<typeof prepareFileForIngest>[2]
  ): Promise<PreparedIngestSource> {
    // The MCP boundary accepts an arbitrary client path, unlike CLI ingestion
    // paths that have already passed a regular-file collector. Reject a FIFO
    // before the shared whole-file hash read can block the mutation slot.
    await this.parser.validateFilePath(filePath)
    this.parser.validateFileSize(filePath)
    if (!(await stat(filePath)).isFile()) {
      throw new ValidationError(`Ingest source is not a regular file: ${filePath}`)
    }
    const preparedFile = await prepareFileForIngest(
      filePath,
      { parser: this.parser, chunker: this.chunker, embedder: this.embedder },
      options
    )
    return {
      title: preparedFile.title,
      omittedImageCount: preparedFile.omittedImageCount,
      preparedFile,
    }
  }

  /**
   * Restore the pre-ingest state after a failed insert. A rollback that itself
   * fails is reported as its own error, because the prior data may now be gone.
   */
  private async rollbackIngest(
    filePath: string,
    backup: VectorChunk[],
    insertError: unknown
  ): Promise<void> {
    try {
      // insertChunks can fail during setup after writing rows. Remove that
      // version before restoring the backup, including failed first ingests.
      await this.vectorStore.deleteChunks(filePath)
      if (backup.length > 0) {
        await this.vectorStore.insertChunks(backup)
        await this.vectorStore.optimize()
      }
      console.error(`Rollback completed: ${backup.length} chunks restored`)
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError)
      throw new DatabaseError(
        `Ingest failed and rollback failed for ${filePath}; existing data may not have been restored. Original insert error: ${toError(insertError).message}`,
        { cause: toError(insertError) }
      )
    }
  }

  private async ingestFile(
    args: IngestFileInput,
    options: { images?: boolean } = {}
  ): Promise<IngestResult> {
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

    // No outer error-mapping catch: failures reach the central dispatcher
    // mapper with their original identity. The inner insert/rollback catch is
    // local-effect only.
    const prepared = isRawData
      ? await this.prepareRawDataIngest(args.filePath)
      : await this.prepareSourceFileIngest(args.filePath, {
          images: supportsEmbeddedImages(args.filePath) && (options.images ?? this.storeImages),
          ...(visualArg === true
            ? {
                captioner: { profile: visualQuality, cacheDir: this.cacheDir, device: this.device },
              }
            : {}),
        })
    const title = prepared.title
    let vectorChunks = prepared.vectorChunks
    const preparedFile = prepared.preparedFile

    if (prepared.omittedImageCount > 0) {
      console.warn(
        `Skipped ${prepared.omittedImageCount} undecodable or oversized image(s) in ${args.filePath}`
      )
    }

    // Fail-fast: Prevent data loss when chunking produces 0 chunks
    // This check must happen BEFORE delete to preserve existing data on re-ingest
    const chunkCount = vectorChunks?.length ?? preparedFile?.chunks.length ?? 0
    if (chunkCount === 0) {
      throw new NoChunksError(
        ErrorCode.InvalidParams,
        `No chunks generated from file: ${args.filePath}. The file may be empty or all content was filtered (minimum ${this.minChunkLength} characters required). Existing data has been preserved.`
      )
    }

    // Back up existing chunks BEFORE the destructive delete, with their real
    // stored vectors, so a failed re-ingest rolls back without corrupting them.
    // A failed read propagates from here, leaving the existing data untouched,
    // rather than proceeding into the delete with a partial backup.
    const backup = await this.vectorStore.getChunksByFilePath(args.filePath)
    if (backup.length > 0) {
      console.error(`Backup created: ${backup.length} chunks for ${args.filePath}`)
    }

    // Preserve the original server ordering: row construction follows the
    // backup read but still completes before the destructive delete.
    if (preparedFile !== undefined) {
      vectorChunks = buildPreparedFileVectorChunks(preparedFile)
    }
    if (vectorChunks === undefined) {
      throw new DatabaseError(`No chunks were prepared for ingest: ${args.filePath}`)
    }
    const chunksToInsert = vectorChunks

    // Delete existing data
    await this.vectorStore.deleteChunks(args.filePath)
    console.error(`Deleted existing chunks for: ${args.filePath}`)

    // Insert vectors (transaction processing)
    try {
      await this.vectorStore.insertChunks(chunksToInsert)
      console.error(`Inserted ${chunksToInsert.length} chunks for: ${args.filePath}`)
    } catch (insertError) {
      console.error('Ingestion failed, rolling back...', insertError)
      await this.rollbackIngest(args.filePath, backup, insertError)
      throw insertError
    }

    return {
      filePath: args.filePath,
      chunkCount,
      timestamp: new Date().toISOString(),
      fileTitle: title || null,
    }
  }

  /**
   * Saves raw content under raw-data and re-enters `handleIngestFile`. HTML is
   * reduced to its main content and converted to Markdown first, so chunking
   * sees prose rather than markup.
   */
  async handleIngestData(args: IngestDataInput): Promise<{ content: RagTextContentBlock[] }> {
    // ingest_data writes only under `dbPath`/raw-data and never reads a
    // configured `baseDir`, so it stays callable in degraded mode: a user with
    // invalid BASE_DIRS can still capture raw-data while diagnosing. The
    // internal `handleIngestFile` call takes a generated raw-data path, which
    // routes around `parser.validateFilePath`.
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

    const rawDataPath = generateRawDataPath(this.dbPath, args.metadata.source)
    const artifactPaths = [rawDataPath, generateMetaJsonPath(rawDataPath)]
    // Capture both artifacts before either write. Only ENOENT means creation;
    // an unreadable existing source must fail before it can be overwritten.
    const previousArtifacts = await Promise.all(
      artifactPaths.map(async (path) => {
        try {
          return { path, content: await readFile(path) }
        } catch (error) {
          if (!isEnoent(error)) {
            throw error
          }
          return { path, content: null }
        }
      })
    )

    let result: { content: RagTextContentBlock[] }
    try {
      await saveRawData(this.dbPath, args.metadata.source, contentToSave)
      await saveMetaJson(rawDataPath, {
        title,
        source: args.metadata.source,
        format: args.metadata.format,
      })
      console.error(`Saved raw data: ${args.metadata.source} -> ${rawDataPath}`)
      result = await this.handleIngestFile({ filePath: rawDataPath }, { skipOptimize: true })
    } catch (ingestError) {
      const restored = await Promise.allSettled(
        previousArtifacts.map(async ({ path, content }) => {
          if (content !== null) {
            await writeFile(path, content)
          } else {
            try {
              await unlink(path)
            } catch (error) {
              if (!isEnoent(error)) {
                throw error
              }
            }
          }
        })
      )
      if (restored.some((outcome) => outcome.status === 'rejected')) {
        console.warn(`Failed to rollback raw-data file: ${rawDataPath}`)
        throw new DatabaseError(
          `Ingest failed and raw-data rollback failed for ${rawDataPath}; original artifacts may not have been restored.`,
          { cause: toError(ingestError) }
        )
      }
      console.error(`Rolled back raw-data file: ${rawDataPath}`)
      throw ingestError
    }
    // Both artifacts and index now describe the replacement. A maintenance
    // failure remains visible to the caller without undoing committed content.
    await this.vectorStore.optimize()
    return result
  }

  /**
   * Scans the normal-path roots (`this.rawBaseDirs`) so scanned paths match the
   * resolve()-stored DB keys (see {@link BaseDirsConfig}).
   *
   * Multi-root contract: a top-level `baseDir` is still reported as
   * `rawBaseDirs[0]` for clients written against the single-root shape;
   * duplicate paths across roots collapse to the first occurrence in root
   * order; raw-data and orphaned DB entries stay under `sources` with no
   * producing root.
   */
  async handleListFiles(input: ListFilesInput = {}): Promise<{ content: RagTextContentBlock[] }> {
    // Root-dependent tool: fail fast on configError BEFORE any DB / FS access.
    // `assertConfigOk` throws `BaseDirsConfigError` (mapped to InvalidParams by
    // the central dispatcher); no local error-mapping catch here.
    this.assertConfigOk()
    // `input.scope` is parser-normalized to `string[]`, but the shared input
    // type admits `string | string[]`; array-wrap once (mirrors query_documents)
    // so scope threads uniformly into the walker and the sources classifier.
    // Undefined scope leaves both the scan and the sources split unchanged.
    const scope = input.scope === undefined ? undefined : toArray(input.scope)
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
    const content: RagTextContentBlock[] = [{ type: 'text', text: JSON.stringify(result, null, 2) }]
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
  async handleStatus(): Promise<{ content: RagTextContentBlock[] }> {
    // `status` remains callable in degraded mode (configError set) so the
    // user can diagnose the root configuration via MCP without inspecting
    // stderr. Do NOT call `assertConfigOk` here — status surfaces the config
    // error as a diagnostic content block instead of throwing. No local
    // error-mapping catch: genuine DB failures propagate (prefix-less) to the
    // central dispatcher mapper.
    const status = await this.vectorStore.getStatus()
    const content: RagTextContentBlock[] = [
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
  async handleDeleteFile(raw: unknown): Promise<{ content: RagTextContentBlock[] }> {
    const args = parseDeleteFileInput(raw)
    // No outer error-mapping catch: the inline `McpError(InvalidParams)` and
    // `assertConfigOk` throw propagate with original identity to the central
    // dispatcher mapper. The inner unlink try/catch blocks below are
    // local-effect (best-effort file cleanup) and are retained.
    const targetPath = await this.resolveDocumentTarget(args)

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
   * Context expansion around a chunkIndex, not a search tool. Mirrors
   * handleDeleteFile's filePath-XOR-source resolution.
   */
  async handleReadChunkNeighbors(raw: unknown): Promise<{ content: RagTextContentBlock[] }> {
    const args = parseReadChunkNeighborsInput(raw)
    // No local error-mapping catch: `assertConfigOk` errors propagate with original identity to the
    // central dispatcher mapper. A `DatabaseError` reaches the mapper as a
    // recognized `AppError` and so stays prefix-less (no "Failed to read chunk
    // neighbors" prefix); only a native error picks up that prefix.
    const before = args.before ?? 2
    const after = args.after ?? 2

    const targetPath = await this.resolveDocumentTarget(args)

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
      if (sourceForAll) {
        item.source = sourceForAll
      }
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

  /** Resolve the shared filePath/source reference without changing its DB-key spelling. */
  private async resolveDocumentTarget(reference: DeleteFileInput): Promise<string> {
    if ('source' in reference) {
      // Generated raw-data paths do not depend on configured document roots, so
      // source-mode operations remain callable while root configuration is invalid.
      return generateRawDataPath(this.dbPath, reference.source)
    }

    this.assertConfigOk()
    await this.parser.validateFilePath(reference.filePath)
    return reference.filePath
  }

  /**
   * Registers the one current job and answers with its id without waiting: the
   * caller polls `sync_status`.
   *
   * The scheduled promise is deliberately floating — an unexpected rejection is
   * captured into the job record rather than escaping, and the run holds the
   * external-mutation guard until it is terminal.
   */
  async handleSyncStart(input: SyncStartInput): Promise<{ content: RagTextContentBlock[] }> {
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

    this.runSyncJob(jobId, input.path)
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
   * Read-only, so it stays callable while a sync holds the mutation guard. Any
   * id but the current one is unknown — replaced by a newer `sync_start`, or
   * lost with a previous server process.
   */
  async handleSyncStatus(input: SyncStatusInput): Promise<{ content: RagTextContentBlock[] }> {
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
    if (this.syncJob === null || this.syncJob.jobId !== jobId) {
      return
    }
    this.syncJob = { ...this.syncJob, ...patch }
  }

  /**
   * One sync job's body: supply the real collaborators to the shared core and
   * fold its result into the pollable record. Planning and the
   * stop-on-first-error policy stay in the core, so path classification and
   * depth match the CLI exactly.
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
        await bfsCollectSupportedFiles(rootPath, this.excludePaths, { maxDepth: MAX_SCAN_DEPTH }),
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
        if ((await stat(filePath)).size > this.maxFileSize) {
          return null
        }
        const contentHash = computeContentHash(await readFile(filePath))
        hashedFiles += 1
        return contentHash
      },
      loadDbManifest: async () => {
        // The core hashes every scanned file before it loads the manifest, so
        // this is the first moment the supported-file count is final.
        this.updateSyncJob(jobId, { total: hashedFiles })
        return await this.vectorStore.listSyncManifest()
      },
      ingestFile: async (filePath: string, options: SyncIngestOptions) => {
        const chunkCount = await this.ingestFileForSync(filePath, options)
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
      ...(this.storeImages ? { images: true } : {}),
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
      error: result.error === null ? null : formatSyncError(result.error),
    })
  }

  /**
   * Sync's `ingestFile` uses the same typed operation as `ingest_file`, keeping
   * its backup and rollback semantics. A zero-chunk file is rejected before the
   * delete, so prior rows survive, and is reported as `empty`.
   *
   * The planner's resolved profile is expressed through the same `visual` /
   * `visualQuality` arguments a direct `ingest_file` call uses, so inheritance
   * reuses the configured cache and device rather than a second VLM route.
   *
   * Per-file compaction is skipped because the sync core runs one `optimize()`
   * for the whole run. A rollback still compacts — that path restores rows and
   * then aborts, so no later `optimize()` follows.
   */
  private async ingestFileForSync(
    filePath: string,
    { images, visualProfile }: SyncIngestOptions
  ): Promise<number> {
    try {
      const result = await this.ingestFile(
        visualProfile === null
          ? { filePath }
          : { filePath, visual: true, visualQuality: visualProfile },
        { images }
      )
      return result.chunkCount
    } catch (error) {
      if (error instanceof NoChunksError) {
        return 0
      }
      throw error
    }
  }

  /**
   * Serve this instance's tool registration over `transport` — the registration
   * itself, not a copy, since `this.server` is private. `run()` passes stdio; a
   * test passes an in-memory pair.
   *
   * One instance serves at most one client: the job record and the mutation slot
   * are per-process, so a multiplexing transport would share one caller's write
   * lock with every other caller.
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
