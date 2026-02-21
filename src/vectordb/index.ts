// VectorStore implementation with LanceDB integration

import { type Connection, Index, type Table, connect } from '@lancedb/lancedb'

// ============================================
// Constants
// ============================================

/**
 * Standard deviation multiplier for detecting group boundaries.
 * A gap is considered a "boundary" if it exceeds mean + k*std.
 * Value of 1.5 means gaps > 1.5 standard deviations above mean are boundaries.
 */
const GROUPING_BOUNDARY_STD_MULTIPLIER = 1.5

/** Multiplier for candidate count in hybrid search (to allow reranking) */
const HYBRID_SEARCH_CANDIDATE_MULTIPLIER = 2

/** FTS index name (bump version when changing tokenizer settings) */
const FTS_INDEX_NAME = 'fts_index_v2'

/** Threshold for cleaning up old index versions (1 minute) */
const FTS_CLEANUP_THRESHOLD_MS = 60 * 1000

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
interface VectorStoreConfig {
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
interface DocumentMetadata {
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
  /** Ingestion timestamp (ISO 8601 format) */
  timestamp: string
}

/**
 * Search result
 */
interface SearchResult {
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
}

/**
 * Raw result from LanceDB query (internal type)
 */
interface LanceDBRawResult {
  filePath: string
  chunkIndex: number
  text: string
  metadata: DocumentMetadata
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
function isLanceDBRawResult(value: unknown): value is LanceDBRawResult {
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
function toSearchResult(raw: unknown): SearchResult {
  if (!isLanceDBRawResult(raw)) {
    throw new DatabaseError('Invalid search result format from LanceDB')
  }
  return {
    filePath: raw.filePath,
    chunkIndex: raw.chunkIndex,
    text: raw.text,
    score: raw._distance ?? raw._score ?? 0,
    metadata: raw.metadata,
  }
}

// ============================================
// Error Classes
// ============================================

/**
 * Database error
 */
class DatabaseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'DatabaseError'
  }
}

// ============================================
// VectorStore Class
// ============================================

/**
 * Vector storage class using LanceDB
 *
 * Responsibilities:
 * - LanceDB operations (insert, delete, search)
 * - Transaction handling (atomicity of delete→insert)
 * - Metadata management
 */
export class VectorStore {
  private db: Connection | null = null
  private table: Table | null = null
  private readonly config: VectorStoreConfig
  private ftsEnabled = false

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  /**
   * Initialize LanceDB and create table
   */
  async initialize(): Promise<void> {
    try {
      // Connect to LanceDB
      this.db = await connect(this.config.dbPath)

      // Check table existence and create if needed
      const tableNames = await this.db.tableNames()
      if (tableNames.includes(this.config.tableName)) {
        // Open existing table
        this.table = await this.db.openTable(this.config.tableName)
        console.error(`VectorStore: Opened existing table "${this.config.tableName}"`)

        // Ensure FTS index exists (migration for existing databases)
        await this.ensureFtsIndex()
      } else {
        // Create new table (schema auto-defined on first data insertion)
        console.error(
          `VectorStore: Table "${this.config.tableName}" will be created on first data insertion`
        )
      }

      console.error(`VectorStore initialized: ${this.config.dbPath}`)
    } catch (error) {
      throw new DatabaseError('Failed to initialize VectorStore', error as Error)
    }
  }

