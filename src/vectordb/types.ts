// VectorDB type definitions, constants, type guards, and error classes

import { AppError } from '../utils/errors.js'
import { MAX_VISUAL_RENDITION_BYTES } from '../utils/limits.js'
import { isInteger, isRecord } from '../utils/type-guards.js'

// ============================================
// Constants
// ============================================

/** Multiplier for candidate count in hybrid search (to allow reranking) */
export const HYBRID_SEARCH_CANDIDATE_MULTIPLIER = 2

/** FTS index name (bump version when changing tokenizer settings) */
export const FTS_INDEX_NAME = 'fts_index_v2'

/** Threshold for cleaning up old index versions (1 minute) */
export const FTS_CLEANUP_THRESHOLD_MS = 60 * 1000

/** Default hybrid-search weight (vector vs FTS blend) when not configured */
export const DEFAULT_HYBRID_WEIGHT = 0.6

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
 * Per-call options for {@link VectorStore.search}, an object so a new option
 * is not a breaking signature change.
 */
export interface SearchOptions {
  /** Optional query text for keyword boost (BM25) */
  queryText?: string
  /** Number of results to retrieve (default 10, valid range 1-20) */
  limit?: number
  /**
   * Optional path-prefix scope (exact-or-descendant, prefixes unioned). Omitted
   * = no prefilter (backward compatible).
   */
  scope?: string[]
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
 * Validated, bounded image stored in a chunk's ordered attachment JSON.
 */
export interface VisualAttachment {
  imageIndex: number
  mimeType: 'image/png' | 'image/jpeg'
  data: string
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
  /** SHA-256 of the source file bytes; absent for chunks not ingested from a file. */
  contentHash?: string
  /** Ordered `JSON.stringify(VisualAttachment[])`; omitted means no attachments. */
  visualAttachments?: string
  /** Ingestion timestamp (ISO 8601 format) */
  timestamp: string
}

/**
 * Search result
 */
export interface SearchResult {
  /** Stable persisted row identity used for attachment hydration. */
  id: string
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

/** Validated attachments for one persisted row, in visual order. */
export interface HydratedChunkAttachments {
  id: string
  attachments: VisualAttachment[]
}

/** Result of one final-identity hydration query. */
export interface AttachmentHydrationResult {
  rows: HydratedChunkAttachments[]
  omittedCount: number
}

/**
 * Row from {@link VectorStore.getChunksByRange}. Distinct from `SearchResult`:
 * no score (not ranked) and no metadata (not needed here).
 */
export interface ChunkRow {
  /** File path (absolute) */
  filePath: string
  /** Chunk index (zero-based) */
  chunkIndex: number
  /** Chunk text */
  text: string
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * Raw result from LanceDB query (internal type)
 */
export interface LanceDBRawResult {
  id: string
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
/** A non-null object with a numeric `length` — indices read as `unknown`. */
function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return isRecord(value) && typeof value['length'] === 'number'
}

/**
 * A non-numeric element is rejected, never repaired: coercing, dropping, or
 * padding it would change the vector's content or its dimension, and a
 * corrupted embedding shows up only as quietly worse search results.
 */
function toEmbeddingVector(value: unknown): number[] {
  if (!isArrayLike(value)) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (vector)')
  }
  const elements = Array.from(value)
  const vector: number[] = []
  for (const element of elements) {
    if (typeof element !== 'number') {
      throw new DatabaseError('Invalid chunk row shape from LanceDB (non-numeric vector element)')
    }
    vector.push(element)
  }
  return vector
}

function isDocumentMetadata(value: unknown): value is DocumentMetadata {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value['fileName'] === 'string' &&
    typeof value['fileSize'] === 'number' &&
    typeof value['fileType'] === 'string'
  )
}

/**
 * Type guard for LanceDB raw search result
 */
export function isLanceDBRawResult(value: unknown): value is LanceDBRawResult {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['filePath'] === 'string' &&
    typeof value['chunkIndex'] === 'number' &&
    typeof value['text'] === 'string' &&
    isDocumentMetadata(value['metadata'])
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
  // Vector rows carry `_distance`; `_score` is a defensive fallback for an
  // FTS-shaped row reaching here (the live FTS path reads `_score` directly in
  // applyKeywordBoost). The `?? 0` is unreachable in practice, and kept rather
  // than throwing — a missing score is not worth failing a whole search over.
  return {
    id: raw.id,
    filePath: raw.filePath,
    chunkIndex: raw.chunkIndex,
    text: raw.text,
    score: raw._distance ?? raw._score ?? 0,
    metadata: raw.metadata,
    fileTitle: raw.fileTitle || null,
  }
}

/**
 * Map a raw LanceDB row to a full {@link VectorChunk}, embedding included, so
 * it round-trips back through `insertChunks` — unlike {@link toChunkRow} and
 * {@link toSearchResult}, which drop the vector. LanceDB returns a typed array,
 * normalized here to `number[]`.
 */
export function toVectorChunk(raw: unknown): VectorChunk {
  if (!isRecord(raw)) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const {
    id,
    filePath,
    chunkIndex,
    text,
    vector,
    metadata,
    fileTitle,
    contentHash,
    visualAttachments,
    timestamp,
  } = raw
  if (
    typeof id !== 'string' ||
    typeof filePath !== 'string' ||
    typeof chunkIndex !== 'number' ||
    typeof text !== 'string' ||
    typeof timestamp !== 'string'
  ) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (scalar fields)')
  }
  if (!isDocumentMetadata(metadata)) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (metadata)')
  }
  return {
    id,
    filePath,
    chunkIndex,
    text,
    vector: toEmbeddingVector(vector),
    metadata,
    fileTitle: typeof fileTitle === 'string' && fileTitle.length > 0 ? fileTitle : null,
    // Omit the key rather than store '' or undefined: the create path seeds ''
    // for schema inference, and a '' that survived to a caller would read as a
    // real hash equal to nothing on disk.
    ...(typeof contentHash === 'string' && contentHash.length > 0 ? { contentHash } : {}),
    visualAttachments: normalizeVisualAttachments(visualAttachments),
    timestamp,
  }
}

