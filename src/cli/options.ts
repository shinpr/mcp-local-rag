// Shared CLI global options — parsed before subcommand routing

import { MAX_FILE_SIZE_LIMIT } from '../utils/limits.js'
import { checkSensitivePath } from '../utils/sensitive-path.js'

// ============================================
// Validation Helpers
// ============================================

/**
 * Validate that a path is not a sensitive system directory.
 * Delegates to the shared `checkSensitivePath` helper so the CLI and the
 * MCP server entry point share one policy implementation.
 *
 * Returns an error message if invalid, or undefined if valid.
 */
export function validatePath(value: string, flagName: string): string | undefined {
  return checkSensitivePath(value, flagName)
}

/**
 * Validate model name against allowed pattern.
 * Returns an error message if invalid, or undefined if valid.
 */
export function validateModelName(value: string): string | undefined {
  const pattern = /^[a-zA-Z0-9_\-./]+$/
  if (!pattern.test(value)) {
    return `Invalid model name: ${value}. Only alphanumeric, '_', '-', '.', '/' allowed.`
  }
  if (value.includes('..')) {
    return `Invalid model name: ${value}. Path traversal ('..') is not allowed.`
  }
  return undefined
}

/**
 * Validate max file size is within acceptable range.
 * Returns an error message if invalid, or undefined if valid.
 */
export function validateMaxFileSize(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 1 || value > MAX_FILE_SIZE_LIMIT) {
    return `--max-file-size must be between 1 and ${MAX_FILE_SIZE_LIMIT} (500MB)`
  }
  return undefined
}

/**
 * Validate chunk minimum length is within acceptable range.
 * Returns an error message if invalid, or undefined if valid.
 */
export function validateChunkMinLength(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 1 || value > 10000) {
    return '--chunk-min-length must be between 1 and 10000'
  }
  return undefined
}

// ============================================
// Repeatable --base-dir parsing
// ============================================

/**
 * Consume the value that follows a `--base-dir` flag and append it to
 * `collected`. Designed to be called from each subcommand's argv loop so
 * `--base-dir <path>` can be provided one or more times, with the order
 * preserved.
 *
 * `argv` is the full argv slice the loop is iterating; `flagIndex` is the
 * index of the `--base-dir` token itself. On success returns the index of
 * the value (so the caller can advance past it). On failure prints
 * `Missing value for --base-dir` to stderr and calls `process.exit(1)` —
 * matching the existing single-value error path so callers don't have to
 * special-case the new shape.
 *
 * Why a shared helper: both `ingest` and `list` parse `--base-dir` in
 * identical fashion, so centralizing the accumulate-and-validate step keeps
 * the two argv loops in lockstep when the contract evolves.
 */
export function consumeBaseDirArg(argv: string[], flagIndex: number, collected: string[]): number {
  const valueIndex = flagIndex + 1
  const value = argv[valueIndex]
  if (value === undefined || value.startsWith('-')) {
    console.error('Missing value for --base-dir')
    process.exit(1)
  }
  collected.push(value)
  return valueIndex
}

/**
 * Read the required value that follows a value-taking flag at `argv[flagIndex]`.
 * Centralizes the identical "missing value" guard every value flag used to
 * inline (`--db-path`, `--cache-dir`, `--model-name`, `--max-file-size`,
 * `--chunk-min-length`, `--limit`): when the next token is absent or is itself
 * a flag, prints `Missing value for <flag>` and exits 1. The caller advances
 * its index by 2 (flag + value). Numeric flags apply their own format/range
 * validation to the returned string.
 */
export function requireFlagValue(argv: string[], flagIndex: number, flag: string): string {
  const value = argv[flagIndex + 1]
  if (value === undefined || value.startsWith('-')) {
    console.error(`Missing value for ${flag}`)
    process.exit(1)
  }
  return value
}

// ============================================
// Types
// ============================================

export interface GlobalOptions {
  dbPath?: string | undefined
  cacheDir?: string | undefined
  modelName?: string | undefined
}

export interface ParsedGlobalResult {
  globalOptions: GlobalOptions
  remainingArgs: string[]
}

export interface ResolvedGlobalConfig {
  dbPath: string
  cacheDir: string
  modelName: string
}

// ============================================
// Defaults
// ============================================