  /**
   * Delete all chunks for specified file path
   *
   * @param filePath - File path (absolute)
   */
  async deleteChunks(filePath: string): Promise<void> {
    if (!this.table) {
      // If table doesn't exist, no deletion targets, return normally
      console.error('VectorStore: Skipping deletion as table does not exist')
      return
    }

    try {
      // Use LanceDB delete API to remove records matching filePath
      // Escape single quotes to prevent SQL injection
      const escapedFilePath = filePath.replace(/'/g, "''")

      // LanceDB's delete method doesn't throw errors if targets don't exist,
      // so call delete directly
      // Note: Field names are case-sensitive, use backticks for camelCase fields
      await this.table.delete(`\`filePath\` = '${escapedFilePath}'`)
      console.error(`VectorStore: Deleted chunks for file "${filePath}"`)

      // Rebuild FTS index after deleting data
      await this.rebuildFtsIndex()
    } catch (error) {
      // If error occurs, output warning log
      console.warn(`VectorStore: Error occurred while deleting file "${filePath}":`, error)
      // Don't treat as error if deletion targets don't exist or table is empty
      // Otherwise throw exception
      const errorMessage = (error as Error).message.toLowerCase()
      if (
        !errorMessage.includes('not found') &&
        !errorMessage.includes('does not exist') &&
        !errorMessage.includes('no matching')
      ) {
        throw new DatabaseError(`Failed to delete chunks for file: ${filePath}`, error as Error)
      }
    }
  }

  /**
   * Batch insert vector chunks
   *
   * @param chunks - Array of vector chunks
   */
  async insertChunks(chunks: VectorChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return
    }

    try {
      if (!this.table) {
        // Create table on first insertion
        if (!this.db) {
          throw new DatabaseError('VectorStore is not initialized. Call initialize() first.')
        }
        // LanceDB's createTable API accepts data as Record<string, unknown>[]
        const records = chunks.map((chunk) => chunk as unknown as Record<string, unknown>)
        this.table = await this.db.createTable(this.config.tableName, records)
        console.error(`VectorStore: Created table "${this.config.tableName}"`)

        // Create FTS index for hybrid search
        await this.ensureFtsIndex()
      } else {
        // Add data to existing table
        const records = chunks.map((chunk) => chunk as unknown as Record<string, unknown>)
        await this.table.add(records)

        // Rebuild FTS index after adding new data
        await this.rebuildFtsIndex()
      }

      console.error(`VectorStore: Inserted ${chunks.length} chunks`)
    } catch (error) {
      throw new DatabaseError('Failed to insert chunks', error as Error)
    }
  }

  /**
   * Ensure FTS index exists for hybrid search
   * Creates ngram-based index if it doesn't exist, drops old versions
   * @throws DatabaseError if index creation fails (Fail-Fast principle)
   */
  private async ensureFtsIndex(): Promise<void> {
    if (!this.table) {
      return
    }

    // Check existing indices
    const indices = await this.table.listIndices()
    const existingFtsIndices = indices.filter((idx) => idx.indexType === 'FTS')
    const hasExpectedIndex = existingFtsIndices.some((idx) => idx.name === FTS_INDEX_NAME)

    if (hasExpectedIndex) {
      this.ftsEnabled = true
      return
    }

    // Create new FTS index with ngram tokenizer for multilingual support
    // - min=2: Capture Japanese bi-grams (e.g., "東京", "設計")
    // - max=3: Balance between precision and index size
    // - prefixOnly=false: Generate ngrams from all positions for proper CJK support
    await this.table.createIndex('text', {
      config: Index.fts({
        baseTokenizer: 'ngram',
        ngramMinLength: 2,
        ngramMaxLength: 3,
        prefixOnly: false,
        stem: false,
      }),
      name: FTS_INDEX_NAME,
    })
    this.ftsEnabled = true
    console.error(`VectorStore: FTS index "${FTS_INDEX_NAME}" created successfully`)

    // Drop old FTS indices
    for (const idx of existingFtsIndices) {
      if (idx.name !== FTS_INDEX_NAME) {
        await this.table.dropIndex(idx.name)
        console.error(`VectorStore: Dropped old FTS index "${idx.name}"`)
      }
    }
  }

  /**
   * Rebuild FTS index after data changes (insert/delete)
   * LanceDB OSS requires explicit optimize() call to update FTS index
   * Also cleans up old index versions to prevent storage bloat
   */
  private async rebuildFtsIndex(): Promise<void> {
    if (!this.table || !this.ftsEnabled) {
      return
    }

    // Optimize table and clean up old versions
    const cleanupThreshold = new Date(Date.now() - FTS_CLEANUP_THRESHOLD_MS)
    await this.table.optimize({ cleanupOlderThan: cleanupThreshold })
  }

