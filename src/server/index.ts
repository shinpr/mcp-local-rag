// RAGServer implementation with MCP tools

import { randomUUID } from 'node:crypto'
import { readFile, stat, unlink } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { parseHtml } from '../parser/html-parser.js'
import { DocumentParser } from '../parser/index.js'
import { type GroupingMode, type VectorChunk, VectorStore } from '../vectordb/index.js'
import {
  type ContentFormat,
  extractSourceFromPath,
  generateRawDataPath,
  isRawDataPath,
  saveRawData,
} from './raw-data-utils.js'

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
  /** Recursive scan for directories (default true) */
  recursive?: boolean
  /** Include hidden files when ingesting directories (default false) */
  includeHidden?: boolean
  /** Restrict to extensions when ingesting directories (e.g., [".md", ".ts"]) */
  extensions?: string[]
}

/**
 * ingest_directory (via ingest_file when path is a directory)
 */
export interface IngestDirectoryInput {
  /** Directory path */
  directoryPath: string
  /** Recursive scan (default true) */
  recursive?: boolean
  /** Include hidden files (default false) */
  includeHidden?: boolean
  /** Restrict to extensions (e.g., [".md", ".ts"]) */
  extensions?: string[]
}

/**
 * ingest_data tool input metadata
 */
export interface IngestDataMetadata {
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
}

/**
 * ingest_directory result
 */
export interface IngestDirectoryResult {
  /** Directory path */
  directoryPath: string
  /** Total files found */
  filesProcessed: number
  /** Files ingested successfully */
  filesSucceeded: number
  /** Files failed */
  filesFailed: number
  /** Error details for failed files */
  failures: { filePath: string; error: string }[]
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
}

// ============================================
// RAGServer Class
// ============================================

