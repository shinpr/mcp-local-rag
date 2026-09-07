// VectorStore implementation with LanceDB integration

import { type Connection, connect, Index, type Table } from '@lancedb/lancedb'
import { toError } from '../utils/errors.js'
import { MAX_QUERY_LIMIT, MIN_QUERY_LIMIT } from '../utils/limits.js'
import { normalizeScopePrefix } from '../utils/scope-match.js'
import { applyFileFilter, applyGrouping, applyKeywordBoost } from './search-filters.js'
import {
  type AttachmentHydrationResult,
  type ChunkRow,
  DatabaseError,
  DEFAULT_HYBRID_WEIGHT,
  FTS_CLEANUP_THRESHOLD_MS,
  FTS_INDEX_NAME,
  HYBRID_SEARCH_CANDIDATE_MULTIPLIER,
  normalizeVisualAttachments,
  parseHydratedVisualAttachments,
  type SearchOptions,
  type SearchResult,
  toChunkRow,
  toSearchResult,
  toVectorChunk,
  type VectorChunk,
  type VectorStoreConfig,
} from './types.js'

// Re-export public API
export type {
  AttachmentHydrationResult,
  GroupingMode,
  HydratedChunkAttachments,
  SearchResult,
  VectorChunk,
  VisualAttachment,
} from './types.js'

// ============================================
// VectorStore Class
// ============================================

/** Vector storage over LanceDB, including the delete-then-insert atomicity. */
export class VectorStore {
  private db: Connection | null = null
  private table: Table | null = null
  private openingTable: Promise<void> | null = null
  private readonly config: VectorStoreConfig
  private ftsEnabled: boolean = false

  constructor(config: VectorStoreConfig) {
    this.config = config
  }

  /**
   * Initialize LanceDB and create table
   */
  async initialize(): Promise<void> {
    try {
      // Connect to LanceDB
      // readConsistencyInterval: 0 ensures every read checks for external changes.
      // Without this, a cached Table object becomes stale when another process
      // (e.g., CLI ingestion from a different terminal) modifies the database,
      // causing "Failed to search vectors" errors until restart.
      this.db = await connect(this.config.dbPath, { readConsistencyInterval: 0 })

      await this.openExistingTable()

      console.error(`VectorStore initialized: ${this.config.dbPath}`)
    } catch (error) {
      throw new DatabaseError('Failed to initialize VectorStore', { cause: toError(error) })
    }
  }

  /** Discover a table created after this connection was initialized. */
  private async openExistingTable(): Promise<void> {
    if (this.openingTable !== null) {
      return this.openingTable
    }
    if (this.table || !this.db) {
      return
    }
    const db = this.db
    this.openingTable = (async (): Promise<void> => {
      try {
        if (!(await db.tableNames()).includes(this.config.tableName)) {
          return
        }
        this.table = await db.openTable(this.config.tableName)
        await this.ensureFtsIndex()
        await this.ensureSchemaVersion()
      } catch (error) {
        this.table = null
        this.ftsEnabled = false
        throw new DatabaseError('Failed to open existing table', { cause: toError(error) })
      }
    })()
    try {
      await this.openingTable
    } finally {
      this.openingTable = null
    }
  }

