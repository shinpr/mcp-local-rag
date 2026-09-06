// MCP Server entry point
import { resolveDevice, resolveDtype } from './cli/options.js'
import { RAGServer } from './server/index.js'
import { BaseDirsConfigError, parseBaseDirsEnv, resolveBaseDirs } from './utils/base-dirs.js'
import { DEFAULT_MAX_FILE_SIZE, MAX_CHUNK_MIN_LENGTH, MAX_FILE_SIZE_LIMIT } from './utils/limits.js'
import { checkSensitivePath } from './utils/sensitive-path.js'
import type { GroupingMode } from './vectordb/index.js'

// ============================================
// Environment Variable Parsers
// ============================================

/** Result of parsing an environment variable */
export interface ParseResult<T> {
  value: T | undefined
  warning?: string
}

/**
 * Parse grouping mode from environment variable
 */
export function parseGroupingMode(value: string | undefined): ParseResult<GroupingMode> {
  if (!value) {
    return { value: undefined }
  }
  const normalized = value.toLowerCase().trim()
  if (normalized === 'similar' || normalized === 'related') {
    return { value: normalized }
  }
  const warning = `Invalid RAG_GROUPING value: "${value.slice(0, 100)}". Expected "similar" or "related". Ignoring.`
  return { value: undefined, warning }
}

/**
 * Parse max distance from environment variable
 */
