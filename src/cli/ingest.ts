// CLI ingest subcommand — bulk file ingestion with single optimize() at end

import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import {
  buildPreparedFileVectorChunks,
  type PrepareFileForIngestOptions,
  prepareFileForIngest,
} from '../ingest/file.js'
import { DocumentParser } from '../parser/index.js'
import type { BaseDirsConfig, BaseDirsConfigWarning } from '../utils/base-dirs.js'
import { DEFAULT_MAX_FILE_SIZE, MAX_CHUNK_MIN_LENGTH } from '../utils/limits.js'
import type { QualityProfile } from '../utils/visual-profile.js'
import type { VectorStore } from '../vectordb/index.js'
import {
  createEmbedder,
  createVectorStore,
  formatCliError,
  resolveCliBaseDirsOrExit,
} from './common.js'
import { collectFiles } from './file-collection.js'
import type { GlobalOptions, ResolvedGlobalConfig } from './options.js'
import {
  consumeBaseDirArg,
  requireFlagValue,
  requireVisualQuality,
  resolveDevice,
  resolveGlobalConfig,
  validateChunkMinLength,
  validateMaxFileSize,
  validatePath,
} from './options.js'

// ============================================
// Types
// ============================================

interface IngestConfig {
  baseDirs: BaseDirsConfig
  baseDirsWarnings: BaseDirsConfigWarning[]
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
  /** Repeatable, in CLI order. Empty means unset — the resolver uses env / cwd. */
  baseDirs?: string[] | undefined
  maxFileSize?: number | undefined
  chunkMinLength?: number | undefined
  visual?: boolean | undefined
  images?: boolean | undefined
  /** Silently ignored unless `visual` is true. Defaults to `'fast'`. */
  visualQuality?: QualityProfile | undefined
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
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
} as const

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] ingest [options] <path>

Ingest a single file or all supported files under a directory.

Options:
  --base-dir <path>          Base directory for documents (repeatable: pass once per root; default: BASE_DIRS/BASE_DIR env or cwd)
  --max-file-size <n>        Max file size in bytes (default: ${INGEST_DEFAULTS.maxFileSize})
  --chunk-min-length <n>     Minimum chunk length in characters (default: 50, range: 1-${MAX_CHUNK_MIN_LENGTH})
  --visual                   Enable VLM captioning for PDF figure pages (PDFs only; no effect on other types)
  --images                   Store bounded PDF figures/tables and Mammoth DOCX images
  --visual-quality <profile> VLM profile when --visual is set: fast (default, lightweight) or quality (Qwen2.5-VL-3B, ~10x cache, ~2x inference)
  -h, --help                 Show this help

