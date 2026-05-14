// CLI ingest subcommand — bulk file ingestion with single optimize() at end

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { fdir } from 'fdir'

import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { isRawDataPath, loadMetaJson } from '../utils/raw-data-utils.js'
import type { VectorChunk, VectorStore } from '../vectordb/index.js'
import { createEmbedder, createVectorStore } from './common.js'
import type { GlobalOptions, ResolvedGlobalConfig } from './options.js'
import {
  resolveGlobalConfig,
  validateChunkMinLength,
  validateMaxFileSize,
  validatePath,
} from './options.js'

// ============================================
// Constants
// ============================================

const MAX_DEPTH = 10

// ============================================
// Types
// ============================================

interface IngestConfig {
  baseDir: string
  dbPath: string
  cacheDir: string
  modelName: string
  maxFileSize: number
  chunkMinLength?: number
}

interface IngestSummary {
  succeeded: number
  failed: number
  totalChunks: number
}

interface IngestCliOptions {
  baseDir?: string | undefined
  maxFileSize?: number | undefined
  chunkMinLength?: number | undefined
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
  --base-dir <path>        Base directory for documents (default: cwd)
  --max-file-size <n>      Max file size in bytes (default: ${INGEST_DEFAULTS.maxFileSize})
  --chunk-min-length <n>   Minimum chunk length in characters (default: 50, range: 1-10000)
  -h, --help               Show this help

Global options (must appear before "ingest"):
  --db-path <path>         LanceDB database path
  --cache-dir <path>       Model cache directory
  --model-name <name>      Embedding model`

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
        if (!/^\d+$/.test(raw)) {
          console.error(`Invalid value for --max-file-size: "${raw.slice(0, 100)}"`)

          process.exit(1)
        }
        options.maxFileSize = Number.parseInt(raw, 10)
        i++
        break
      }
      case '--chunk-min-length': {
        const raw = args[++i]
        if (raw === undefined || raw.startsWith('-')) {
          console.error('Missing value for --chunk-min-length')
          process.exit(1)
        }
        if (!/^\d+$/.test(raw)) {
          console.error(`Invalid value for --chunk-min-length: "${raw.slice(0, 100)}"`)

          process.exit(1)
        }
        options.chunkMinLength = Number.parseInt(raw, 10)
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
  const maxFileSize =
    ingestOptions.maxFileSize ??
    (process.env['MAX_FILE_SIZE']
      ? Number.parseInt(process.env['MAX_FILE_SIZE'], 10)
      : INGEST_DEFAULTS.maxFileSize)
  const chunkMinLength =
    ingestOptions.chunkMinLength ??
    (process.env['CHUNK_MIN_LENGTH']
      ? Number.parseInt(process.env['CHUNK_MIN_LENGTH'], 10)
      : undefined)

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

  // Validate chunkMinLength range (if provided)
  if (chunkMinLength !== undefined) {
    const chunkMinLengthError = validateChunkMinLength(chunkMinLength)
    if (chunkMinLengthError) {
      console.error(chunkMinLengthError)
      process.exit(1)
    }
  }

  const resolved: IngestConfig = {
    dbPath: globalConfig.dbPath,
    cacheDir: globalConfig.cacheDir,
    modelName: globalConfig.modelName,
    baseDir,
    maxFileSize,
  }
  if (chunkMinLength !== undefined) {
    resolved.chunkMinLength = chunkMinLength
  }
  return resolved
}

// ============================================
// File Collection
// ============================================

/**
 * File info for ingestion
 */
export interface FileInfo {
  filePath: string
  contentHash: string
}

/**
 * Compute SHA-256 hash of a file.
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Collect files to ingest from a path.
 * - If path is a file with supported extension, return [path] with its SHA-256 hash.
 * - If path is a directory, crawl with fdir (up to MAX_DEPTH levels), hash each file.
 * - Skip symlinks, permission errors, and excluded directories.
 */
export async function collectFiles(
  targetPath: string,
  excludePaths: string[]
): Promise<FileInfo[]> {
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
    const contentHash = await hashFile(resolved)
    return [{ filePath: resolved, contentHash }]
  }

  if (info.isDirectory()) {
    let paths: string[]
    try {
      paths = await new fdir()
        .withFullPaths()
        .withMaxDepth(MAX_DEPTH)
        .filter((p) => SUPPORTED_EXTENSIONS.has(extname(p).toLowerCase()))
        .exclude((_, dirPath) => excludePaths.some((ep) => dirPath.startsWith(ep)))
        .crawl(resolved)
        .withPromise()
    } catch {
      console.error(`Warning: cannot read directory: ${resolved}`)
      return []
    }

    const fileInfos = await Promise.all(
      paths.map(async (filePath) => {
        const contentHash = await hashFile(filePath)
        return { filePath, contentHash }
      })
    )

    return fileInfos.sort((a, b) => a.filePath.localeCompare(b.filePath))
  }

  return []
}
// ============================================
// Per-file Ingestion
// ============================================

/**
 * Ingest a single file: parse, chunk, embed, delete old chunks, insert new chunks.
 * Includes rollback support if insertion fails.
 * Returns a result object.
 */
export async function ingestSingleFile(
  filePath: string,
  parser: DocumentParser,
  chunker: SemanticChunker,
  embedder: Embedder,
  vectorStore: VectorStore,
  contentHash?: string,
  signal?: AbortSignal
): Promise<{
  filePath: string
  chunkCount: number
  timestamp: string
  fileTitle: string | null
}> {
  let backup: VectorChunk[] | null = null
  const timestamp = new Date().toISOString()

  // 1. Compute content hash if missing
  const finalHash = contentHash || (await hashFile(filePath))

  if (signal?.aborted) throw new Error('Operation aborted')

  // 2. Parse file
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  let text: string
  let title: string | null = null

  if (isRawDataPath(filePath)) {
    // Raw-data files (from ingest_data tool)
    text = await readFile(filePath, 'utf-8')
    const meta = await loadMetaJson(filePath)
    title = meta?.title ?? null
  } else if (isPdf) {
    const result = await parser.parsePdf(filePath, embedder)
    text = result.content
    title = result.title || null
  } else {
    const result = await parser.parseFile(filePath)
    text = result.content
    title = result.title || null
  }

  if (signal?.aborted) throw new Error('Operation aborted')

  // 3. Chunk text
  const chunks = await chunker.chunkText(text, embedder)
  if (chunks.length === 0) {
    // Fail-fast: Prevent data loss when chunking produces 0 chunks
    throw new Error(
      `No chunks generated from file: ${filePath}. The file may be empty or too short. Existing data preserved.`
    )
  }

  if (signal?.aborted) throw new Error('Operation aborted')

  // 4. Generate embeddings
  const embeddings = await embedder.embedBatch(chunks.map((c) => c.text))

  if (signal?.aborted) throw new Error('Operation aborted')

  // 5. Create backup of existing data
  try {
    const existingFiles = await vectorStore.listFiles()
    const exists = existingFiles.some((f) => f.filePath === filePath)
    if (exists) {
      // Use getChunksByRange to get all existing chunks for this file
      const rows = await vectorStore.getChunksByRange(filePath, 0, 1000000)
      if (rows.length > 0) {
        backup = rows.map((row) => ({
          id: randomUUID(),
          filePath: row.filePath,
          chunkIndex: row.chunkIndex,
          text: row.text,
          vector: [], // Metadata restore (actual vector not needed for rollback of same-path delete/insert)
          metadata: {
            fileName: filePath.split(sep).pop() || filePath,
            fileSize: 0,
            fileType: filePath.split('.').pop() || '',
            contentHash: '',
          },
          fileTitle: row.fileTitle ?? null,
          timestamp: new Date().toISOString(),
        }))
      }
    }
  } catch (backupError) {
    console.warn(`Warning: Failed to create backup for ${filePath}:`, backupError)
  }

  // 6. Delete existing data
  await vectorStore.deleteChunks(filePath)

  // 7. Build vector chunks
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
        fileName: filePath.split(sep).pop() || filePath,
        fileSize: text.length,
        fileType: filePath.split('.').pop() || '',
        contentHash: finalHash,
      },
      fileTitle: title,
      timestamp,
    }
  })

  // 8. Insert new data with rollback
  try {
    await vectorStore.insertChunks(vectorChunks)
    return {
      filePath,
      chunkCount: vectorChunks.length,
      timestamp,
      fileTitle: title,
    }
  } catch (insertError) {
    if (backup && backup.length > 0) {
      console.error(`Ingestion failed for ${filePath}, rolling back...`)
      try {
        await vectorStore.insertChunks(backup)
        await vectorStore.optimize()
        console.error(`Rollback successful for ${filePath}`)
      } catch (rollbackError) {
        console.error(`CRITICAL: Rollback failed for ${filePath}:`, rollbackError)
        throw new Error(
          `Failed to ingest file and rollback failed: ${(insertError as Error).message}`
        )
      }
    }
    throw insertError
  }
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
  const excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]

  // Collect files
  const fileInfos = await collectFiles(targetPath, excludePaths)
  if (fileInfos.length === 0) {
    console.error('No supported files found.')
    process.exit(1)
  }

  console.error(`Found ${fileInfos.length} file(s) to ingest.`)

  // Initialize components (single instances reused across all files)
  const parser = new DocumentParser({
    baseDir: config.baseDir,
    maxFileSize: config.maxFileSize,
  })
  const chunker = new SemanticChunker(
    config.chunkMinLength !== undefined ? { minChunkLength: config.chunkMinLength } : {}
  )
  const embedder = createEmbedder(globalConfig)
  const vectorStore = createVectorStore(globalConfig)
  await vectorStore.initialize()

  // Process each file
  const summary: IngestSummary = { succeeded: 0, failed: 0, totalChunks: 0 }

  for (let i = 0; i < fileInfos.length; i++) {
    const { filePath, contentHash } = fileInfos[i]!
    const label = `[${i + 1}/${fileInfos.length}]`

    try {
      const result = await ingestSingleFile(
        filePath,
        parser,
        chunker,
        embedder,
        vectorStore,
        contentHash
      )
      console.error(`${label} ${filePath} ... OK (${result.chunkCount} chunks)`)
      summary.succeeded++
      summary.totalChunks += result.chunkCount
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (reason.includes('No chunks generated')) {
        console.error(`${label} ${filePath} ... SKIPPED (0 chunks)`)
        summary.succeeded++
      } else {
        console.error(`${label} ${filePath} ... FAILED: ${reason}`)
        summary.failed++
      }
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