  /** @returns the number of chunks removed; 0 when nothing matched. */
  async deleteChunks(filePath: string): Promise<number> {
    await this.openExistingTable()
    if (!this.table) {
      // If table doesn't exist, no deletion targets, return normally
      console.error('VectorStore: Skipping deletion as table does not exist')
      return 0
    }

    try {
      // Use LanceDB delete API to remove records matching filePath.
      // Escape single quotes to prevent SQL injection.
      // Note: Field names are case-sensitive, use backticks for camelCase fields.
      const escapedFilePath = filePath.replace(/'/g, "''")
      // delete() reports the authoritative removed count (numDeletedRows) from
      // the same operation, so the total stays correct under concurrent deletes
      // and we avoid a second pre-count query that materializes matching rows.
      const { numDeletedRows } = await this.table.delete(`\`filePath\` = '${escapedFilePath}'`)
      console.error(`VectorStore: Deleted ${numDeletedRows} chunks for file "${filePath}"`)
      return numDeletedRows
    } catch (error) {
      // LanceDB's delete resolves normally when nothing matched, so reaching
      // this catch means a genuine failure. Propagate rather than swallowing by
      // error-message matching, which broke silently across LanceDB versions.
      console.warn(`VectorStore: Error occurred while deleting file "${filePath}":`, error)
      throw new DatabaseError(`Failed to delete chunks for file: ${filePath}`, {
        cause: toError(error),
      })
    }
  }

  /**
   * Chunk rows for one file with chunkIndex in the inclusive [minIdx, maxIdx]
   * range. The ascending sort is a contract, not incidental storage order.
   *
   * Feature-agnostic: before/after/isTarget semantics live in the handler.
   */
  async getChunksByRange(filePath: string, minIdx: number, maxIdx: number): Promise<ChunkRow[]> {
    await this.openExistingTable()
    if (!this.table) {
      console.error('VectorStore: Skipping range read as table does not exist')
      return []
    }

    if (!Number.isInteger(minIdx) || !Number.isInteger(maxIdx) || minIdx < 0 || maxIdx < minIdx) {
      throw new DatabaseError(
        'getChunksByRange requires non-negative integer range bounds with minIdx <= maxIdx'
      )
    }

    try {
      // Escape single quotes to prevent SQL injection (mirrors deleteChunks)
      const escapedFilePath = filePath.replace(/'/g, "''")
      // Backtick-quoted camelCase columns; numeric literals unquoted
      const predicate = `\`filePath\` = '${escapedFilePath}' AND \`chunkIndex\` >= ${minIdx} AND \`chunkIndex\` <= ${maxIdx}`

      const raw = await this.table
        .query()
        .where(predicate)
        .select(['filePath', 'chunkIndex', 'text', 'fileTitle'])
        .toArray()
      const rows = raw.map((row) => toChunkRow(row))
      // Contractual ascending sort; do not rely on storage order.
      rows.sort((a, b) => a.chunkIndex - b.chunkIndex)
      return rows
    } catch (error) {
      throw new DatabaseError('Failed to read chunks by range', { cause: toError(error) })
    }
  }

  /**
   * Every stored chunk for a file as a full {@link VectorChunk}, embedding
   * included, so it can be re-inserted verbatim. The ingest handler backs data
   * up with this before a destructive re-ingest, so a failure rolls back
   * without corrupting vectors.
   */
  async getChunksByFilePath(filePath: string): Promise<VectorChunk[]> {
    await this.openExistingTable()
    if (!this.table) {
      return []
    }
    try {
      // Escape single quotes to prevent SQL injection (mirrors deleteChunks)
      const escapedFilePath = filePath.replace(/'/g, "''")
      const raw = await this.table.query().where(`\`filePath\` = '${escapedFilePath}'`).toArray()
      return raw.map((row) => toVectorChunk(row))
    } catch (error) {
      throw new DatabaseError(`Failed to read chunks for file: ${filePath}`, {
        cause: toError(error),
      })
    }
  }

  /**
   * Batch insert vector chunks
   */
  async insertChunks(chunks: VectorChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return
    }

    try {
      await this.openExistingTable()
      if (!this.table) {
        // Create table on first insertion
        if (!this.db) {
          throw new DatabaseError('VectorStore is not initialized. Call initialize() first.')
        }
        // LanceDB's createTable API accepts data as Record<string, unknown>[]
        // Note: LanceDB cannot infer Arrow type from null/absent values, so the
        // nullable string columns need a non-null sample value for schema
        // inference. The read converters normalize each placeholder back to
        // its logical no-value state, matching what migration produces.
        const records = chunks.map((chunk) => ({
          ...chunk,
          fileTitle: chunk.fileTitle ?? '',
          contentHash: chunk.contentHash ?? '',
          visualProfile: chunk.visualProfile ?? '',
          visualAttachments: normalizeVisualAttachments(chunk.visualAttachments),
        }))
        this.table = await this.db.createTable(this.config.tableName, records)
        console.error(`VectorStore: Created table "${this.config.tableName}"`)

        // Create FTS index for hybrid search
        await this.ensureFtsIndex()
      } else {
        // Add data to existing table
        // An explicit `null` rather than an omitted key: `add` builds its batch
        // from the supplied properties, so omission on an optional column is not
        // a reliable way to write "no value".
        const records = chunks.map((chunk) => ({
          ...chunk,
          visualProfile: chunk.visualProfile ?? null,
          visualAttachments: normalizeVisualAttachments(chunk.visualAttachments),
        }))
        await this.table.add(records)
      }

      console.error(`VectorStore: Inserted ${chunks.length} chunks`)
    } catch (error) {
      throw new DatabaseError('Failed to insert chunks', { cause: toError(error) })
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
    const hasField = (name: string): boolean =>
      schema.fields.some((f: { name: string }) => f.name === name)

    if (!hasField('fileTitle')) {
      await this.table.addColumns([{ name: 'fileTitle', valueSql: 'cast(NULL as string)' }])
      console.error('VectorStore: Migrated schema - added fileTitle column')
    }

    if (!hasField('contentHash')) {
      await this.table.addColumns([{ name: 'contentHash', valueSql: 'cast(NULL as string)' }])
      console.error('VectorStore: Migrated schema - added contentHash column')
    }

    if (!hasField('visualAttachments')) {
      await this.table.addColumns([{ name: 'visualAttachments', valueSql: 'cast(NULL as string)' }])
      console.error('VectorStore: Migrated schema - added visualAttachments column')
    }

    if (!hasField('visualProfile')) {
      await this.table.addColumns([{ name: 'visualProfile', valueSql: 'cast(NULL as string)' }])
      console.error('VectorStore: Migrated schema - added visualProfile column')
    }
  }

  /**
   * Compact fragments, update the FTS index, and drop old versions. LanceDB OSS
   * only updates the FTS index on an explicit call.
   *
   * The caller decides when — once per ingest rather than per insert, to avoid
   * O(n^2) during bulk work.
   */
  async optimize(): Promise<void> {
    await this.openExistingTable()
    if (!this.table || !this.ftsEnabled) {
      return
    }

    const cleanupThreshold = new Date(Date.now() - FTS_CLEANUP_THRESHOLD_MS)
    await this.table.optimize({ cleanupOlderThan: cleanupThreshold })
  }

  /**
   * Semantic search → maxDistance/grouping filter → keyword boost → maxFiles.
   *
   * Prefetch-then-rerank, so the distance filters see real vector distances and
   * keyword matching boosts rather than replaces semantic similarity.
   */
  /**
   * Rerank vector hits with BM25 scores for the same files. A failure degrades
   * this request only — FTS stays enabled, so the next query retries hybrid.
   */
  private async boostWithKeywords(
    results: SearchResult[],
    queryText: string,
    hybridWeight: number
  ): Promise<SearchResult[]> {
    const table = this.table
    if (!table) {
      return results
    }
    try {
      // Restrict FTS to the files the vector step already selected. Backticks
      // are required for a camelCase column name in LanceDB.
      const uniqueFilePaths = [...new Set(results.map((result) => result.filePath))]
      const escapedPaths = uniqueFilePaths.map((path) => `'${path.replace(/'/g, "''")}'`)
      const whereClause = `\`filePath\` IN (${escapedPaths.join(', ')})`

      const ftsResults = await table
        .search(queryText, 'fts', 'text')
        .where(whereClause)
        .select(['filePath', 'chunkIndex', 'text', 'metadata', '_score'])
        .limit(results.length * 2) // Enough to cover all vector results
        .toArray()

      return applyKeywordBoost(results, ftsResults, hybridWeight)
    } catch (ftsError) {
      console.error('VectorStore: FTS search failed, using vector-only results:', ftsError)
      return results
    }
  }

  async search(queryVector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    const { queryText, limit = 10, scope } = options
    await this.openExistingTable()
    if (!this.table) {
      console.error('VectorStore: Returning empty results as table does not exist')
      return []
    }

    if (limit < MIN_QUERY_LIMIT || limit > MAX_QUERY_LIMIT) {
      throw new DatabaseError(
        `Invalid limit: expected ${MIN_QUERY_LIMIT}-${MAX_QUERY_LIMIT}, got ${limit}`
      )
    }

    try {
      // Step 1: Semantic (vector) search - always the primary search
      const candidateLimit = limit * HYBRID_SEARCH_CANDIDATE_MULTIPLIER
      let query = this.table
        .vectorSearch(queryVector)
        .distanceType('dot')
        .select(['id', 'filePath', 'chunkIndex', 'text', 'metadata', 'fileTitle', '_distance'])
        .limit(candidateLimit)

      // Restrict to chunks under the given prefixes (exact-or-descendant)
      // before ranking, and only when a scope was given.
      if (scope && scope.length > 0) {
        query = query.where(this.buildScopePredicate(scope))
      }

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

      // `results.length > 0` guards the FTS branch: with zero vector hits the
      // IN clause would degrade to a malformed `filePath IN ()`, and there is
      // nothing to rerank anyway. FTS inherits scope through those hits.
      const hybridWeight = this.config.hybridWeight ?? DEFAULT_HYBRID_WEIGHT
      if (
        this.ftsEnabled &&
        queryText &&
        queryText.trim().length > 0 &&
        hybridWeight > 0 &&
        results.length > 0
      ) {
        results = await this.boostWithKeywords(results, queryText, hybridWeight)
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
      throw new DatabaseError('Failed to search vectors', { cause: toError(error) })
    }
  }

  /**
   * Load and validate attachments for the ordered unique final search identities.
   * Candidate retrieval and ranking are deliberately complete before this one
   * projected batch query runs.
   */
  async hydrateVisualAttachments(
    results: readonly { id: string }[]
  ): Promise<AttachmentHydrationResult> {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const result of results) {
      if (typeof result.id !== 'string' || result.id.length === 0) {
        throw new DatabaseError('Invalid final attachment hydration identity')
      }
      if (!seen.has(result.id)) {
        seen.add(result.id)
        ids.push(result.id)
      }
    }

    await this.openExistingTable()
    if (!this.table || ids.length === 0) {
      return {
        rows: ids.map((id) => ({ id, attachments: [] })),
        omittedCount: 0,
      }
    }

    try {
      const predicate = ids.map((id) => `\`id\` = '${this.escapeQuotes(id)}'`).join(' OR ')
      const records = await this.table
        .query()
        .where(predicate)
        .select(['id', 'visualAttachments'])
        .toArray()
      const recordsByIdentity = new Map<string, unknown>()
      for (const record of records) {
        if (typeof record.id !== 'string') {
          continue
        }
        recordsByIdentity.set(record.id, record.visualAttachments)
      }

      let omittedCount = 0
      const rows = ids.map((id) => {
        if (!recordsByIdentity.has(id)) {
          omittedCount += 1
          return { id, attachments: [] }
        }
        const parsed = parseHydratedVisualAttachments(recordsByIdentity.get(id))
        omittedCount += parsed.omittedCount
        return { id, attachments: parsed.attachments }
      })
      return { rows, omittedCount }
    } catch (error) {
      throw new DatabaseError('Failed to hydrate visual attachments', { cause: toError(error) })
    }
  }

  /**
   * `.where()` predicate restricting `filePath` to the exact-or-descendant set
   * of the given prefixes. The separator boundary stops `/a/b` from matching
   * `/a/bc`. Vector branch only — FTS inherits scope via its own `IN (...)`.
   */
  private buildScopePredicate(prefixes: string[]): string {
    return prefixes.map((prefix) => this.buildPrefixPredicate(prefix)).join(' OR ')
  }

  /** Build the exact-or-descendant predicate for a single prefix. */
  private buildPrefixPredicate(prefix: string): string {
    const { exact, descendant } = normalizeScopePrefix(prefix)
    const exactTerm = `\`filePath\` = '${this.escapeQuotes(exact)}'`
    const descendantTerm = `\`filePath\` LIKE '${this.escapeLike(descendant)}%' ESCAPE '\\'`
    return `(${exactTerm} OR ${descendantTerm})`
  }

  /** Escape single quotes for a SQL string literal (mirrors deleteChunks). */
  private escapeQuotes(value: string): string {
    return value.replace(/'/g, "''")
  }

  /** Escape for a LIKE term with `ESCAPE '\'`: backslash first (else it double-escapes), then `%`, `_`, then quotes. */
  private escapeLike(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/'/g, "''")
  }

  /**
   * Per-chunk `(filePath, contentHash, visualProfile)` projection used by
   * incremental sync.
   *
   * One entry per row rather than per file, so a file whose rows disagree on the
   * hash or the recorded profile is detectable as dirty. `filePath` is the
   * verbatim stored spelling, since that is what {@link deleteChunks} matches.
   * The empty-string placeholder the create path seeds for Arrow inference
   * normalizes to `null`, while any other stored profile string reaches the
   * planner unchanged so it can validate the vocabulary itself.
   *
   * Projects only those three columns, so a manifest load does not materialize
   * embedding vectors or attachment payloads.
   */
  async listSyncManifest(): Promise<
    {
      filePath: string
      contentHash: string | null
      visualProfile: string | null
    }[]
  > {
    await this.openExistingTable()
    if (!this.table) {
      return []
    }

    try {
      const records = await this.table
        .query()
        .select(['filePath', 'contentHash', 'visualProfile'])
        .toArray()
      const entries: {
        filePath: string
        contentHash: string | null
        visualProfile: string | null
      }[] = []
      for (const record of records) {
        const filePath: unknown = record.filePath
        const contentHash: unknown = record.contentHash
        const visualProfile: unknown = record.visualProfile
        // Type-guard parity with listFiles: skip rows missing the expected
        // string column rather than coercing via `as string`.
        if (typeof filePath !== 'string') {
          continue
        }
        entries.push({
          filePath,
          contentHash:
            typeof contentHash === 'string' && contentHash.length > 0 ? contentHash : null,
          visualProfile:
            typeof visualProfile === 'string' && visualProfile.length > 0 ? visualProfile : null,
        })
      }
      return entries
    } catch (error) {
      throw new DatabaseError('Failed to list the sync manifest', { cause: toError(error) })
    }
  }

  /**
   * Get list of ingested files
   */
  async listFiles(): Promise<{ filePath: string; chunkCount: number; timestamp: string }[]> {
    await this.openExistingTable()
    if (!this.table) {
      return [] // Return empty array if table doesn't exist
    }

    try {
      // Project to only the columns needed for aggregation, excluding the
      // embedding vector payload. LanceDB JS has no group-by, so the per-file
      // count + latest-timestamp aggregation still runs here — but over a much
      // smaller row payload than a full `query().toArray()`.
      const allRecords = await this.table.query().select(['filePath', 'timestamp']).toArray()

      // Group by file path
      const fileMap = new Map<string, { chunkCount: number; timestamp: string }>()

      for (const record of allRecords) {
        const filePath = record.filePath
        const timestamp = record.timestamp
        // Type-guard parity with toSearchResult/toChunkRow: skip rows missing
        // the expected string columns rather than coercing via `as string`.
        if (typeof filePath !== 'string' || typeof timestamp !== 'string') {
          continue
        }
        const fileInfo = fileMap.get(filePath)
        if (fileInfo === undefined) {
          fileMap.set(filePath, { chunkCount: 1, timestamp })
          continue
        }
        fileInfo.chunkCount += 1
        // Keep most recent timestamp
        fileInfo.timestamp = timestamp > fileInfo.timestamp ? timestamp : fileInfo.timestamp
      }

      // Convert Map to array of objects
      return Array.from(fileMap.entries()).map(([filePath, info]) => ({
        filePath,
        chunkCount: info.chunkCount,
        timestamp: info.timestamp,
      }))
    } catch (error) {
      throw new DatabaseError('Failed to list files', { cause: toError(error) })
    }
  }

  /**
   * Get system status
   */
  async getStatus(): Promise<{
    documentCount: number
    chunkCount: number
    memoryUsage: number
    uptime: number
    ftsIndexEnabled: boolean
    searchMode: 'hybrid' | 'vector-only'
  }> {
    await this.openExistingTable()
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
      // Total chunk count comes straight from LanceDB's row count — no need to
      // materialize every row just to read `.length`.
      const chunkCount = await this.table.countRows()

      // Distinct document count: LanceDB JS has no DISTINCT, so project to just
      // the filePath column (excludes the vector payload) and dedupe here.
      const records = await this.table.query().select(['filePath']).toArray()
      const uniqueFilePaths = new Set<string>()
      for (const record of records) {
        const filePath = record.filePath
        if (typeof filePath === 'string') {
          uniqueFilePaths.add(filePath)
        }
      }
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
          this.ftsEnabled && (this.config.hybridWeight ?? DEFAULT_HYBRID_WEIGHT) > 0
            ? 'hybrid'
            : 'vector-only',
      }
    } catch (error) {
      throw new DatabaseError('Failed to get status', { cause: toError(error) })
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      // LanceDB Connections should be closed to release file handles
      this.db.close()
      this.db = null
      this.table = null
      this.ftsEnabled = false
      console.error('VectorStore connection closed')
    }
  }
}