export const GLOBAL_DEFAULTS = {
  dbPath: './lancedb/',
  cacheDir: './models/',
  modelName: 'Xenova/all-MiniLM-L6-v2',
} as const

// ============================================
// Help
// ============================================

export const ROOT_HELP_TEXT = `Usage: mcp-local-rag [options] <command>

Options:
  --db-path <path>       LanceDB database path (default: ${GLOBAL_DEFAULTS.dbPath})
  --cache-dir <path>     Model cache directory (default: ${GLOBAL_DEFAULTS.cacheDir})
  --model-name <name>    Embedding model (default: ${GLOBAL_DEFAULTS.modelName})
  -h, --help             Show this help

Commands:
  ingest <path>          Ingest files into the vector database
  query <text>           Search ingested documents
  read-neighbors         Read N chunks before and after a target chunk within the same document
  list                   List files and ingestion status
  status                 Show database status
  delete <path>          Delete ingested content
  skills install         Install Claude Code / Codex skills`

// ============================================
// Global Option Parsing
// ============================================

/**
 * Extract global options (--db-path, --cache-dir, --model-name, -h/--help)
 * from the argument list and return them along with the remaining args.
 *
 * Global options are only recognized BEFORE the first non-flag argument
 * (the subcommand). After the subcommand, everything is forwarded as-is.
 */
export function parseGlobalOptions(args: string[]): ParsedGlobalResult {
  const globalOptions: GlobalOptions = {}
  let help = false
  let i = 0

  // Parse global flags until we hit a non-flag (subcommand) or end of args
  while (i < args.length) {
    const arg = args[i]!
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        i++
        break
      case '--db-path': {
        globalOptions.dbPath = requireFlagValue(args, i, '--db-path')
        i += 2
        break
      }
      case '--cache-dir': {
        globalOptions.cacheDir = requireFlagValue(args, i, '--cache-dir')
        i += 2
        break
      }
      case '--model-name': {
        globalOptions.modelName = requireFlagValue(args, i, '--model-name')
        i += 2
        break
      }
      default:
        // If arg starts with -, it's an unknown global flag
        if (arg.startsWith('-')) {
          console.error(`Unknown global option: ${arg}`)
          console.error('Run "mcp-local-rag --help" for available options.')
          process.exit(1)
        }
        // First non-global-flag token: treat as subcommand boundary.
        // Everything from here onward is returned as remainingArgs.
        if (help) {
          // If --help was seen before subcommand, show root help
          console.error(ROOT_HELP_TEXT)
          process.exit(0)
        }
        return { globalOptions, remainingArgs: args.slice(i) }
    }
  }

  // All args consumed (no subcommand found)
  if (help) {
    console.error(ROOT_HELP_TEXT)
    process.exit(0)
  }

  return { globalOptions, remainingArgs: [] }
}

// ============================================
// Config Resolution
// ============================================

/**
 * Resolve global config with priority: CLI flags > environment variables > defaults.
 * Validates all resolved values before returning.
 */
export function resolveGlobalConfig(options: GlobalOptions): ResolvedGlobalConfig {
  const dbPath = options.dbPath ?? process.env['DB_PATH'] ?? GLOBAL_DEFAULTS.dbPath
  const cacheDir = options.cacheDir ?? process.env['CACHE_DIR'] ?? GLOBAL_DEFAULTS.cacheDir
  const modelName = options.modelName ?? process.env['MODEL_NAME'] ?? GLOBAL_DEFAULTS.modelName

  // Validate paths
  const dbPathError = validatePath(dbPath, '--db-path')
  if (dbPathError) {
    console.error(dbPathError)
    process.exit(1)
  }

  const cacheDirError = validatePath(cacheDir, '--cache-dir')
  if (cacheDirError) {
    console.error(cacheDirError)
    process.exit(1)
  }

  // Validate model name
  const modelNameError = validateModelName(modelName)
  if (modelNameError) {
    console.error(modelNameError)
    process.exit(1)
  }

  return { dbPath, cacheDir, modelName }
}

/**
 * Resolve RAG_DEVICE. The value is passed through to transformers.js — no
 * allowlist is maintained here. Whitespace-only is treated as unset.
 */
export function resolveDevice(value: string | undefined): string {
  if (!value || value.trim() === '') return 'cpu'
  return value.trim()
}