  /**
   * Apply grouping algorithm to filter results by detecting group boundaries.
   *
   * Uses statistical threshold (mean + k*std) to identify significant gaps (group boundaries).
   * - 'similar': Returns only the first group (cuts at first boundary)
   * - 'related': Returns up to 2 groups (cuts at second boundary)
   *
   * @param results - Search results sorted by distance (ascending)
   * @param mode - Grouping mode ('similar' = 1 group, 'related' = 2 groups)
   * @returns Filtered results
   */
  private applyGrouping(results: SearchResult[], mode: GroupingMode): SearchResult[] {
    if (results.length <= 1) return results

    // Calculate gaps between consecutive results with their indices
    const gaps: { index: number; gap: number }[] = []
    for (let i = 0; i < results.length - 1; i++) {
      const current = results[i]
      const next = results[i + 1]
      if (current !== undefined && next !== undefined) {
        gaps.push({ index: i + 1, gap: next.score - current.score })
      }
    }

    if (gaps.length === 0) return results

    // Calculate statistical threshold to identify significant gaps (group boundaries)
    const gapValues = gaps.map((g) => g.gap)
    const mean = gapValues.reduce((a, b) => a + b, 0) / gapValues.length
    const variance = gapValues.reduce((a, b) => a + (b - mean) ** 2, 0) / gapValues.length
    const std = Math.sqrt(variance)
    const threshold = mean + GROUPING_BOUNDARY_STD_MULTIPLIER * std

    // Find all significant gaps (group boundaries)
    const boundaries = gaps.filter((g) => g.gap > threshold).map((g) => g.index)

    // If no boundaries found, return all results
    if (boundaries.length === 0) return results

    // Determine how many groups to include based on mode
    // 'similar': 1 group (cut at first boundary)
    // 'related': 2 groups (cut at second boundary, or return all if only 1 boundary)
    const groupsToInclude = mode === 'similar' ? 1 : 2
    const boundaryIndex = groupsToInclude - 1

    // If we don't have enough boundaries, return all results for 'related' mode
    if (boundaryIndex >= boundaries.length) {
      return mode === 'related' ? results : results.slice(0, boundaries[0])
    }

    // Cut at the appropriate boundary
    return results.slice(0, boundaries[boundaryIndex])
  }

  /**
   * Apply file-based filter to limit results to chunks from the top N files.
   *
   * Ranks files by their best (lowest distance) chunk score and keeps only
   * chunks belonging to the top `maxFiles` files.
   *
   * @param results - Search results sorted by distance (ascending)
   * @param maxFiles - Maximum number of files to keep
   * @returns Filtered results preserving original order
   */
  private applyFileFilter(results: SearchResult[], maxFiles: number): SearchResult[] {
    if (results.length === 0) return results

    // Find the best (lowest) score per file
    const fileScores = new Map<string, number>()
    for (const result of results) {
      const current = fileScores.get(result.filePath)
      if (current === undefined || result.score < current) {
        fileScores.set(result.filePath, result.score)
      }
    }

    // If we have fewer or equal files than maxFiles, return all
    if (fileScores.size <= maxFiles) return results

    // Sort files by best score (ascending) and take top N
    const topFiles = new Set(
      [...fileScores.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, maxFiles)
        .map(([filePath]) => filePath)
    )

    // Filter results to only include chunks from top files
    return results.filter((result) => topFiles.has(result.filePath))
  }

