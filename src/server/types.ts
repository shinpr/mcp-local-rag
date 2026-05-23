// Type definitions for RAGServer

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
  /** Configuration validation warnings to surface to users via MCP annotations */
  configWarnings?: string[]
  /**
   * Structured base-dirs resolution error. When present, the server is in
   * degraded mode: `status` remains callable so the user can diagnose the
   * problem via MCP, while root-dependent tools surface the error (handled
   * in P3-T3). See `resolveBaseDirs` for the error semantics.
   */
  configError?: BaseDirsConfigError
}

/**
 * RAGServer configuration.
 *
 * Accepts either a single `baseDir` (legacy shape — preserved so existing
 * direct callers and tests that pass `{ baseDir }` continue to work) or
 * `baseDirs` (multi-root shape produced by `resolveBaseDirs`). Exactly one
 * of the two MUST be supplied. The constructor normalizes both into a single
 * `baseDirs: string[]` internally and derives the legacy `baseDir` accessor
 * as `baseDirs[0]`.
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
}

/**
 * ingest_file tool input
 */
export interface IngestFileInput {
  /** File path */
  filePath: string
  /**
   * When true and `filePath` is a PDF, the visual enrichment path runs
   * (VLM captioning of figure-heavy pages). For non-PDF files this flag is
   * silently coerced to the default text-only path (AC-006). The runtime
   * check at the handler boundary stays in place because MCP arguments
   * arrive as `unknown` from the SDK (AC-012).
   */
  visual?: boolean
  /**
   * Visual-quality profile when `visual` is true. Some MCP clients send the
   * empty string for unspecified optional parameters, so the boundary
   * handler also accepts `""` and normalizes it to `'fast'`. The internal
   * `QualityProfile` type stays narrow (`'fast' | 'quality'`); `""` does
   * not propagate past `handleIngestFile`.
   */
  visualQuality?: 'fast' | 'quality' | ''
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
export interface DeleteFileInput {
  /** File path (for files ingested via ingest_file) */
  filePath?: string
  /** Source identifier (for data ingested via ingest_data) */
  source?: string
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
 * list_files tool output — entry for a file found in BASE_DIR
 */
export type FileEntry =
  | { filePath: string; ingested: true; chunkCount: number; timestamp: string }
  | { filePath: string; ingested: false }

/**
 * list_files tool output — entry for content ingested via ingest_data,
 * or an orphaned DB entry whose file no longer exists on disk
 */
export type SourceEntry =
  | { source: string; chunkCount: number; timestamp: string }
  | { filePath: string; chunkCount: number; timestamp: string }

/**
 * list_files tool output
 */
export interface ListFilesResult {
  baseDir: string
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
export interface ReadChunkNeighborsInput {
  /** File path (for files ingested via ingest_file). Absolute path required. */
  filePath?: string
  /** Source identifier (for data ingested via ingest_data). */
  source?: string
  /** Target chunk index (zero-based, required, non-negative integer) (AC-010). */
  chunkIndex: number
  /** Number of chunks before the target to include (default 2, non-negative integer) (AC-009). */
  before?: number
  /** Number of chunks after the target to include (default 2, non-negative integer) (AC-009). */
  after?: number
}

/**
 * read_chunk_neighbors tool output item.
 * Core fields {filePath, chunkIndex, text} per AC-002.
 * isTarget per AC-019 (exactly one true when target exists; else all false).
 * source per AC-020 (present on raw-data rows only).
 * fileTitle mirrors QueryResult for drop-in consistency with query_documents results.
 */
export interface ReadChunkNeighborsResultItem {
  /** File path */
  filePath: string
  /** Chunk index */
  chunkIndex: number
  /** Text */
  text: string
  /** True iff this chunk's chunkIndex matches the requested target (AC-019) */
  isTarget: boolean
  /** Original source (only for raw-data files, e.g., URLs ingested via ingest_data) (AC-020) */
  source?: string
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}
