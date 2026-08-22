// VectorDB type definitions, constants, type guards, and error classes

import { AppError } from '../utils/errors.js'
import { BOUNDED_IMAGE_MAX_BYTES, parseBoundedImageStructure } from '../utils/image-structure.js'

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
 * Per-call options for {@link VectorStore.search}.
 * Grouped into an object (instead of positional params) so the caller can pass
 * any subset and so adding options (like `scope`) is not a breaking signature
 * change.
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

/** Persisted PDF image-storage state for one chunk row. */
export type ImageStorageVersion = 'none' | 'pdf-images-v1'

/**
 * Validated, bounded PDF rendition stored in a chunk's ordered attachment JSON.
 * Coordinates are normalized [x0, y0, x1, y1] values in the inclusive 0..1
 * page space, dimensions are positive integers with a maximum 1024 px long
 * edge, and data is strict standard base64 for the declared PNG/JPEG MIME.
 */
export interface VisualAttachment {
  pageNum: number
  visualIndex: number
  bbox: [number, number, number, number]
  mimeType: 'image/png' | 'image/jpeg'
  pixelWidth: number
  pixelHeight: number
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
  /** Ordered `JSON.stringify(VisualAttachment[])`; null means no attachments. */
  visualAttachments?: string | null
  /** Logical image-storage state; legacy omitted values normalize to `none`. */
  imageStorageVersion?: ImageStorageVersion
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

/** Persisted composite identity used only for final-result attachment hydration. */
export interface ChunkIdentity {
  filePath: string
  chunkIndex: number
}

/** Validated attachments for one requested final identity, in visual order. */
export interface HydratedChunkAttachments extends ChunkIdentity {
  attachments: VisualAttachment[]
}

/** Result of one final-identity hydration query. */
export interface AttachmentHydrationResult {
  rows: HydratedChunkAttachments[]
  omittedCount: number
  invalidIdentities: ChunkIdentity[]
}

/**
 * Row returned by VectorStore.getChunksByRange.
 * Distinct from SearchResult: no score (not a ranked result) and no metadata
 * (not needed for index-adjacent retrieval). Consumed by
 * handleReadChunkNeighbors and runReadNeighbors.
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
function isDocumentMetadata(value: unknown): value is DocumentMetadata {
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
  // Score source: vector search rows carry `_distance` (dot distance, the
  // normal path). `_score` is a defensive fallback for any FTS-shaped row that
  // reaches here (the live FTS path consumes `_score` directly in
  // applyKeywordBoost, not via this mapper). The final `?? 0` is an
  // effectively-unreachable guard: vectorSearch always returns `_distance`. It
  // is kept defensive rather than throwing, since a missing score is not worth
  // failing a whole search over.
  return {
    filePath: raw.filePath,
    chunkIndex: raw.chunkIndex,
    text: raw.text,
    score: raw._distance ?? raw._score ?? 0,
    metadata: raw.metadata,
    fileTitle: raw.fileTitle || null,
  }
}

/**
 * Map a raw LanceDB row to a full {@link VectorChunk}, including the stored
 * embedding vector and metadata. Used for backup/restore (ingest rollback),
 * where the row must round-trip back through `insertChunks` intact — unlike
 * {@link toChunkRow} / {@link toSearchResult}, which drop the vector. The
 * embedding is normalized to `number[]` (LanceDB returns a typed array).
 */
export function toVectorChunk(raw: unknown): VectorChunk {
  if (typeof raw !== 'object' || raw === null) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const obj = raw as Record<string, unknown>
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
    imageStorageVersion,
    timestamp,
  } = obj
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
  if (vector == null || typeof (vector as { length?: unknown }).length !== 'number') {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (vector)')
  }
  return {
    id,
    filePath,
    chunkIndex,
    text,
    vector: Array.from(vector as ArrayLike<number>),
    metadata,
    fileTitle: typeof fileTitle === 'string' && fileTitle.length > 0 ? fileTitle : null,
    // Omit the key rather than store '' or undefined: the create path seeds ''
    // for schema inference, and a '' that survived to a caller would read as a
    // real hash equal to nothing on disk.
    ...(typeof contentHash === 'string' && contentHash.length > 0 ? { contentHash } : {}),
    visualAttachments: normalizeVisualAttachments(visualAttachments),
    imageStorageVersion: normalizeImageStorageVersion(imageStorageVersion),
    timestamp,
  }
}

/** Normalize only the defined legacy no-image sentinels; keep malformed JSON observable. */
export function normalizeVisualAttachments(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value !== '[]' ? value : null
}

