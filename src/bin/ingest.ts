/**
 * MCP Local RAG Bulk Ingest CLI
 *
 * Ingests large folders without MCP tool timeouts.
 *
 * Usage:
 *   npx mcp-local-rag ingest --path /Users/me/Desktop
 *   npx mcp-local-rag ingest --path /Users/me/Desktop --extensions .pdf,.md
 *   npx mcp-local-rag ingest --path /Users/me/Desktop --no-recursive --dry-run
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { DocumentParser } from '../parser/index.js'
import { type VectorChunk, VectorStore } from '../vectordb/index.js'

// ============================================
// Types
// ============================================

interface Options {
  path?: string
  baseDir?: string
  dbPath?: string
  cacheDir?: string
  modelName?: string
  maxFileSize?: number
  batchSize?: number
  recursive: boolean
  includeHidden: boolean
  extensions: string[]
  excludes: string[]
  maxFiles?: number
  skipExisting: boolean
  dryRun: boolean
  progressEvery: number
  failFast: boolean
  failOnError: boolean
  json: boolean
  parsers?: string
  help: boolean
}

interface IngestStats {
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  failures: { filePath: string; error: string }[]
  startTimeMs: number
}

// ============================================
// Helpers
// ============================================

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':')
}

function formatRate(processed: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return '0.0'
  return (processed / (elapsedMs / 1000)).toFixed(1)
}

function printHelp(): void {
  console.log(`
MCP Local RAG Bulk Ingest

Usage:
  npx mcp-local-rag ingest --path <file-or-dir> [options]

Options:
  --path, -p <path>         File or directory to ingest (required)
  --base-dir <path>         Base directory boundary (defaults to path or its parent)
  --db-path <path>          LanceDB path (default: ./lancedb or DB_PATH)
  --cache-dir <path>        Model cache dir (default: ./models or CACHE_DIR)
  --model <name>            Embedding model (default: Xenova/all-MiniLM-L6-v2)
  --max-file-size <bytes>   Max file size in bytes (default: 104857600)
  --batch-size <n>          Embedding batch size (default: 8)
  --extensions <list>       Comma-separated extensions (e.g., .pdf,.md)
  --exclude <list>          Comma-separated path substrings to skip (added to defaults)
  --no-recursive            Do not traverse directories
  --include-hidden          Include hidden files and folders
  --max-files <n>           Limit number of files processed
  --skip-existing           Skip files already indexed (default)
  --force                   Re-ingest even if already indexed
  --dry-run                 List file counts without ingesting
  --progress-every <n>      Print progress every N files (default: 25)
  --parsers <path>          Path to custom parser config JSON
  --fail-fast               Stop at first failure
  --fail-on-error           Exit with non-zero code if any failures
  --json                    Output final summary as JSON
  --help, -h                Show this help message

Examples:
  npx mcp-local-rag ingest --path /Users/me/Desktop
  npx mcp-local-rag ingest --path /Users/me/Desktop --extensions .pdf,.md
  npx mcp-local-rag ingest --path /Users/me/Desktop --exclude node_modules,dist
`)
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    recursive: true,
    includeHidden: false,
    extensions: [],
    excludes: [],
    skipExisting: true,
    dryRun: false,
    progressEvery: 25,
    failFast: false,
    failOnError: false,
    json: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break

      case '--path':
      case '-p': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --path requires a value')
          process.exit(1)
        }
        options.path = value
        i++
        break
      }

      case '--base-dir': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --base-dir requires a value')
          process.exit(1)
        }
        options.baseDir = value
        i++
        break
      }

      case '--db-path': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --db-path requires a value')
          process.exit(1)
        }
        options.dbPath = value
        i++
        break
      }

      case '--cache-dir': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --cache-dir requires a value')
          process.exit(1)
        }
        options.cacheDir = value
        i++
        break
      }

      case '--model': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --model requires a value')
          process.exit(1)
        }
        options.modelName = value
        i++
        break
      }

      case '--max-file-size': {
        const value = args[i + 1]
        if (!value || Number.isNaN(Number(value))) {
          console.error('Error: --max-file-size requires a numeric value')
          process.exit(1)
        }
        options.maxFileSize = Number.parseInt(value, 10)
        i++
        break
      }

      case '--batch-size': {
        const value = args[i + 1]
        if (!value || Number.isNaN(Number(value))) {
          console.error('Error: --batch-size requires a numeric value')
          process.exit(1)
        }
        options.batchSize = Number.parseInt(value, 10)
        i++
        break
      }

      case '--extensions':
      case '--ext': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --extensions requires a comma-separated list')
          process.exit(1)
        }
        options.extensions.push(...splitList(value))
        i++
        break
      }

      case '--exclude': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --exclude requires a comma-separated list')
          process.exit(1)
        }
        options.excludes.push(...splitList(value))
        i++
        break
      }

      case '--max-files': {
        const value = args[i + 1]
        if (!value || Number.isNaN(Number(value))) {
          console.error('Error: --max-files requires a numeric value')
          process.exit(1)
        }
        options.maxFiles = Number.parseInt(value, 10)
        i++
        break
      }

      case '--no-recursive':
        options.recursive = false
        break

      case '--recursive':
        options.recursive = true
        break

      case '--include-hidden':
        options.includeHidden = true
        break

      case '--skip-existing':
        options.skipExisting = true
        break

      case '--force':
        options.skipExisting = false
        break

      case '--dry-run':
        options.dryRun = true
        break

      case '--progress-every': {
        const value = args[i + 1]
        if (!value || Number.isNaN(Number(value))) {
          console.error('Error: --progress-every requires a numeric value')
          process.exit(1)
        }
        options.progressEvery = Number.parseInt(value, 10)
        i++
        break
      }

      case '--parsers': {
        const value = args[i + 1]
        if (!value) {
          console.error('Error: --parsers requires a path')
          process.exit(1)
        }
        options.parsers = value
        i++
        break
      }

      case '--fail-fast':
        options.failFast = true
        break

      case '--fail-on-error':
        options.failOnError = true
        break

      case '--json':
        options.json = true
        break

      default: {
        if (arg?.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          process.exit(1)
        }
        if (!options.path) {
          if (!arg) {
            console.error('Error: Missing path argument')
            process.exit(1)
          }
          options.path = arg
        } else {
          console.error(`Unexpected argument: ${arg}`)
          process.exit(1)
        }
      }
    }
  }

  return options
}

function printProgress(stats: IngestStats): void {
  const elapsedMs = Date.now() - stats.startTimeMs
  const rate = formatRate(stats.processed, elapsedMs)
  const remaining = stats.total - stats.processed
  const etaMs = stats.processed > 0 ? (elapsedMs / stats.processed) * remaining : 0
  const eta = stats.processed > 0 ? formatDuration(etaMs) : '--:--:--'

  console.error(
    `[ingest] ${stats.processed}/${stats.total} ` +
      `ok:${stats.succeeded} fail:${stats.failed} skip:${stats.skipped} ` +
      `${rate} files/s ETA ${eta}`
  )
}

// ============================================
// CLI Runner
// ============================================

export async function run(args: string[]): Promise<void> {
  const options = parseArgs(args)

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  if (!options.path) {
    console.error('Error: --path is required')
    printHelp()
    process.exit(1)
  }

  if (options.parsers) {
    process.env['MCP_LOCAL_RAG_PARSERS'] = options.parsers
  }

  const targetPath = resolve(options.path)
  const targetStats = await stat(targetPath).catch((error) => {
    console.error(`Error: Failed to access path ${targetPath}`)
    throw error
  })

  const baseDir = options.baseDir || (targetStats.isDirectory() ? targetPath : dirname(targetPath))

  const dbPath = options.dbPath || process.env['DB_PATH'] || './lancedb/'
  const cacheDir = options.cacheDir || process.env['CACHE_DIR'] || './models/'
  const modelName = options.modelName || process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2'
  const maxFileSize =
    options.maxFileSize || Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10)
  const batchSize = options.batchSize || 8

  const parser = new DocumentParser({ baseDir, maxFileSize })

  let files: string[]
  if (targetStats.isDirectory()) {
    const listOptions: {
      directoryPath: string
      recursive?: boolean
      includeHidden?: boolean
      extensions?: string[]
      excludes?: string[]
    } = {
      directoryPath: targetPath,
      recursive: options.recursive,
      includeHidden: options.includeHidden,
    }
    if (options.extensions.length > 0) {
      listOptions.extensions = options.extensions
    }
    if (options.excludes.length > 0) {
      listOptions.excludes = options.excludes
    }
    files = await parser.listFilesInDirectory(listOptions)
  } else if (targetStats.isFile()) {
    files = [targetPath]
  } else {
    console.error(`Error: Path is not a file or directory: ${targetPath}`)
    process.exit(1)
  }

  if (options.excludes.length > 0) {
    files = files.filter((filePath) => !options.excludes.some((skip) => filePath.includes(skip)))
  }

  if (options.maxFiles !== undefined) {
    files = files.slice(0, Math.max(0, options.maxFiles))
  }

  if (options.dryRun) {
    const summary = {
      totalFiles: files.length,
      baseDir,
      dbPath,
      cacheDir,
      modelName,
      recursive: options.recursive,
      includeHidden: options.includeHidden,
      extensions: options.extensions,
      excludes: options.excludes,
    }
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log('Dry run summary:')
      console.log(summary)
    }
    process.exit(0)
  }

  const vectorStore = new VectorStore({ dbPath, tableName: 'chunks' })
  await vectorStore.initialize()

  const embedder = new Embedder({ modelPath: modelName, batchSize, cacheDir })
  const chunker = new SemanticChunker()

  let existing = new Set<string>()
  if (options.skipExisting) {
    const existingFiles = await vectorStore.listFiles()
    existing = new Set(existingFiles.map((entry) => entry.filePath))
  }

  const stats: IngestStats = {
    total: files.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    startTimeMs: Date.now(),
  }

  for (const filePath of files) {
    if (options.skipExisting && existing.has(filePath)) {
      stats.skipped++
      stats.processed++
      if (stats.processed % options.progressEvery === 0) {
        printProgress(stats)
      }
      continue
    }

    try {
      const isPdf = filePath.toLowerCase().endsWith('.pdf')
      const text = isPdf
        ? await parser.parsePdf(filePath, embedder)
        : await parser.parseFile(filePath)

      const chunks = await chunker.chunkText(text, embedder)
      if (chunks.length === 0) {
        throw new Error(
          'No chunks generated (minimum 50 characters required). File may be empty or filtered.'
        )
      }

      const embeddings = await embedder.embedBatch(chunks.map((chunk) => chunk.text))

      if (!options.skipExisting) {
        await vectorStore.deleteChunks(filePath)
      }

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

      await vectorStore.insertChunks(vectorChunks)

      stats.succeeded++
    } catch (error) {
      stats.failed++
      stats.failures.push({
        filePath,
        error: (error as Error).message,
      })
      if (options.failFast) {
        stats.processed++
        printProgress(stats)
        break
      }
    }

    stats.processed++
    if (stats.processed % options.progressEvery === 0) {
      printProgress(stats)
    }
  }

  const durationMs = Date.now() - stats.startTimeMs
  const summary = {
    total: stats.total,
    processed: stats.processed,
    succeeded: stats.succeeded,
    failed: stats.failed,
    skipped: stats.skipped,
    duration: formatDuration(durationMs),
    filesPerSecond: formatRate(stats.processed, durationMs),
    failures: stats.failures.slice(0, 20),
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log('Ingest summary:')
    console.log(summary)
  }

  if (options.failOnError && stats.failed > 0) {
    process.exit(1)
  }
}
