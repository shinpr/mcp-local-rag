// CLI ingest subcommand — bulk file ingestion with single optimize() at end

import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import type { VectorChunk } from '../vectordb/index.js'
import { VectorStore } from '../vectordb/index.js'
import type { GlobalOptions, ResolvedGlobalConfig } from './options.js'
import { resolveGlobalConfig, validateMaxFileSize, validatePath } from './options.js'

// ============================================
// Types
// ============================================

interface IngestConfig {
  baseDir: string
  dbPath: string
  cacheDir: string
  modelName: string
  maxFileSize: number
}

interface IngestSummary {
  succeeded: number
  failed: number
  totalChunks: number
}

interface IngestCliOptions {
  baseDir?: string | undefined
  maxFileSize?: number | undefined
}

interface ParsedArgs {
  positional: string | undefined
  options: IngestCliOptions
  help: boolean
}

// ============================================
// Defaults
// ============================================

const INGEST_DEFAULTS = {
  maxFileSize: 104857600,
} as const

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] ingest [options] <path>

Ingest a single file or all supported files under a directory.

Options:
  --base-dir <path>      Base directory for documents (default: cwd)
  --max-file-size <n>    Max file size in bytes (default: ${INGEST_DEFAULTS.maxFileSize})
  -h, --help             Show this help

Global options (must appear before "ingest"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse ingest-specific CLI arguments into options and a positional path.
 * Flags: --base-dir, --max-file-size, -h/--help
 * Unknown flags (including global flags passed after subcommand) cause an error.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const options: IngestCliOptions = {}
  let positional: string | undefined
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        i++
        break
      case '--base-dir': {
        const value = args[++i]
        if (value === undefined || value.startsWith('-')) {
          console.error('Missing value for --base-dir')
          process.exit(1)
        }
        options.baseDir = value
        i++
        break
      }
      case '--max-file-size': {
        const raw = args[++i]
        if (raw === undefined || raw.startsWith('-')) {
          console.error('Missing value for --max-file-size')
          process.exit(1)
        }
        const parsed = Number.parseInt(raw, 10)
        options.maxFileSize = Number.isNaN(parsed) ? undefined : parsed
        i++
        break
      }
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        if (positional !== undefined) {
          console.error(`Unexpected argument: ${arg}`)
          console.error('Only one path is accepted. Use a directory to ingest multiple files.')
          process.exit(1)
        }
        positional = arg
        i++
        break
    }
  }

  return { positional, options, help }
}

// ============================================
// NaN Defense
// ============================================

/**
 * Ensure maxFileSize is a valid number, falling back to default if NaN.
 */
function sanitizeMaxFileSize(value: number): number {
  return Number.isNaN(value) ? INGEST_DEFAULTS.maxFileSize : value
}

// ============================================
// Config Resolution
// ============================================

/**
 * Resolve ingest config by merging global config with ingest-specific options.
 * Ingest-specific: baseDir, maxFileSize (CLI flags > env vars > defaults).
 * Validates all resolved values before returning.
 */
export function resolveConfig(
  globalConfig: ResolvedGlobalConfig,
  ingestOptions: IngestCliOptions = {}
): IngestConfig {
  const baseDir = ingestOptions.baseDir ?? process.env['BASE_DIR'] ?? process.cwd()
  const maxFileSize = sanitizeMaxFileSize(
    ingestOptions.maxFileSize ??
      (process.env['MAX_FILE_SIZE']
        ? Number.parseInt(process.env['MAX_FILE_SIZE'], 10)
        : INGEST_DEFAULTS.maxFileSize)
  )

  // Validate baseDir path
  const baseDirError = validatePath(baseDir, '--base-dir')
  if (baseDirError) {
    console.error(baseDirError)
    process.exit(1)
  }

  // Validate maxFileSize range
  const maxFileSizeError = validateMaxFileSize(maxFileSize)
  if (maxFileSizeError) {
    console.error(maxFileSizeError)
    process.exit(1)
  }

  return {
    dbPath: globalConfig.dbPath,
    cacheDir: globalConfig.cacheDir,
    modelName: globalConfig.modelName,
    baseDir,
    maxFileSize,
  }
}

// ============================================
// File Collection
// ============================================

/**
 * Collect files to ingest from a path.
 * - If path is a file with supported extension, return [path].
 * - If path is a directory, recursively scan for supported files.
 * - Exclude dbPath and cacheDir directories.
 */
