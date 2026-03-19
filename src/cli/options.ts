// Shared CLI global options — parsed before subcommand routing

// ============================================
// Validation Helpers
// ============================================

/**
 * Sensitive system directories that should never be used as data paths.
 * Checked as path prefixes (after resolving ~ to $HOME).
 */
const SENSITIVE_PATH_PREFIXES = ['/etc', '/usr', '/sys', '/proc', '/var']
const SENSITIVE_HOME_PREFIXES = ['.ssh', '.gnupg']

/**
 * Validate that a path is not a sensitive system directory.
 * Returns an error message if invalid, or undefined if valid.
 */
export function validatePath(value: string, flagName: string): string | undefined {
  const normalized = value.startsWith('~/')
    ? `${process.env['HOME'] ?? ''}/${value.slice(2)}`
    : value

  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return `Refusing to use sensitive system path for ${flagName}: ${value}`
    }
  }

  for (const dir of SENSITIVE_HOME_PREFIXES) {
    const homePath = `${process.env['HOME'] ?? ''}/${dir}`
    if (normalized === homePath || normalized.startsWith(`${homePath}/`)) {
      return `Refusing to use sensitive system path for ${flagName}: ${value}`
    }
    // Also check the unexpanded form
    if (value === `~/${dir}` || value.startsWith(`~/${dir}/`)) {
      return `Refusing to use sensitive system path for ${flagName}: ${value}`
    }
  }

  return undefined
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
  if (!Number.isFinite(value) || value < 1 || value > 524288000) {
    return '--max-file-size must be between 1 and 524288000 (500MB)'
  }
  return undefined
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
        const value = args[++i]
        if (value === undefined || value.startsWith('-')) {
          console.error('Missing value for --db-path')
          process.exit(1)
        }
        globalOptions.dbPath = value
        i++
        break
      }
      case '--cache-dir': {
        const value = args[++i]
        if (value === undefined || value.startsWith('-')) {
          console.error('Missing value for --cache-dir')
          process.exit(1)
        }
        globalOptions.cacheDir = value
        i++
        break
      }
      case '--model-name': {
        const value = args[++i]
        if (value === undefined || value.startsWith('-')) {
          console.error('Missing value for --model-name')
          process.exit(1)
        }
        globalOptions.modelName = value
        i++
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