  /**
   * Execute vector search with quality filtering
   * Architecture: Semantic search → Filter (maxDistance, grouping) → Keyword boost → File filter (maxFiles)
   *
   * This "prefetch then rerank" approach ensures:
   * - maxDistance and grouping work on meaningful vector distances
   * - Keyword matching acts as a boost, not a replacement for semantic similarity
   *
   * @param queryVector - Query vector (dimension depends on model)
   * @param queryText - Optional query text for keyword boost (BM25)
   * @param limit - Number of results to retrieve (default 10)
   * @returns Array of search results (sorted by distance ascending, filtered by quality settings)
   */
  async search(queryVector: number[], queryText?: string, limit = 10): Promise<SearchResult[]> {
    if (!this.table) {
      console.error('VectorStore: Returning empty results as table does not exist')
      return []
    }

    if (limit < 1 || limit > 20) {
      throw new DatabaseError(`Invalid limit: expected 1-20, got ${limit}`)
    }

    try {
      // Step 1: Semantic (vector) search - always the primary search
      const candidateLimit = limit * HYBRID_SEARCH_CANDIDATE_MULTIPLIER
      let query = this.table.vectorSearch(queryVector).distanceType('dot').limit(candidateLimit)

      // Apply distance threshold at query level
      if (this.config.maxDistance !== undefined) {
        query = query.distanceRange(undefined, this.config.maxDistance)
      }

      const vectorResults = await query.toArray()

      // Convert to SearchResult format with type validation
      let results: SearchResult[] = vectorResults.map((result) => toSearchResult(result))

      // Step 2: Apply grouping filter on vector distances (before keyword boost)
      // Grouping is meaningful only on semantic distances, not after keyword boost
      if (this.config.grouping && results.length > 1) {
        results = this.applyGrouping(results, this.config.grouping)
      }

      // Step 3: Apply keyword boost if enabled
      const hybridWeight = this.config.hybridWeight ?? 0.6
      if (this.ftsEnabled && queryText && queryText.trim().length > 0 && hybridWeight > 0) {
        try {
          // Get unique filePaths from vector results to filter FTS search
          const uniqueFilePaths = [...new Set(results.map((r) => r.filePath))]

          // Build WHERE clause with IN for targeted FTS search
          // Use backticks for column name (required for camelCase in LanceDB)
          const escapedPaths = uniqueFilePaths.map((p) => `'${p.replace(/'/g, "''")}'`)
          const whereClause = `\`filePath\` IN (${escapedPaths.join(', ')})`

          const ftsResults = await this.table
            .search(queryText, 'fts', 'text')
            .where(whereClause)
            .select(['filePath', 'chunkIndex', 'text', 'metadata', '_score'])
            .limit(results.length * 2) // Enough to cover all vector results
            .toArray()

          results = this.applyKeywordBoost(results, ftsResults, hybridWeight)
        } catch (ftsError) {
          console.error('VectorStore: FTS search failed, using vector-only results:', ftsError)
          this.ftsEnabled = false
        }
      }

      // Step 4: Apply file filter after keyword boost
      // Unlike grouping (which depends on raw semantic distance gaps), maxFiles selects
      // the "most relevant files" — this should respect the final ranking including keyword boost
      if (this.config.maxFiles !== undefined && results.length > 0) {
        results = this.applyFileFilter(results, this.config.maxFiles)
      }

      // Return top results after all filtering and boosting
      return results.slice(0, limit)
    } catch (error) {
      throw new DatabaseError('Failed to search vectors', error as Error)
    }
  }