async function collectFiles(targetPath: string, excludePaths: string[]): Promise<string[]> {
  const resolved = resolve(targetPath)
  const info = await stat(resolved)

  if (info.isFile()) {
    const ext = extname(resolved).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.error(
        `Unsupported file extension: ${ext} (supported: ${[...SUPPORTED_EXTENSIONS].join(', ')})`
      )
      return []
    }
    return [resolved]
  }

  if (info.isDirectory()) {
    const entries = await readdir(resolved, { recursive: true, withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => join(e.parentPath, e.name))
      .filter((filePath) => !excludePaths.some((ep) => filePath.startsWith(ep)))
      .sort()
  }

  return []
}

// ============================================
// Per-file Ingestion
// ============================================

/**
 * Ingest a single file: parse, chunk, embed, delete old chunks, insert new chunks.
 * Returns the number of chunks inserted.
 */
async function ingestSingleFile(
  filePath: string,
  parser: DocumentParser,
  chunker: SemanticChunker,
  embedder: Embedder,
  vectorStore: VectorStore
): Promise<number> {
  // Parse file
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  let text: string
  let title: string | null = null
  if (isPdf) {
    const result = await parser.parsePdf(filePath, embedder)
    text = result.content
    title = result.title || null
  } else {
    const result = await parser.parseFile(filePath)
    text = result.content
    title = result.title || null
  }

  // Chunk text
  const chunks = await chunker.chunkText(text, embedder)
  if (chunks.length === 0) {
    console.error(`  Warning: 0 chunks generated (file may be empty or too short)`)
    return 0
  }

  // Generate embeddings
  const embeddings = await embedder.embedBatch(chunks.map((c) => c.text))

  // Delete existing chunks for this file
  await vectorStore.deleteChunks(filePath)

  // Build vector chunks
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
      fileTitle: title,
      timestamp,
    }
  })

  // Insert chunks
  await vectorStore.insertChunks(vectorChunks)

  return vectorChunks.length
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the ingest CLI subcommand.
 * @param args - Arguments after "ingest" (e.g., option flags and file/directory path)
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runIngest(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { positional, options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Validate positional argument
  if (!positional) {
    console.error('Usage: mcp-local-rag ingest [options] <path>')
    console.error('  Ingest a single file or all supported files under a directory.')
    console.error('  Run with --help for all options.')
    process.exit(1)
  }

  const targetPath = positional

  // Validate path exists
  try {
    await stat(targetPath)
  } catch {
    console.error(`Error: path does not exist: ${targetPath}`)
    process.exit(1)
  }

  // Resolve config: CLI flags > env vars > defaults
  const globalConfig = resolveGlobalConfig(globalOptions)
  const config = resolveConfig(globalConfig, options)
  const excludePaths = [`${resolve(config.dbPath)}/`, `${resolve(config.cacheDir)}/`]

  // Collect files
  const files = await collectFiles(targetPath, excludePaths)
  if (files.length === 0) {
    console.error('No supported files found.')
    process.exit(1)
  }

  console.error(`Found ${files.length} file(s) to ingest.`)

  // Initialize components (single instances reused across all files)
  const parser = new DocumentParser({
    baseDir: config.baseDir,
    maxFileSize: config.maxFileSize,
  })
  const chunker = new SemanticChunker()
  const embedder = new Embedder({
    modelPath: config.modelName,
    batchSize: 16,
    cacheDir: config.cacheDir,
  })
  const vectorStore = new VectorStore({
    dbPath: config.dbPath,
    tableName: 'chunks',
  })
  await vectorStore.initialize()

  // Process each file
  const summary: IngestSummary = { succeeded: 0, failed: 0, totalChunks: 0 }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!
    const label = `[${i + 1}/${files.length}]`

    try {
      const chunkCount = await ingestSingleFile(filePath, parser, chunker, embedder, vectorStore)
      if (chunkCount === 0) {
        // 0 chunks is a skip/warning, not a failure
        console.error(`${label} ${filePath} ... SKIPPED (0 chunks)`)
        summary.succeeded++
      } else {
        console.error(`${label} ${filePath} ... OK (${chunkCount} chunks)`)
        summary.succeeded++
        summary.totalChunks += chunkCount
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`${label} ${filePath} ... FAILED: ${reason}`)
      summary.failed++
    }
  }

  // Optimize once at end (not per-file)
  await vectorStore.optimize()

  // Print summary
  console.error('')
  console.error('--- Ingest Summary ---')
  console.error(`Succeeded: ${summary.succeeded}`)
  console.error(`Failed:    ${summary.failed}`)
  console.error(`Total chunks: ${summary.totalChunks}`)

  if (summary.failed > 0) {
    process.exitCode = 1
  }
}