/** Normalize only the defined legacy no-image sentinels; keep malformed JSON observable. */
export function normalizeVisualAttachments(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '[]'
}

const VISUAL_RENDITION_MAX_BASE64_LENGTH = Math.ceil(MAX_VISUAL_RENDITION_BYTES / 3) * 4

function decodeStrictBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > VISUAL_RENDITION_MAX_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : null
}

function isVisualAttachment(value: unknown): value is VisualAttachment {
  if (!isRecord(value)) {
    return false
  }
  const imageIndex = value['imageIndex']
  const mimeType = value['mimeType']
  if (
    !isInteger(imageIndex) ||
    imageIndex < 0 ||
    (mimeType !== 'image/png' && mimeType !== 'image/jpeg')
  ) {
    return false
  }
  const bytes = decodeStrictBase64(value['data'])
  if (!bytes || bytes.byteLength > MAX_VISUAL_RENDITION_BYTES) {
    return false
  }
  return mimeType === 'image/png'
    ? bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

/** Parse one persisted attachment cell while keeping malformed siblings observable. */
export function parseHydratedVisualAttachments(value: unknown): {
  attachments: VisualAttachment[]
  omittedCount: number
} {
  if (value === null || value === undefined || value === '' || value === '[]') {
    return { attachments: [], omittedCount: 0 }
  }
  if (typeof value !== 'string') {
    return { attachments: [], omittedCount: 1 }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { attachments: [], omittedCount: 1 }
  }
  if (!Array.isArray(parsed)) {
    return { attachments: [], omittedCount: 1 }
  }

  const attachments: VisualAttachment[] = []
  let omittedCount = 0
  for (const item of parsed) {
    if (!isVisualAttachment(item)) {
      omittedCount += 1
      continue
    }
    attachments.push({
      imageIndex: item.imageIndex,
      mimeType: item.mimeType,
      data: item.data,
    })
  }
  attachments.sort((left, right) => left.imageIndex - right.imageIndex)
  return { attachments, omittedCount }
}

/**
 * The minimal range-read shape: no score (not ranked) and no metadata (not
 * needed for index-adjacent retrieval), so the shape check is narrower than
 * {@link isLanceDBRawResult}. An empty or missing `fileTitle` reads as `null`.
 *
 * @throws DatabaseError when a required field is missing.
 */
export function toChunkRow(raw: unknown): ChunkRow {
  if (!isRecord(raw)) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const { filePath, chunkIndex, text } = raw
  if (typeof filePath !== 'string' || typeof chunkIndex !== 'number' || typeof text !== 'string') {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const rawFileTitle = raw['fileTitle']
  const fileTitle =
    typeof rawFileTitle === 'string' && rawFileTitle.length > 0 ? rawFileTitle : null
  return { filePath, chunkIndex, text, fileTitle }
}

// ============================================
// Error Classes
// ============================================

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, 'vectordb', 'internal', options)
    this.name = 'DatabaseError'
  }
}
