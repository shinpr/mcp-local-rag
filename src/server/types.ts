// Type definitions for RAGServer

import type { QualityProfile } from '../pdf-visual/types.js'
import type { BaseDirsConfigError } from '../utils/base-dirs.js'
import type { ContentFormat } from '../utils/raw-data-utils.js'
import type { GroupingMode } from '../vectordb/index.js'

/**
 * Fields shared by both `RAGServerConfig` shapes (legacy single-root and
 * multi-root). Extracted so the union below only needs to describe the
 * `baseDir` / `baseDirs` axis.
 */
interface RAGServerConfigBase {
  /** LanceDB database path */
  dbPath: string
  /** Transformers.js model path */
  modelName: string
  /** Model cache directory */
  cacheDir: string
  /** Maximum file size (100MB) */
  maxFileSize: number
  /** Compute device (cpu, webgpu, dml, etc) */
  device?: string
  /** Embedding quantization dtype (fp32, fp16, q8, int8, ...). Unset → fp32. */
  dtype?: string
  /** Maximum distance threshold for quality filtering (optional) */
  maxDistance?: number
  /** Grouping mode for quality filtering (optional) */
  grouping?: GroupingMode
  /** Hybrid search weight for BM25 (0.0 = vector only, 1.0 = BM25 only, default 0.6) */
  hybridWeight?: number
  /** Maximum number of files to keep in search results (optional) */
  maxFiles?: number
  /** Minimum chunk length in characters (optional, default: 50) */
  chunkMinLength?: number
  /** Store bounded PDF regions and Mammoth-produced DOCX images. */
  storeImages?: boolean
  /**
   * Normal-path roots, index-aligned with the realpath'd `baseDirs` boundary,
   * used for user-facing scan and display so paths match the stored DB keys.
   * Legacy `{ baseDir }` callers fall back to `baseDirs`.
   */
  rawBaseDirs?: readonly string[]
  /** Configuration validation warnings to surface to users via MCP annotations */
  configWarnings?: string[]
  /**
   * When present the server is in degraded mode: `status` stays callable for
   * diagnosis, while root-dependent tools surface this first.
   */
  configError?: BaseDirsConfigError
}

/**
 * RAGServer configuration. Exactly one of `baseDir` (legacy) or `baseDirs`
 * must be supplied; the constructor normalizes both to `baseDirs` and derives
 * the legacy accessor as `baseDirs[0]`.
 */
export type RAGServerConfig =
  | (RAGServerConfigBase & {
      /** Document base directory (legacy single-root shape). */
      baseDir: string
      baseDirs?: undefined
    })
  | (RAGServerConfigBase & {
      /** One or more allowed document base directories (multi-root shape). */
      baseDirs: string[]
      baseDir?: undefined
    })

/**
 * query_documents tool input
 */
export interface QueryDocumentsInput {
  /** Natural language query */
  query: string
  /** Number of results to retrieve (default 10) */
  limit?: number
  /** Path prefix scope (one or a list); the parser normalizes to `string[]`. */
  scope?: string | string[]
}

/**
 * list_files tool input
 */
export interface ListFilesInput {
  /** Path prefix scope (one or a list); the parser normalizes to `string[]`. */
  scope?: string | string[]
}

/**
 * ingest_file tool input
 */
export interface IngestFileInput {
  /** File path */
  filePath: string
  /**
   * When true and `filePath` is a PDF, VLM captioning runs. Silently coerced to
   * text-only for non-PDFs. The handler still checks at runtime, because MCP
   * arguments arrive as `unknown`.
   */
  visual?: boolean
  /**
   * Visual-quality profile when `visual` is true. Some MCP clients send the
   * empty string for unspecified optional parameters; the transport decoder
   * normalizes it before this type reaches the handler.
   */
  visualQuality?: QualityProfile
}

/**
 * ingest_data tool input metadata
 */
interface IngestDataMetadata {
  /** Source identifier: URL ("https://...") or custom ID ("clipboard://2024-12-30") */
  source: string
  /** Content format */
  format: ContentFormat
}

/**
 * ingest_data tool input
 */
export interface IngestDataInput {
  /** Content to ingest (text, HTML, or Markdown) */
  content: string
  /** Content metadata */
  metadata: IngestDataMetadata
}

/**
 * delete_file tool input
 * Either filePath or source must be provided
 */
export type DeleteFileInput =
  | { filePath: string; source?: never }
  | { source: string; filePath?: never }

/**
 * delete_file tool output
 */