export function parseMaxDistance(value: string | undefined): ParseResult<number> {
  if (!value) {
    return { value: undefined }
  }
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed <= 0 || !Number.isFinite(parsed)) {
    const warning = `Invalid RAG_MAX_DISTANCE value: "${value.slice(0, 100)}". Expected positive number. Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Parse max files from environment variable
 */
export function parseMaxFiles(value: string | undefined): ParseResult<number> {
  if (!value) {
    return { value: undefined }
  }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    const warning = `Invalid RAG_MAX_FILES value: "${value.slice(0, 100)}". Expected positive integer (>= 1). Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Parse hybrid weight from environment variable
 */
export function parseHybridWeight(value: string | undefined): ParseResult<number> {
  if (!value) {
    return { value: undefined }
  }
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    const warning = `Invalid RAG_HYBRID_WEIGHT value: "${value.slice(0, 100)}". Expected 0.0-1.0. Using default (0.6).`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Parse chunk minimum length from environment variable
 */
export function parseChunkMinLength(value: string | undefined): ParseResult<number> {
  if (!value) {
    return { value: undefined }
  }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_CHUNK_MIN_LENGTH) {
    const warning = `Invalid CHUNK_MIN_LENGTH value: "${value.slice(0, 100)}". Expected integer between 1 and ${MAX_CHUNK_MIN_LENGTH}. Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/** Parse the independent PDF image-storage toggle. */
export function parseStoreImages(value: string | undefined): ParseResult<boolean> {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (normalized.length === 0) {
    return { value: false }
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return { value: true }
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return { value: false }
  }
  return {
    value: false,
    warning: `Invalid STORE_IMAGES value: "${value?.slice(0, 100)}". Expected one of 1, true, yes, on, 0, false, no, or off. Using false.`,
  }
}

// ============================================
// Server Startup
// ============================================

/** Resolved server config type, named so helpers can share it. */
type ServerConfig = ConstructorParameters<typeof RAGServer>[0]

/** Checked before realpath, which would turn `/etc` into `/private/etc`. */
function collectRawSensitiveErrors(env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = []
  const baseDirs = env['BASE_DIRS']
  if (baseDirs !== undefined && baseDirs.length > 0) {
    const parsed = parseBaseDirsEnv(baseDirs)
    if (!parsed.ok) {
      return errors
    }
    for (const raw of parsed.value) {
      const sensitive = checkSensitivePath(raw, 'BASE_DIRS')
      if (sensitive) {
        errors.push(sensitive)
      }
    }
    return errors
  }
  const baseDir = env['BASE_DIR']
  if (baseDir !== undefined && baseDir.trim().length > 0) {
    const sensitive = checkSensitivePath(baseDir, 'BASE_DIR')
    if (sensitive) {
      errors.push(sensitive)
    }
  }
  return errors
}

/** Roots the server will serve, plus whatever made them unusable. */
interface ResolvedRoots {
  baseDirs: string[]
  /** Normal-path roots, index-aligned with `baseDirs`, for list_files display. */
  rawBaseDirs: string[]
  configError?: BaseDirsConfigError
  warnings: string[]
}

/** No usable root: every tool that needs one fails closed with `error`. */
function noRoots(error: BaseDirsConfigError): ResolvedRoots {
  return { baseDirs: [], rawBaseDirs: [], configError: error, warnings: [error.message] }
}

async function resolveRoots(env: NodeJS.ProcessEnv, cwd: string): Promise<ResolvedRoots> {
  // Raw sensitive-path matches take precedence over resolver errors.
  const rawSensitiveErrors = collectRawSensitiveErrors(env)
  if (rawSensitiveErrors.length > 0) {
    return noRoots(new BaseDirsConfigError([...new Set(rawSensitiveErrors)].join('; ')))
  }

  const result = await resolveBaseDirs({
    envBaseDirs: env['BASE_DIRS'],
    envBaseDir: env['BASE_DIR'],
    cwd,
  })
  if (!result.ok) {
    return noRoots(result.error)
  }

  const baseDirs = env['BASE_DIRS']
  const sourceFlag = baseDirs !== undefined && baseDirs.length > 0 ? 'BASE_DIRS' : 'BASE_DIR'
  const sensitiveErrors: string[] = []
  for (const root of result.config.baseDirs) {
    const sensitive = checkSensitivePath(root, sourceFlag)
    if (sensitive) {
      sensitiveErrors.push(sensitive)
    }
  }
  if (sensitiveErrors.length > 0) {
    return noRoots(new BaseDirsConfigError([...new Set(sensitiveErrors)].join('; ')))
  }
  return {
    baseDirs: result.config.baseDirs,
    rawBaseDirs: result.config.rawBaseDirs,
    warnings: result.warnings.map((warning) => warning.message),
  }
}

function resolveMaxFileSize(env: NodeJS.ProcessEnv): { value: number; warning?: string } {
  const raw = env['MAX_FILE_SIZE']
  const parsed = raw ? Number(raw) : DEFAULT_MAX_FILE_SIZE
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_FILE_SIZE_LIMIT) {
    return {
      value: DEFAULT_MAX_FILE_SIZE,
      warning: `Invalid MAX_FILE_SIZE value: "${raw?.slice(0, 100)}". Expected integer between 1 and ${MAX_FILE_SIZE_LIMIT}. Using default (${DEFAULT_MAX_FILE_SIZE}).`,
    }
  }
  return { value: parsed }
}

/**
 * Apply the quality-filter settings that are only set when defined, so an unset
 * variable keeps meaning "use the downstream default". Returns their warnings.
 */
function applyOptionalSettings(config: ServerConfig, env: NodeJS.ProcessEnv): string[] {
  const maxDistance = parseMaxDistance(env['RAG_MAX_DISTANCE'])
  const grouping = parseGroupingMode(env['RAG_GROUPING'])
  const maxFiles = parseMaxFiles(env['RAG_MAX_FILES'])
  const hybridWeight = parseHybridWeight(env['RAG_HYBRID_WEIGHT'])
  const chunkMinLength = parseChunkMinLength(env['CHUNK_MIN_LENGTH'])
  const storeImages = parseStoreImages(env['STORE_IMAGES'])

  if (maxDistance.value !== undefined) {
    config.maxDistance = maxDistance.value
  }
  if (grouping.value !== undefined) {
    config.grouping = grouping.value
  }
  if (maxFiles.value !== undefined) {
    config.maxFiles = maxFiles.value
  }
  if (hybridWeight.value !== undefined) {
    config.hybridWeight = hybridWeight.value
  }
  if (chunkMinLength.value !== undefined) {
    config.chunkMinLength = chunkMinLength.value
  }
  config.storeImages = storeImages.value ?? false

  return [maxDistance, grouping, maxFiles, hybridWeight, chunkMinLength, storeImages]
    .map((parsed) => parsed.warning)
    .filter((warning): warning is string => warning !== undefined)
}

/**
 * Single source of truth for BASE_DIRS / BASE_DIR / cwd precedence. A resolver
 * error never falls back to cwd.
 */
export async function resolveServerConfig(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<ServerConfig> {
  const roots = await resolveRoots(env, cwd)
  const maxFileSize = resolveMaxFileSize(env)
  const configWarnings = [...roots.warnings]
  if (maxFileSize.warning !== undefined) {
    configWarnings.push(maxFileSize.warning)
  }

  const config: ServerConfig = {
    dbPath: env['DB_PATH'] || './lancedb/',
    modelName: env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
    cacheDir: env['CACHE_DIR'] || './models/',
    baseDirs: roots.baseDirs,
    rawBaseDirs: roots.rawBaseDirs,
    maxFileSize: maxFileSize.value,
    device: resolveDevice(env['RAG_DEVICE']),
    storeImages: false,
  }

  configWarnings.push(...applyOptionalSettings(config, env))

  // Set dtype only when defined, so config.dtype === undefined keeps meaning
  // "RAG_DTYPE unset" (the embedder then applies its fp32 default).
  const dtype = resolveDtype(env['RAG_DTYPE'])
  if (dtype !== undefined) {
    config.dtype = dtype
  }

  if (configWarnings.length > 0) {
    config.configWarnings = configWarnings
  }
  if (roots.configError !== undefined) {
    config.configError = roots.configError
  }

  return config
}

/** Env-only configuration, so a bare `mcp-local-rag` launch suits MCP clients. */
export async function startServer(): Promise<void> {
  try {
    const config = await resolveServerConfig(process.env, process.cwd())

    if (config.configWarnings && config.configWarnings.length > 0) {
      console.error('Configuration warnings:', config.configWarnings.join(' | '))
    }

    console.error('Starting RAG MCP Server...')
    console.error('Configuration:', config)

    // Start RAGServer
    const server = new RAGServer(config)
    await server.initialize()
    await server.run()

    console.error('RAG MCP Server started successfully')
  } catch (error) {
    console.error('Failed to start RAG MCP Server:', error)
    process.exit(1)
  }
}