Global options (must appear before "ingest"):
  --db-path <path>         LanceDB database path
  --cache-dir <path>       Model cache directory
  --model-name <name>      Embedding model`

// ============================================
// Arg Parsing
// ============================================

/** A global flag passed after the subcommand is an error, not a pass-through. */
/** Read a flag whose value must be a bare non-negative integer. */
function requireCountFlag(args: string[], flagIndex: number, flag: string): number {
  const raw = requireFlagValue(args, flagIndex, flag)
  if (!/^\d+$/.test(raw)) {
    console.error(`Invalid value for ${flag}: "${raw.slice(0, 100)}"`)
    process.exit(1)
  }
  return Number.parseInt(raw, 10)
}

/** Reject an unknown flag, or a second positional path. */
function rejectUnexpectedArgument(arg: string, positional: string | undefined): void {
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
}

export function parseArgs(args: string[]): ParsedArgs {
  const options: IngestCliOptions = {}
  let positional: string | undefined
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i] ?? ''
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        i++
        break
      case '--base-dir': {
        // Repeatable: each `--base-dir <path>` occurrence appends one entry
        // to `options.baseDirs`. The accumulator is lazily initialized so
        // an absent flag leaves `options.baseDirs` as `undefined`, which
        // the resolver treats as "fall through to env / cwd".
        if (options.baseDirs === undefined) {
          options.baseDirs = []
        }
        const valueIndex = consumeBaseDirArg(args, i, options.baseDirs)
        i = valueIndex + 1
        break
      }
      case '--max-file-size':
        options.maxFileSize = requireCountFlag(args, i, '--max-file-size')
        i += 2
        break
      case '--chunk-min-length':
        options.chunkMinLength = requireCountFlag(args, i, '--chunk-min-length')
        i += 2
        break
      case '--visual':
        // Boolean toggle: no value consumed. Mirrors the -h/--help pattern.
        options.visual = true
        i++
        break
      case '--images':
        options.images = true
        i++
        break
      case '--visual-quality':
        options.visualQuality = requireVisualQuality(args, i)
        i += 2
        break
      default:
        rejectUnexpectedArgument(arg, positional)
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
 * Merge global config with ingest-specific options (CLI > env > defaults).
 *
 * CLI roots are pre-validated against the sensitive-path policy here, so the
 * user gets `--base-dir`-attributed errors before the resolver touches disk.
 */
export async function resolveConfig(
  globalConfig: ResolvedGlobalConfig,
  ingestOptions: IngestCliOptions = {}
): Promise<IngestConfig> {
  const cliBaseDirs = ingestOptions.baseDirs ?? []

  // Validate CLI-supplied paths against the sensitive-path policy before
  // calling the resolver. Doing this here (rather than relying on the
  // resolver) keeps the error message attributed to `--base-dir` and avoids
  // an unnecessary realpath round-trip on a path we will reject anyway.
  for (const root of cliBaseDirs) {
    const baseDirError = validatePath(root, '--base-dir')
    if (baseDirError) {
      console.error(baseDirError)
      process.exit(1)
    }
  }

  const { config: baseDirs, warnings: baseDirsWarnings } =
    await resolveCliBaseDirsOrExit(cliBaseDirs)

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
    baseDirs,
    baseDirsWarnings,
    maxFileSize,
  }
  if (chunkMinLength !== undefined) {
    resolved.chunkMinLength = chunkMinLength
  }
  return resolved
}

// ============================================
// Per-file Ingestion
// ============================================

/** Collaborators one CLI ingest run needs, injected as a unit. */
export interface SingleFileIngestCollaborators {
  parser: DocumentParser
  chunker: SemanticChunker
  embedder: Embedder
  vectorStore: VectorStore
}

/**
 * Ingest one file, returning the number of chunks inserted.
 *
 * `options` is the shared preparation contract, passed straight through: a
 * `captioner` on a `.pdf` routes through VLM captioning, and `pdf-visual` is
 * loaded by dynamic import, so no other path pulls the VLM module in.
 */
export async function ingestSingleFile(
  filePath: string,
  collaborators: SingleFileIngestCollaborators,
  options: PrepareFileForIngestOptions = { images: false }
): Promise<number> {
  const { parser, chunker, embedder, vectorStore } = collaborators
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  const prepared = await prepareFileForIngest(filePath, { parser, chunker, embedder }, options)
  if (prepared.omittedImageCount > 0) {
    console.error(
      `  Warning: skipped ${prepared.omittedImageCount} undecodable or oversized ${isPdf ? 'PDF' : 'DOCX'} image(s)`
    )
  }
  if (prepared.chunks.length === 0) {
    console.error(`  Warning: 0 chunks generated (file may be empty or too short)`)
    return 0
  }

  const vectorChunks = buildPreparedFileVectorChunks(prepared)

  // Delete existing chunks for this file, then insert the new ones
  await vectorStore.deleteChunks(filePath)
  await vectorStore.insertChunks(vectorChunks)

  return vectorChunks.length
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Turn a resolved per-file request into shared preparation options. The
 * captioner block travels only with a non-null profile, carrying the cacheDir
 * `resolveGlobalConfig` validated. Shared by `ingest` and CLI `sync`, so both
 * reach the VLM through one mapping.
 */
export function buildFileIngestOptions(
  request: { images: boolean; visualProfile: QualityProfile | null },
  globalConfig: ResolvedGlobalConfig
): PrepareFileForIngestOptions {
  if (request.visualProfile === null) {
    return { images: request.images }
  }
  return {
    images: request.images,
    captioner: {
      profile: request.visualProfile,
      cacheDir: globalConfig.cacheDir,
      device: resolveDevice(process.env['RAG_DEVICE']),
    },
  }
}

/** Require a positional path argument that names something on disk. */
async function requireExistingPath(positional: string | undefined): Promise<string> {
  if (!positional) {
    console.error('Usage: mcp-local-rag ingest [options] <path>')
    console.error('  Ingest a single file or all supported files under a directory.')
    console.error('  Run with --help for all options.')
    process.exit(1)
  }
  try {
    await stat(positional)
  } catch {
    console.error(`Error: path does not exist: ${positional}`)
    process.exit(1)
  }
  return positional
}

export async function runIngest(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { positional, options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  const targetPath = await requireExistingPath(positional)

  // Resolve config: CLI flags > env vars > defaults
  const globalConfig = resolveGlobalConfig(globalOptions)
  const config = await resolveConfig(globalConfig, options)
  const excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]

  // Surface resolver warnings (precedence, nested-root pruning) on stderr
  // before scan output starts.
  for (const warning of config.baseDirsWarnings) {
    console.error(warning.message)
  }

  // Directory mode scans only the positional directory; configured roots are
  // the containment boundary used by collectFiles and DocumentParser.
  const files = await collectFiles(targetPath, config.baseDirs.baseDirs, excludePaths)
  if (files.length === 0) {
    console.error('No supported files found.')
    process.exit(1)
  }

  console.error(`Found ${files.length} file(s) to ingest.`)

  // Initialize components (single instances reused across all files).
  // The parser receives the full multi-root config. The directory-scan loop
  // (`collectFiles`) iterates every effective root in `config.baseDirs.baseDirs`
  // and dedupes overlap.
  const parser = new DocumentParser({
    baseDirs: config.baseDirs.baseDirs,
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

  try {
    for (const [i, filePath] of files.entries()) {
      const label = `[${i + 1}/${files.length}]`

      try {
        const chunkCount = await ingestSingleFile(
          filePath,
          { parser, chunker, embedder, vectorStore },
          buildFileIngestOptions(
            {
              images: options.images === true,
              // `--visual-quality` defaults to `fast` and is silently ignored
              // without `--visual`, mirroring how `--visual` itself is silently
              // coerced away for non-PDF files.
              visualProfile: options.visual === true ? (options.visualQuality ?? 'fast') : null,
            },
            globalConfig
          )
        )
        if (chunkCount === 0) {
          // 0 chunks is a skip/warning, not a failure
          console.error(`${label} ${filePath} ... SKIPPED (0 chunks)`)
        } else {
          console.error(`${label} ${filePath} ... OK (${chunkCount} chunks)`)
          summary.totalChunks += chunkCount
        }
        summary.succeeded++
      } catch (error) {
        const reason = formatCliError(error)
        console.error(`${label} ${filePath} ... FAILED: ${reason}`)
        summary.failed++
      }
    }

    // Optimize once at end (not per-file)
    await vectorStore.optimize()
  } finally {
    await embedder.dispose()
    await vectorStore.close()
  }

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