/** Normalize missing, nullable, empty, and unsupported legacy state to disabled. */
export function normalizeImageStorageVersion(value: unknown): ImageStorageVersion {
  return value === 'pdf-images-v1' ? 'pdf-images-v1' : 'none'
}

const VISUAL_RENDITION_LONG_EDGE_MAX = 1024
const VISUAL_RENDITION_MAX_BYTES = BOUNDED_IMAGE_MAX_BYTES
const VISUAL_RENDITION_MAX_BASE64_LENGTH = Math.ceil(VISUAL_RENDITION_MAX_BYTES / 3) * 4

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

function isValidNormalizedBbox(value: unknown): value is [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return false
  const [x0, y0, x1, y1] = value
  return x0 >= 0 && y0 >= 0 && x0 < x1 && y0 < y1 && x1 <= 1 && y1 <= 1
}

function isVisualAttachment(value: unknown): value is VisualAttachment {
  if (typeof value !== 'object' || value === null) return false
  const attachment = value as Partial<VisualAttachment>
  if (
    !Number.isInteger(attachment.pageNum) ||
    (attachment.pageNum as number) < 1 ||
    !Number.isInteger(attachment.visualIndex) ||
    (attachment.visualIndex as number) < 0 ||
    !isValidNormalizedBbox(attachment.bbox) ||
    (attachment.mimeType !== 'image/png' && attachment.mimeType !== 'image/jpeg') ||
    !Number.isInteger(attachment.pixelWidth) ||
    !Number.isInteger(attachment.pixelHeight) ||
    (attachment.pixelWidth as number) <= 0 ||
    (attachment.pixelHeight as number) <= 0 ||
    Math.max(attachment.pixelWidth as number, attachment.pixelHeight as number) >
      VISUAL_RENDITION_LONG_EDGE_MAX
  ) {
    return false
  }
  const bytes = decodeStrictBase64(attachment.data)
  if (!bytes || bytes.byteLength > VISUAL_RENDITION_MAX_BYTES) return false
  const dimensions = parseBoundedImageStructure(bytes, attachment.mimeType)
  return (
    dimensions !== null &&
    dimensions.width === attachment.pixelWidth &&
    dimensions.height === attachment.pixelHeight
  )
}

/** Parse one persisted attachment cell while keeping malformed siblings observable. */
export function parseHydratedVisualAttachments(value: unknown): {
  attachments: VisualAttachment[]
  omittedCount: number
} {
  if (value === null || value === undefined || value === '' || value === '[]') {
    return { attachments: [], omittedCount: 0 }
  }
  if (typeof value !== 'string') return { attachments: [], omittedCount: 1 }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { attachments: [], omittedCount: 1 }
  }
  if (!Array.isArray(parsed)) return { attachments: [], omittedCount: 1 }

  const attachments: VisualAttachment[] = []
  let omittedCount = 0
  for (const item of parsed) {
    if (isVisualAttachment(item)) attachments.push(item)
    else omittedCount += 1
  }
  attachments.sort((left, right) => left.visualIndex - right.visualIndex)
  return { attachments, omittedCount }
}

/**
 * Convert LanceDB raw row to ChunkRow with type validation.
 * Mirrors toSearchResult but returns the minimal range-read shape: no score
 * (not ranked) and no metadata (not needed for index-adjacent retrieval).
 *
 * Uses a narrower shape check than isLanceDBRawResult: only
 * filePath/chunkIndex/text are required because getChunksByRange
 * does not project metadata. The empty-string-or-missing fileTitle
 * is normalized to null per §Field Propagation Map.
 *
 * @throws DatabaseError if the raw row is missing required fields
 */
export function toChunkRow(raw: unknown): ChunkRow {
  if (typeof raw !== 'object' || raw === null) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const obj = raw as Record<string, unknown>
  if (
    typeof obj['filePath'] !== 'string' ||
    typeof obj['chunkIndex'] !== 'number' ||
    typeof obj['text'] !== 'string'
  ) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const rawFileTitle = obj['fileTitle']
  const fileTitle =
    typeof rawFileTitle === 'string' && rawFileTitle.length > 0 ? rawFileTitle : null
  return {
    filePath: obj['filePath'],
    chunkIndex: obj['chunkIndex'],
    text: obj['text'],
    fileTitle,
  }
}

// ============================================
// Error Classes
// ============================================

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'vectordb', 'internal', cause)
    this.name = 'DatabaseError'
  }
}