  /**
   * Apply keyword boost to rerank vector search results
   * Uses multiplicative formula: final_distance = distance / (1 + keyword_normalized * weight)
   *
   * This proportional boost ensures:
   * - Keyword matches improve ranking without dominating semantic similarity
   * - Documents without keyword matches keep their original vector distance
   * - Higher weight = stronger influence of keyword matching
   *
   * @param vectorResults - Results from vector search (already filtered by maxDistance/grouping)
   * @param ftsResults - Raw FTS results with BM25 scores
   * @param weight - Boost weight (0-1, from hybridWeight config)
   */
  private applyKeywordBoost(
    vectorResults: SearchResult[],
    ftsResults: Record<string, unknown>[],
    weight: number
  ): SearchResult[] {
    // Build FTS score map with normalized scores (0-1)
    let maxBm25Score = 0
    for (const result of ftsResults) {
      if (!result) continue
      const score = (result['_score'] as number) ?? 0
      if (score > maxBm25Score) maxBm25Score = score
    }

    const ftsScoreMap = new Map<string, number>()
    for (const result of ftsResults) {
      if (!result) continue
      const key = `${result['filePath']}:${result['chunkIndex']}`
      const rawScore = (result['_score'] as number) ?? 0
      const normalized = maxBm25Score > 0 ? rawScore / maxBm25Score : 0
      ftsScoreMap.set(key, normalized)
    }

    // Apply multiplicative boost to vector results
    const boostedResults = vectorResults.map((result) => {
      const key = `${result.filePath}:${result.chunkIndex}`
      const keywordScore = ftsScoreMap.get(key) ?? 0

      // Multiplicative boost: distance / (1 + keyword * weight)
      // - If keyword matches (score=1) and weight=1: distance halved
      // - If no keyword match (score=0): distance unchanged
      const boostedDistance = result.score / (1 + keywordScore * weight)

      return {
        ...result,
        score: boostedDistance,
      }
    })

    // Re-sort by boosted distance (ascending = better)
    return boostedResults.sort((a, b) => a.score - b.score)
  }

  /**
   * Get list of ingested files
   *
   * @returns Array of file information
   */
  async listFiles(): Promise<{ filePath: string; chunkCount: number; timestamp: string }[]> {
    if (!this.table) {
      return [] // Return empty array if table doesn't exist
    }

    try {
      // Retrieve all records
      const allRecords = await this.table.query().toArray()

      // Group by file path
      const fileMap = new Map<string, { chunkCount: number; timestamp: string }>()

      for (const record of allRecords) {
        const filePath = record.filePath as string
        const timestamp = record.timestamp as string

        if (fileMap.has(filePath)) {
          const fileInfo = fileMap.get(filePath)
          if (fileInfo) {
            fileInfo.chunkCount += 1
            // Keep most recent timestamp
            if (timestamp > fileInfo.timestamp) {
              fileInfo.timestamp = timestamp
            }
          }
        } else {
          fileMap.set(filePath, { chunkCount: 1, timestamp })
        }
      }

      // Convert Map to array of objects
      return Array.from(fileMap.entries()).map(([filePath, info]) => ({
        filePath,
        chunkCount: info.chunkCount,
        timestamp: info.timestamp,
      }))
    } catch (error) {
      throw new DatabaseError('Failed to list files', error as Error)
    }
  }

  /**
   * Get system status
   *
   * @returns System status information
   */
  async getStatus(): Promise<{
    documentCount: number
    chunkCount: number
    memoryUsage: number
    uptime: number
    ftsIndexEnabled: boolean
    searchMode: 'hybrid' | 'vector-only'
  }> {
    if (!this.table) {
      return {
        documentCount: 0,
        chunkCount: 0,
        memoryUsage: 0,
        uptime: process.uptime(),
        ftsIndexEnabled: false,
        searchMode: 'vector-only',
      }
    }

    try {
      // Retrieve all records
      const allRecords = await this.table.query().toArray()
      const chunkCount = allRecords.length

      // Count unique file paths
      const uniqueFilePaths = new Set(allRecords.map((record) => record.filePath as string))
      const documentCount = uniqueFilePaths.size

      // Get memory usage (in MB)
      const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024

      // Get uptime (in seconds)
      const uptime = process.uptime()

      return {
        documentCount,
        chunkCount,
        memoryUsage,
        uptime,
        ftsIndexEnabled: this.ftsEnabled,
        searchMode:
          this.ftsEnabled && (this.config.hybridWeight ?? 0.6) > 0 ? 'hybrid' : 'vector-only',
      }
    } catch (error) {
      throw new DatabaseError('Failed to get status', error as Error)
    }
  }
}
