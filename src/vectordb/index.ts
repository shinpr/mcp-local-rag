// VectorStore implementation with LanceDB integration

import { type Connection, Index, type Table, connect } from '@lancedb/lancedb'
import { applyFileFilter, applyGrouping, applyKeywordBoost } from './search-filters.js'
import {
  DatabaseError,
  FTS_CLEANUP_THRESHOLD_MS,
  FTS_INDEX_NAME,
  HYBRID_SEARCH_CANDIDATE_MULTIPLIER,
  type SearchResult,
  type VectorChunk,
  type VectorStoreConfig,
  toSearchResult,
} from './types.js'

// Re-export public API
export type { GroupingMode, SearchResult, VectorChunk } from './types.js'

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

        // Ensure schema is up to date (add new columns for existing tables)
        await this.ensureSchemaVersion()
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
        // Note: LanceDB cannot infer Arrow type from null values, so we must
        // ensure fileTitle has a non-null sample value for schema inference.
        // Empty string is used as a placeholder; toSearchResult() normalizes
        // '' back to null on read for consistency with the migration path.
        const records = chunks.map((chunk) => {
          const record = chunk as unknown as Record<string, unknown>
          return {
            ...record,
            fileTitle: record['fileTitle'] ?? '',
          }
        })
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
   * Ensure schema is up to date by adding missing columns.
   * Uses table.addColumns() API for top-level column additions.
   * Idempotent: checks for column existence before adding.
   */
  private async ensureSchemaVersion(): Promise<void> {
    if (!this.table) {
      return
    }

    const schema = await this.table.schema()
    const hasFileTitle = schema.fields.some((f: { name: string }) => f.name === 'fileTitle')

    if (!hasFileTitle) {
      await this.table.addColumns([{ name: 'fileTitle', valueSql: 'cast(NULL as string)' }])
      console.error('VectorStore: Migrated schema - added fileTitle column')
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
        results = applyGrouping(results, this.config.grouping)
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

          results = applyKeywordBoost(results, ftsResults, hybridWeight)
        } catch (ftsError) {
          console.error('VectorStore: FTS search failed, using vector-only results:', ftsError)
          this.ftsEnabled = false
        }
      }

      // Step 4: Apply file filter after keyword boost
      // Unlike grouping (which depends on raw semantic distance gaps), maxFiles selects
      // the "most relevant files" — this should respect the final ranking including keyword boost
      if (this.config.maxFiles !== undefined && results.length > 0) {
        results = applyFileFilter(results, this.config.maxFiles)
      }

      // Return top results after all filtering and boosting
      return results.slice(0, limit)
    } catch (error) {
      throw new DatabaseError('Failed to search vectors', error as Error)
    }
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
