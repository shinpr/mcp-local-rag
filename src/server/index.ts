// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { DocumentParser } from '../parser/index.js'
import { type GroupingMode, type VectorChunk, VectorStore } from '../vectordb/index.js'

// ============================================
// Type Definitions
// ============================================

/**
 * RAGServer configuration
 */
export interface RAGServerConfig {
  /** LanceDB database path */
  dbPath: string
  /** Transformers.js model path */
  modelName: string
  /** Model cache directory */
  cacheDir: string
  /** Document base directory */
  baseDir: string
  /** Maximum file size (100MB) */
  maxFileSize: number
  /** Maximum distance threshold for quality filtering (optional) */
  maxDistance?: number
  /** Grouping mode for quality filtering (optional) */
  grouping?: GroupingMode
  /** Hybrid search weight for BM25 (0.0 = vector only, 1.0 = BM25 only, default 0.6) */
  hybridWeight?: number
}

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
}

/**
 * delete_file tool input
 */
export interface DeleteFileInput {
  /** File path */
  filePath: string
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
}

// ============================================
// RAGServer Class
// ============================================

/**
 * RAG server compliant with MCP Protocol
 *
 * Responsibilities:
 * - MCP tool integration (4 tools)
 * - Tool handler implementation
 * - Error handling
 * - Initialization (LanceDB, Transformers.js)
 */
export class RAGServer {
  private readonly server: Server
  private readonly vectorStore: VectorStore
  private readonly embedder: Embedder
  private readonly chunker: SemanticChunker
  private readonly parser: DocumentParser