/**
 * RAG server compliant with MCP Protocol
 *
 * Responsibilities:
 * - MCP tool integration (6 tools)
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
  private readonly dbPath: string

  constructor(config: RAGServerConfig) {
    this.dbPath = config.dbPath
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
            'Ingest a document file (PDF, DOCX, PPTX, XLSX/XLS, TXT, MD, JSON, YAML, config files, source code) into the vector database for semantic search. File path must be an absolute path within BASE_DIR. You can also pass a directory path to ingest all supported files inside it.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description:
                  'Absolute path to the file or directory to ingest. Example: "/Users/user/documents/manual.pdf" or "/Users/user/Documents"',
              },
              recursive: {
                type: 'boolean',
                description: 'When filePath is a directory, scan subfolders (default true).',
              },
              includeHidden: {
                type: 'boolean',
                description: 'When filePath is a directory, include hidden files (default false).',
              },
              extensions: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'When filePath is a directory, limit files to these extensions (e.g., [".md", ".ts"]).',
              },
            },
            required: ['filePath'],
          },
        },
        {
          name: 'ingest_data',
          description:
            'Ingest content as a string, not from a file. Use for: fetched web pages (format: html), copied text (format: text), or markdown strings (format: markdown). The source identifier enables re-ingestion to update existing content. For files on disk, use ingest_file instead.',
          inputSchema: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'The content to ingest (text, HTML, or Markdown)',
              },
              metadata: {
                type: 'object',
                properties: {
                  source: {
                    type: 'string',
                    description:
                      'Source identifier. For web pages, use the URL (e.g., "https://example.com/page"). For other content, use URL-scheme format: "{type}://{date}" or "{type}://{date}/{detail}". Examples: "clipboard://2024-12-30", "chat://2024-12-30/project-discussion", "note://2024-12-30/meeting".',
                  },
                  format: {
                    type: 'string',
                    enum: ['text', 'html', 'markdown'],
                    description: 'Content format: "text", "html", or "markdown"',
                  },
                },
                required: ['source', 'format'],
              },
            },
            required: ['content', 'metadata'],
          },
        },
        {
          name: 'delete_file',
          description:
            'Delete a previously ingested file or data from the vector database. Use filePath for files ingested via ingest_file, or source for data ingested via ingest_data. Either filePath or source must be provided.',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description:
                  'Absolute path to the file (for ingest_file). Example: "/Users/user/documents/manual.pdf"',
              },
              source: {
                type: 'string',
                description:
                  'Source identifier used in ingest_data. Examples: "https://example.com/page", "clipboard://2024-12-30"',
              },
            },
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
          case 'ingest_data':
            return await this.handleIngestData(
              request.params.arguments as unknown as IngestDataInput
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

      // Format results with source restoration for raw-data files
      const results: QueryResult[] = searchResults.map((result) => {
        const queryResult: QueryResult = {
          filePath: result.filePath,
          chunkIndex: result.chunkIndex,
          text: result.text,
          score: result.score,
        }

        // Restore source for raw-data files (ingested via ingest_data)
        if (isRawDataPath(result.filePath)) {
          const source = extractSourceFromPath(result.filePath)
          if (source) {
            queryResult.source = source
          }
        }

        return queryResult
      })

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

  private async ingestSingleFile(filePath: string): Promise<IngestResult> {
    let backup: VectorChunk[] | null = null

    // Parse file (with header/footer filtering for PDFs)
    // For raw-data files (from ingest_data), read directly without validation
    // since the path is internally generated and content is already processed
    const isPdf = filePath.toLowerCase().endsWith('.pdf')
    let text: string
    if (isRawDataPath(filePath)) {
      // Raw-data files: skip validation, read directly
      text = await readFile(filePath, 'utf-8')
      console.error(`Read raw-data file: ${filePath} (${text.length} characters)`)
    } else if (isPdf) {
      text = await this.parser.parsePdf(filePath, this.embedder)
    } else {
      text = await this.parser.parseFile(filePath)
    }

    // Split text into semantic chunks
    const chunks = await this.chunker.chunkText(text, this.embedder)

    // Fail-fast: Prevent data loss when chunking produces 0 chunks
    // This check must happen BEFORE delete to preserve existing data on re-ingest
    if (chunks.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No chunks generated from file: ${filePath}. The file may be empty or all content was filtered (minimum 50 characters required). Existing data has been preserved.`
      )
    }

    // Generate embeddings for final chunks
    const embeddings = await this.embedder.embedBatch(chunks.map((chunk) => chunk.text))

    // Create backup (if existing data exists)
    try {
      const existingFiles = await this.vectorStore.listFiles()
      const existingFile = existingFiles.find((file) => file.filePath === filePath)
      if (existingFile && existingFile.chunkCount > 0) {
        // Backup existing data (retrieve via search)
        const queryVector = embeddings[0] || []
        if (queryVector.length > 0) {
          const allChunks = await this.vectorStore.search(queryVector, undefined, 20) // Retrieve max 20 items
          backup = allChunks
            .filter((chunk) => chunk.filePath === filePath)
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
        console.error(`Backup created: ${backup?.length || 0} chunks for ${filePath}`)
      }
    } catch (error) {
      // Backup creation failure is warning only (for new files)
      console.warn('Failed to create backup (new file?):', error)
    }

    // Delete existing data
    await this.vectorStore.deleteChunks(filePath)
    console.error(`Deleted existing chunks for: ${filePath}`)

    // Create vector chunks
    const timestamp = new Date().toISOString()
    const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
      const embedding = embeddings[index]
      if (!embedding) {
        throw new Error(`Missing embedding for chunk ${index}`)
      }
      return {
        id: randomUUID(),
        filePath,
        chunkIndex: chunk.index,
        text: chunk.text,
        vector: embedding,
        metadata: {
          fileName: filePath.split('/').pop() || filePath,
          fileSize: text.length,
          fileType: filePath.split('.').pop() || '',
        },
        timestamp,
      }
    })

    // Insert vectors (transaction processing)
    try {
      await this.vectorStore.insertChunks(vectorChunks)
      console.error(`Inserted ${vectorChunks.length} chunks for: ${filePath}`)

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
    return {
      filePath,
      chunkCount: chunks.length,
      timestamp,
    }
  }

  private async ingestDirectory(input: IngestDirectoryInput): Promise<IngestDirectoryResult> {
    const listOptions: {
      directoryPath: string
      recursive?: boolean
      includeHidden?: boolean
      extensions?: string[]
    } = { directoryPath: input.directoryPath }
    if (input.recursive !== undefined) {
      listOptions.recursive = input.recursive
    }
    if (input.includeHidden !== undefined) {
      listOptions.includeHidden = input.includeHidden
    }
    if (input.extensions !== undefined) {
      listOptions.extensions = input.extensions
    }

    const files = await this.parser.listFilesInDirectory(listOptions)

    const failures: { filePath: string; error: string }[] = []
    let succeeded = 0

    for (const filePath of files) {
      try {
        await this.ingestSingleFile(filePath)
        succeeded += 1
      } catch (error) {
        failures.push({
          filePath,
          error: (error as Error).message,
        })
      }
    }

    return {
      directoryPath: input.directoryPath,
      filesProcessed: files.length,
      filesSucceeded: succeeded,
      filesFailed: failures.length,
      failures,
    }
  }

  /**
   * ingest_file tool handler (re-ingestion support, transaction processing, rollback capability)
   */
  async handleIngestFile(
    args: IngestFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      if (!isRawDataPath(args.filePath)) {
        let statsResult: Awaited<ReturnType<typeof stat>> | null = null
        try {
          statsResult = await stat(args.filePath)
        } catch {
          statsResult = null
        }

        if (statsResult?.isDirectory()) {
          const directoryInput: IngestDirectoryInput = { directoryPath: args.filePath }
          if (args.recursive !== undefined) {
            directoryInput.recursive = args.recursive
          }
          if (args.includeHidden !== undefined) {
            directoryInput.includeHidden = args.includeHidden
          }
          if (args.extensions !== undefined) {
            directoryInput.extensions = args.extensions
          }

          const result = await this.ingestDirectory(directoryInput)

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          }
        }
      }

      const result = await this.ingestSingleFile(args.filePath)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      // Re-throw McpError as-is to preserve error code
      if (error instanceof McpError) {
        console.error('Failed to ingest file:', error.message)
        throw error
      }

      // Error handling: show stack trace only in development mode (secure by default)
      const errorMessage =
        process.env['NODE_ENV'] === 'development'
          ? (error as Error).stack || (error as Error).message
          : (error as Error).message

      console.error('Failed to ingest file:', errorMessage)

      throw new Error(`Failed to ingest file: ${errorMessage}`)
    }
  }

  /**
   * ingest_data tool handler
   * Saves raw content to raw-data directory and calls handleIngestFile internally
   *
   * For HTML content:
   * - Parses HTML and extracts main content using Readability
   * - Converts to Markdown for better chunking
   * - Saves as .md file
   */
  async handleIngestData(
    args: IngestDataInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      let contentToSave = args.content
      let formatToSave: ContentFormat = args.metadata.format

      // For HTML content, convert to Markdown first
      if (args.metadata.format === 'html') {
        console.error(`Parsing HTML from: ${args.metadata.source}`)
        const markdown = await parseHtml(args.content, args.metadata.source)

        if (!markdown.trim()) {
          throw new Error(
            'Failed to extract content from HTML. The page may have no readable content.'
          )
        }

        contentToSave = markdown
        formatToSave = 'markdown' // Save as .md file
        console.error(`Converted HTML to Markdown: ${markdown.length} characters`)
      }

      // Save content to raw-data directory
      const rawDataPath = await saveRawData(
        this.dbPath,
        args.metadata.source,
        contentToSave,
        formatToSave
      )

      console.error(`Saved raw data: ${args.metadata.source} -> ${rawDataPath}`)

      // Call existing ingest_file internally with rollback on failure
      try {
        return await this.handleIngestFile({ filePath: rawDataPath })
      } catch (ingestError) {
        // Rollback: delete the raw-data file if ingest fails
        try {
          await unlink(rawDataPath)
          console.error(`Rolled back raw-data file: ${rawDataPath}`)
        } catch {
          console.warn(`Failed to rollback raw-data file: ${rawDataPath}`)
        }
        throw ingestError
      }
    } catch (error) {
      // Error handling: show stack trace only in development mode (secure by default)
      const errorMessage =
        process.env['NODE_ENV'] === 'development'
          ? (error as Error).stack || (error as Error).message
          : (error as Error).message

      console.error('Failed to ingest data:', errorMessage)

      throw new Error(`Failed to ingest data: ${errorMessage}`)
    }
  }

  /**
   * list_files tool handler
   * Enriches raw-data files with original source information
   */
  async handleListFiles(): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      const files = await this.vectorStore.listFiles()

      // Enrich raw-data files with source information
      const enrichedFiles = files.map((file) => {
        if (isRawDataPath(file.filePath)) {
          const source = extractSourceFromPath(file.filePath)
          if (source) {
            return { ...file, source }
          }
        }
        return file
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(enrichedFiles, null, 2),
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
   * Deletes chunks from VectorDB and physical raw-data files
   * Supports both filePath (for ingest_file) and source (for ingest_data)
   */
  async handleDeleteFile(
    args: DeleteFileInput
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    try {
      let targetPath: string
      let skipValidation = false

      if (args.source) {
        // Generate raw-data path from source (extension is always .md)
        // Internal path generation is secure, skip baseDir validation
        targetPath = generateRawDataPath(this.dbPath, args.source, 'markdown')
        skipValidation = true
      } else if (args.filePath) {
        targetPath = args.filePath
      } else {
        throw new Error('Either filePath or source must be provided')
      }

      // Only validate user-provided filePath (not internally generated paths)
      if (!skipValidation) {
        this.parser.validateFilePath(targetPath)
      }

      // Delete chunks from vector database
      await this.vectorStore.deleteChunks(targetPath)

      // Also delete physical raw-data file if applicable
      if (isRawDataPath(targetPath)) {
        try {
          await unlink(targetPath)
          console.error(`Deleted raw-data file: ${targetPath}`)
        } catch {
          // File may already be deleted, log warning only
          console.warn(`Could not delete raw-data file (may not exist): ${targetPath}`)
        }
      }

      // Return success message
      const result = {
        filePath: targetPath,
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
      // Error handling: show stack trace only in development mode (secure by default)
      const errorMessage =
        process.env['NODE_ENV'] === 'development'
          ? (error as Error).stack || (error as Error).message
          : (error as Error).message

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
