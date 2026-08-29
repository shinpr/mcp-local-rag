// CLI ingest subcommand — bulk file ingestion with single optimize() at end

import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import { buildPreparedFileVectorChunks, prepareFileForIngest } from '../ingest/file.js'
import { DocumentParser } from '../parser/index.js'
import { QUALITY_PROFILES, type QualityProfile } from '../pdf-visual/types.js'
import type { BaseDirsConfig, BaseDirsConfigWarning } from '../utils/base-dirs.js'
import { DEFAULT_MAX_FILE_SIZE, MAX_CHUNK_MIN_LENGTH } from '../utils/limits.js'
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
  /**
   * Collected `--base-dir` values in CLI order. Repeatable: each flag
   * occurrence appends one entry. An empty array means the flag was not
   * provided (resolver then falls through to env / cwd).
   */
  baseDirs?: string[] | undefined
  maxFileSize?: number | undefined
  chunkMinLength?: number | undefined
  visual?: boolean | undefined
  images?: boolean | undefined
  /**
   * Visual-quality profile selector. Only meaningful when `visual` is true;
   * silently ignored otherwise (mirrors the existing `--visual` precedent
   * of silently coercing for non-PDF files). Defaults to `'fast'`.
   */
  visualQuality?: QualityProfile | undefined
}

interface ParsedArgs {
  positional: string | undefined
  options: IngestCliOptions
  help: boolean
}

function isQualityProfile(value: string): value is QualityProfile {
  return QUALITY_PROFILES.some((profile) => profile === value)
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
      case '--max-file-size': {
        const raw = requireFlagValue(args, i, '--max-file-size')
        if (!/^\d+$/.test(raw)) {
          console.error(`Invalid value for --max-file-size: "${raw.slice(0, 100)}"`)

          process.exit(1)
        }
        options.maxFileSize = Number.parseInt(raw, 10)
        i += 2
        break
      }
      case '--chunk-min-length': {
        const raw = requireFlagValue(args, i, '--chunk-min-length')
        if (!/^\d+$/.test(raw)) {
          console.error(`Invalid value for --chunk-min-length: "${raw.slice(0, 100)}"`)

          process.exit(1)
        }
        options.chunkMinLength = Number.parseInt(raw, 10)
        i += 2
        break
      }
      case '--visual':
        // Boolean toggle: no value consumed. Mirrors the -h/--help pattern.
        options.visual = true
        i++
        break
      case '--images':
        options.images = true
        i++
        break
      case '--visual-quality': {
        const value = requireFlagValue(args, i, '--visual-quality')
        if (!isQualityProfile(value)) {
          console.error(
            `Invalid value for --visual-quality: "${value.slice(0, 100)}". Expected "fast" or "quality".`
          )
          process.exit(1)
        }
        options.visualQuality = value
        i += 2
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
 *
 * Base directories are resolved via the shared CLI resolver
 * ({@link resolveCliBaseDirsOrExit}) which applies the documented precedence
 * (CLI roots > `BASE_DIRS` > `BASE_DIR` > `cwd`), realpath-normalizes every
 * effective root, dedupes exact duplicates, and prunes nested roots. CLI
 * roots are pre-validated against the sensitive-path policy here so the
 * user sees `--base-dir`-attributed errors before the resolver touches the
 * filesystem.
 *
 * Other ingest-specific values (maxFileSize, chunkMinLength) follow the
 * existing CLI > env > defaults order and are validated against the same
 * ranges as before.
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

/**
 * Options for `ingestSingleFile`. VLM configuration is required only when
 * visual captions are enabled.
 */
export type IngestSingleFileOptions =
  | { visual?: false | undefined; images?: false | undefined }
  | { visual: false; images: true }
  | {
      visual: true
      images?: boolean | undefined
      profile: QualityProfile
      cacheDir: string
      device?: string | undefined
    }

/**
 * Ingest a single file: hash, parse, chunk, embed, delete old chunks, insert new
 * chunks. Returns the number of chunks inserted.
 *
 * When `options.visual === true` AND the file is a `.pdf`, routes through the
 * visual-enrichment path: `parsePdfPages` + VLM captioning (`pdf-visual`
 * orchestrator) + joined-text chunking. `pdf-visual` is loaded via dynamic
 * `await import('../pdf-visual/index.js')` so the default (non-visual) path
 * never pulls the VLM module into the bundle.
 *
 * Non-visual, non-PDF, and `visual: true` + non-PDF paths all use the default
 * text-only branch and never load `pdf-visual`.
 */
export async function ingestSingleFile(
  filePath: string,
  parser: DocumentParser,
  chunker: SemanticChunker,
  embedder: Embedder,
  vectorStore: VectorStore,
  options?: IngestSingleFileOptions
): Promise<number> {
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  const prepared = await prepareFileForIngest(filePath, parser, chunker, embedder, {
    images: options?.images === true,
    ...(options?.visual === true
      ? {
          captioner: {
            profile: options.profile,
            cacheDir: options.cacheDir,
            device: options.device,
          },
        }
      : {}),
  })
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
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i]!
      const label = `[${i + 1}/${files.length}]`

      try {
        // Forward visual + VLM env-resolved options into the per-file ingestor.
        // `ingestSingleFile` routes through the visual path when
        // `options.visual === true && filePath.endsWith('.pdf')`. The two
        // variants of `IngestSingleFileOptions` are built explicitly so the
        // VLM fields only travel with the visual-true branch (the cacheDir is
        // pre-validated by `resolveGlobalConfig` so the captioner does not
        // re-read `process.env['CACHE_DIR']` raw).
        const ingestOptions: IngestSingleFileOptions = options.visual
          ? {
              visual: true,
              images: options.images === true,
              // Default the profile to `'fast'` when `--visual-quality` was
              // not provided. The flag is silently ignored when `--visual`
              // itself is absent (mirrors the existing `--visual` precedent
              // of silently coercing for non-PDF files).
              profile: options.visualQuality ?? 'fast',
              cacheDir: globalConfig.cacheDir,
              device: resolveDevice(process.env['RAG_DEVICE']),
            }
          : options.images
            ? { visual: false, images: true }
            : { visual: false, images: false }
        const chunkCount = await ingestSingleFile(
          filePath,
          parser,
          chunker,
          embedder,
          vectorStore,
          ingestOptions
        )
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