  constructor(config: RAGServerConfig) {
    this.server = new Server(
      { name: 'rag-mcp-server', version: '1.0.0' },
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
    this.vectorStore = new VectorStore(vectorStoreConfig)
    this.embedder = new Embedder({
      modelPath: config.modelName,
      batchSize: 16,
      cacheDir: config.cacheDir,
    })
    this.chunker = new SemanticChunker()
    this.parser = new DocumentParser({
      baseDir: config.baseDir,
      maxFileSize: config.maxFileSize,
    })

    this.setupHandlers()
  }

  /**
   * Set up MCP handlers
   */
  private setupHandlers(): void {
    // Tool list
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'query_documents',
          description:
            'Search ingested documents. Your query words are matched exactly (keyword search). Your query meaning is matched semantically (vector search). Preserve specific terms from the user. Add context if the query is ambiguous. Results include score (0 = most relevant, higher = less relevant).',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query. Include specific terms and add context if needed.',
              },
              limit: {
                type: 'number',
                description:
                  'Maximum number of results to return (default: 10). Recommended: 5 for precision, 10 for balance, 20 for broad exploration.',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'ingest_file',
          description:
            'Ingest a document file (PDF, DOCX, TXT, MD) into the vector database for semantic search. File path must be an absolute path. Supports re-ingestion to update existing documents.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description:
                  'Absolute path to the file to ingest. Example: "/Users/user/documents/manual.pdf"',
              },
            },
            required: ['filePath'],
          },
        },
        {
          name: 'delete_file',
          description:
            'Delete a previously ingested file from the vector database. Removes all chunks and embeddings associated with the specified file. File path must be an absolute path. This operation is idempotent - deleting a non-existent file completes without error.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description:
                  'Absolute path to the file to delete from the database. Example: "/Users/user/documents/manual.pdf"',
              },
            },
            required: ['filePath'],
          },
        },
        {
          name: 'list_files',
          description:
            'List all ingested files in the vector database. Returns file paths and chunk counts for each document.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'status',
          description:
            'Get system status including total documents, total chunks, database size, and configuration information.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }))

    // Tool invocation
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: { params: { name: string; arguments?: unknown } }) => {
        switch (request.params.name) {
          case 'query_documents':
            return await this.handleQueryDocuments(
              request.params.arguments as unknown as QueryDocumentsInput
            )
          case 'ingest_file':
            return await this.handleIngestFile(
              request.params.arguments as unknown as IngestFileInput
            )
          case 'delete_file':
            return await this.handleDeleteFile(
              request.params.arguments as unknown as DeleteFileInput
            )
          case 'list_files':
            return await this.handleListFiles()
          case 'status':
            return await this.handleStatus()
          default:
            throw new Error(`Unknown tool: ${request.params.name}`)
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
  async handleQueryDocuments(
    args: QueryDocumentsInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Generate query embedding
      const queryVector = await this.embedder.embed(args.query)

      // Hybrid search (vector + BM25 keyword matching)
      const searchResults = await this.vectorStore.search(queryVector, args.query, args.limit || 10)

      // Format results
      const results: QueryResult[] = searchResults.map((result) => ({
        filePath: result.filePath,
        chunkIndex: result.chunkIndex,
        text: result.text,
        score: result.score,
      }))

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      }
    } catch (error) {
      console.error('Failed to query documents:', error)
      throw error
    }
  }

  /**
   * ingest_file tool handler (re-ingestion support, transaction processing, rollback capability)
   */
  async handleIngestFile(
    args: IngestFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    let backup: VectorChunk[] | null = null

    try {
      // Parse file (with header/footer filtering for PDFs)
      const isPdf = args.filePath.toLowerCase().endsWith('.pdf')
      const text = isPdf
        ? await this.parser.parsePdf(args.filePath, this.embedder)
        : await this.parser.parseFile(args.filePath)

      // Split text into semantic chunks
      const chunks = await this.chunker.chunkText(text, this.embedder)

      // Generate embeddings for final chunks
      const embeddings = await this.embedder.embedBatch(chunks.map((chunk) => chunk.text))

      // Create backup (if existing data exists)
      try {
        const existingFiles = await this.vectorStore.listFiles()
        const existingFile = existingFiles.find((file) => file.filePath === args.filePath)
        if (existingFile && existingFile.chunkCount > 0) {
          // Backup existing data (retrieve via search)
          const queryVector = embeddings[0] || []
          if (queryVector.length > 0) {
            const allChunks = await this.vectorStore.search(queryVector, undefined, 20) // Retrieve max 20 items
            backup = allChunks
              .filter((chunk) => chunk.filePath === args.filePath)
              .map((chunk) => ({
                id: randomUUID(),
                filePath: chunk.filePath,
                chunkIndex: chunk.chunkIndex,
                text: chunk.text,
                vector: queryVector, // Use dummy vector since actual vector cannot be retrieved
                metadata: chunk.metadata,
                timestamp: new Date().toISOString(),
              }))
          }
          console.error(`Backup created: ${backup?.length || 0} chunks for ${args.filePath}`)
        }
      } catch (error) {
        // Backup creation failure is warning only (for new files)
        console.warn('Failed to create backup (new file?):', error)
      }

      // Delete existing data
      await this.vectorStore.deleteChunks(args.filePath)
      console.error(`Deleted existing chunks for: ${args.filePath}`)

      // Create vector chunks
      const timestamp = new Date().toISOString()
      const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
        const embedding = embeddings[index]
        if (!embedding) {
          throw new Error(`Missing embedding for chunk ${index}`)
        }
        return {
          id: randomUUID(),
          filePath: args.filePath,
          chunkIndex: chunk.index,
          text: chunk.text,
          vector: embedding,
          metadata: {
            fileName: args.filePath.split('/').pop() || args.filePath,
            fileSize: text.length,
            fileType: args.filePath.split('.').pop() || '',
          },
          timestamp,
        }
      })

      // Insert vectors (transaction processing)
      try {
        await this.vectorStore.insertChunks(vectorChunks)
        console.error(`Inserted ${vectorChunks.length} chunks for: ${args.filePath}`)

        // Delete backup on success
        backup = null
      } catch (insertError) {
        // Rollback on error
        if (backup && backup.length > 0) {
          console.error('Ingestion failed, rolling back...', insertError)
          try {
            await this.vectorStore.insertChunks(backup)
            console.error(`Rollback completed: ${backup.length} chunks restored`)
          } catch (rollbackError) {
            console.error('Rollback failed:', rollbackError)
            throw new Error(
              `Failed to ingest file and rollback failed: ${(insertError as Error).message}`
            )
          }
        }
        throw insertError
      }

      // Result
      const result: IngestResult = {
        filePath: args.filePath,
        chunkCount: chunks.length,
        timestamp,
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      // Error handling: suppress stack trace in production
      const errorMessage =
        process.env['NODE_ENV'] === 'production'
          ? (error as Error).message
          : (error as Error).stack || (error as Error).message

      console.error('Failed to ingest file:', errorMessage)

      throw new Error(`Failed to ingest file: ${errorMessage}`)
    }
  }

  /**
   * list_files tool handler (Phase 1: basic implementation)
   */
  async handleListFiles(): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      const files = await this.vectorStore.listFiles()
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(files, null, 2),
          },
        ],
      }
    } catch (error) {
      console.error('Failed to list files:', error)
      throw error
    }
  }

  /**
   * status tool handler (Phase 1: basic implementation)
   */
  async handleStatus(): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      const status = await this.vectorStore.getStatus()
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(status, null, 2),
          },
        ],
      }
    } catch (error) {
      console.error('Failed to get status:', error)
      throw error
    }
  }

  /**
   * delete_file tool handler
   */
  async handleDeleteFile(
    args: DeleteFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      // Validate and normalize file path (S-002 security requirement)
      this.parser.validateFilePath(args.filePath)

      // Delete chunks from vector database
      await this.vectorStore.deleteChunks(args.filePath)

      // Return success message
      const result = {
        filePath: args.filePath,
        deleted: true,
        timestamp: new Date().toISOString(),
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      // Error handling: suppress stack trace in production
      const errorMessage =
        process.env['NODE_ENV'] === 'production'
          ? (error as Error).message
          : (error as Error).stack || (error as Error).message

      console.error('Failed to delete file:', errorMessage)

      throw new Error(`Failed to delete file: ${errorMessage}`)
    }
  }

  /**
   * Start the server
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    console.error('RAGServer running on stdio transport')
  }
}