export interface DeleteFileResult {
  /** Resolved file path used for the delete operation */
  filePath: string
  /** True when the delete operation completed (idempotent; not "something was removed") */
  deleted: true
  /** Number of vector chunks removed from the database */
  removedChunks: number
  /** True when ingested chunks and/or raw-data artifacts existed before delete */
  existed: boolean
  /** Timestamp */
  timestamp: string
}

/**
 * ingest_file tool output
 */
export interface IngestResult {
  /** File path */
  filePath: string
  /** Chunk count */
  chunkCount: number
  /** Timestamp */
  timestamp: string
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * One file found under an effective base directory. `baseDir` is always
 * present, including single-root configs — additive over the legacy shape, so
 * clients that ignore it keep working.
 */
export type FileEntry =
  | {
      filePath: string
      baseDir: string
      ingested: true
      chunkCount: number
      timestamp: string
    }
  | { filePath: string; baseDir: string; ingested: false }

/**
 * list_files tool output — entry for content ingested via ingest_data,
 * or an orphaned DB entry whose file no longer exists on disk
 */
export type SourceEntry =
  | { source: string; chunkCount: number; timestamp: string }
  | { filePath: string; chunkCount: number; timestamp: string }

/**
 * list_files output.
 *
 * `baseDir` remains as `baseDirs[0]` for clients written against the
 * single-root shape. Duplicate paths across roots collapse to the first
 * occurrence in root order. `sources` holds raw-data and orphaned DB entries,
 * which no root produced and so carry no `baseDir`.
 */
export interface ListFilesResult {
  baseDir: string
  baseDirs: string[]
  files: FileEntry[]
  sources: SourceEntry[]
}

/**
 * query_documents tool output
 */
export interface QueryResult {
  /** File path */
  filePath: string
  /** Chunk index */
  chunkIndex: number
  /** Text */
  text: string
  /** Similarity score */
  score: number
  /** Original source (only for raw-data files, e.g., URLs ingested via ingest_data) */
  source?: string
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * read_chunk_neighbors tool input.
 * Exactly one of filePath / source must be provided (XOR).
 */
export type ReadChunkNeighborsInput = DeleteFileInput & {
  /** Target chunk index (zero-based, required, non-negative integer). */
  chunkIndex: number
  /** Number of chunks before the target to include (default 2, non-negative integer). */
  before?: number
  /** Number of chunks after the target to include (default 2, non-negative integer). */
  after?: number
}

/**
 * read_chunk_neighbors output item. `isTarget` is true only for the requested
 * target when it exists; `source` appears only on raw-data rows. `fileTitle`
 * mirrors `QueryResult` so results are drop-in with query_documents.
 */
export interface ReadChunkNeighborsResultItem {
  /** File path */
  filePath: string
  /** Chunk index */
  chunkIndex: number
  /** Text */
  text: string
  /** True iff this chunk's chunkIndex matches the requested target. */
  isTarget: boolean
  /** Original source (only for raw-data files, e.g., URLs ingested via ingest_data). */
  source?: string
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * sync_start tool input
 */
export interface SyncStartInput {
  /** Absolute path inside a configured root. Omitted means every configured root. */
  path?: string
}

/**
 * sync_status tool input
 */
export interface SyncStatusInput {
  /** Identifier returned by sync_start. */
  jobId: string
}

/**
 * Lifecycle of the one process-local sync job the server retains. There is no
 * cancelled, queued, or recovered state: the record lives only for the server
 * process and a new job replaces a terminal one.
 */
export type SyncJobState = 'running' | 'succeeded' | 'failed'

/**
 * Per-file outcome counters of a sync job. Structurally identical to the sync
 * core's counters, restated here because `server/` does not depend on
 * `features/`.
 */
export interface SyncSummary {
  /** Files re-ingested because they were new, changed, or stored inconsistently. */
  upserted: number
  /** Files whose stored content identity already matched the disk bytes. */
  skipped: number
  /** Present files that produced zero chunks; their prior rows and hash are kept. */
  empty: number
  /** Indexed files removed from the index. Counts files, not rows, and is outside `completed`. */
  pruned: number
}

/**
 * sync_status output — the whole pollable record for one job.
 *
 * `total` stays `null` until the scan has counted the disk files, and
 * `completed` never exceeds a non-null `total`. A job succeeds only when
 * `error` is `null`; a failure carries one message, naming the file when
 * the failure was per-file.
 */
export interface SyncStatusResult {
  jobId: string
  state: SyncJobState
  total: number | null
  completed: number
  summary: SyncSummary
  /**
   * Scanner coverage warnings, carried as JSON rather than as the content
   * blocks `list_files` uses, because status is a single pollable record.
   */
  warnings: string[]
  error: string | null
}
