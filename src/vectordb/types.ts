// VectorDB type definitions, constants, type guards, and error classes

// ============================================
// Constants
// ============================================

/** Multiplier for candidate count in hybrid search (to allow reranking) */
export const HYBRID_SEARCH_CANDIDATE_MULTIPLIER = 2

/** FTS index name (bump version when changing tokenizer settings) */
export const FTS_INDEX_NAME = 'fts_index_v2'

/** Threshold for cleaning up old index versions (1 minute) */
export const FTS_CLEANUP_THRESHOLD_MS = 60 * 1000

// ============================================
// Type Definitions
// ============================================

/**
 * Grouping mode for quality filtering
 * - 'similar': Only return the most similar group (stops at first distance jump)
 * - 'related': Include related groups (stops at second distance jump)
 */
export type GroupingMode = 'similar' | 'related'

/**
 * VectorStore configuration
 */
export interface VectorStoreConfig {
  /** LanceDB database path */
  dbPath: string
  /** Table name */
  tableName: string
  /** Maximum distance threshold for filtering results (optional) */
  maxDistance?: number
  /** Grouping mode for quality filtering (optional) */
  grouping?: GroupingMode
  /** Hybrid search weight for BM25 (0.0 = vector only, 1.0 = BM25 only, default 0.6) */
  hybridWeight?: number
  /** Maximum number of files to keep in results (optional, filters by best score per file) */
  maxFiles?: number
}

/**
 * Document metadata
 */
export interface DocumentMetadata {
  /** File name */
  fileName: string
  /** File size in bytes */
  fileSize: number
  /** File type (extension) */
  fileType: string
}

/**
 * Vector chunk
 */
export interface VectorChunk {
  /** Chunk ID (UUID) */
  id: string
  /** File path (absolute) */
  filePath: string
  /** Chunk index (zero-based) */
  chunkIndex: number
  /** Chunk text */
  text: string
  /** Embedding vector (dimension depends on model) */
  vector: number[]
  /** Metadata */
  metadata: DocumentMetadata
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
  /** Ingestion timestamp (ISO 8601 format) */
  timestamp: string
}

/**
 * Search result
 */
export interface SearchResult {
  /** File path */
  filePath: string
  /** Chunk index */
  chunkIndex: number
  /** Chunk text */
  text: string
  /** Distance score using dot product (0 = identical, 1 = orthogonal, 2 = opposite) */
  score: number
  /** Metadata */
  metadata: DocumentMetadata
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * Raw result from LanceDB query (internal type)
 */
export interface LanceDBRawResult {
  filePath: string
  chunkIndex: number
  text: string
  metadata: DocumentMetadata
  /** Document title (optional - existing rows lack this field before migration) */
  fileTitle?: string | null
  _distance?: number
  _score?: number
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard for DocumentMetadata
 */
export function isDocumentMetadata(value: unknown): value is DocumentMetadata {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['fileName'] === 'string' &&
    typeof obj['fileSize'] === 'number' &&
    typeof obj['fileType'] === 'string'
  )
}

/**
 * Type guard for LanceDB raw search result
 */
export function isLanceDBRawResult(value: unknown): value is LanceDBRawResult {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['filePath'] === 'string' &&
    typeof obj['chunkIndex'] === 'number' &&
    typeof obj['text'] === 'string' &&
    isDocumentMetadata(obj['metadata'])
  )
}

/**
 * Convert LanceDB raw result to SearchResult with type validation
 * @throws DatabaseError if the result is invalid
 */
export function toSearchResult(raw: unknown): SearchResult {
  if (!isLanceDBRawResult(raw)) {
    throw new DatabaseError('Invalid search result format from LanceDB')
  }
  return {
    filePath: raw.filePath,
    chunkIndex: raw.chunkIndex,
    text: raw.text,
    score: raw._distance ?? raw._score ?? 0,
    metadata: raw.metadata,
    fileTitle: raw.fileTitle ?? null,
  }
}

// ============================================
// Error Classes
// ============================================

/**
 * Database error
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'DatabaseError'
  }
}
