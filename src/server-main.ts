// MCP Server entry point
import { validateModelName } from './cli/options.js'
import { RAGServer } from './server/index.js'
import type { GroupingMode } from './vectordb/index.js'

/** Regex for `VLM_DTYPE` env-resolution validation (alphanumeric + underscore; empty allowed) */
const VLM_DTYPE_PATTERN = /^[a-zA-Z0-9_]*$/

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
  if (!value) return { value: undefined }
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
  if (!value) return { value: undefined }
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
  if (!value) return { value: undefined }
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
  if (!value) return { value: undefined }
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
  if (!value) return { value: undefined }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 10000) {
    const warning = `Invalid CHUNK_MIN_LENGTH value: "${value.slice(0, 100)}". Expected integer between 1 and 10000. Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Resolve RAG_DEVICE. The value is passed through to transformers.js — no
 * allowlist is maintained here. Whitespace-only is treated as unset.
 */
export function parseDevice(value: string | undefined): ParseResult<string> {
  if (!value || value.trim() === '') return { value: 'cpu' }
  return { value: value.trim() }
}

// ============================================
// Server Startup
// ============================================

/**
 * Start the RAG MCP Server
 * Configuration is read from environment variables only (no CLI flags).
 * This ensures the bare `mcp-local-rag` launch is suitable for MCP clients.
 */
export async function startServer(): Promise<void> {
  try {
    // VLM env reads (validated; fail-fast with process.exit(1) on invalid).
    // No empty→default normalization at this layer — the captioner is the single
    // normalization site for VLM_DTYPE (DD §Captioner contract step 2).
    const vlmModelName = process.env['VLM_MODEL_NAME'] || 'onnx-community/granite-docling-258M-ONNX'
    const vlmModelNameError = validateModelName(vlmModelName)
    if (vlmModelNameError) {
      console.error(`Invalid VLM_MODEL_NAME: ${vlmModelNameError}`)
      process.exit(1)
    }
    const vlmDtype = process.env['VLM_DTYPE'] ?? ''
    if (!VLM_DTYPE_PATTERN.test(vlmDtype)) {
      console.error(
        `Invalid VLM_DTYPE: ${vlmDtype}. Only alphanumeric and '_' allowed (empty allowed).`
      )
      process.exit(1)
    }

    // RAGServer configuration (env-only for MCP client compatibility)
    const device = parseDevice(process.env['RAG_DEVICE']).value as string
    const config: ConstructorParameters<typeof RAGServer>[0] = {
      dbPath: process.env['DB_PATH'] || './lancedb/',
      modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: process.env['CACHE_DIR'] || './models/',
      baseDir: process.env['BASE_DIR'] || process.cwd(),
      maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10), // 100MB
      device,
      vlmModelName,
      vlmDtype,
    }

    // Collect configuration warnings
    const configWarnings: string[] = []

    // Add quality filter settings only if defined
    const maxDistance = parseMaxDistance(process.env['RAG_MAX_DISTANCE'])
    const grouping = parseGroupingMode(process.env['RAG_GROUPING'])
    const maxFiles = parseMaxFiles(process.env['RAG_MAX_FILES'])
    const hybridWeight = parseHybridWeight(process.env['RAG_HYBRID_WEIGHT'])
    const chunkMinLength = parseChunkMinLength(process.env['CHUNK_MIN_LENGTH'])
    if (maxDistance.value !== undefined) {
      config.maxDistance = maxDistance.value
    }
    if (maxDistance.warning) {
      configWarnings.push(maxDistance.warning)
    }
    if (grouping.value !== undefined) {
      config.grouping = grouping.value
    }
    if (grouping.warning) {
      configWarnings.push(grouping.warning)
    }
    if (maxFiles.value !== undefined) {
      config.maxFiles = maxFiles.value
    }
    if (maxFiles.warning) {
      configWarnings.push(maxFiles.warning)
    }
    if (hybridWeight.value !== undefined) {
      config.hybridWeight = hybridWeight.value
    }
    if (hybridWeight.warning) {
      configWarnings.push(hybridWeight.warning)
    }
    if (chunkMinLength.value !== undefined) {
      config.chunkMinLength = chunkMinLength.value
    }
    if (chunkMinLength.warning) {
      configWarnings.push(chunkMinLength.warning)
    }

    if (configWarnings.length > 0) {
      config.configWarnings = configWarnings
      console.error('Configuration warnings:', configWarnings.join(' | '))
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
