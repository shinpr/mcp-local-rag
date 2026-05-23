// MCP Server entry point
import { resolveDevice } from './cli/options.js'
import { RAGServer } from './server/index.js'
import { BaseDirsConfigError, parseBaseDirsEnv, resolveBaseDirs } from './utils/base-dirs.js'
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
    // RAGServer configuration (env-only for MCP client compatibility). The
    // VLM profile selection (`fast` vs `quality`) is a per-ingest parameter
    // on the `ingest_file` MCP tool and is not configured here.
    const device = resolveDevice(process.env['RAG_DEVICE'])

    // Collect configuration warnings (resolver + parse* helpers all funnel
    // into this single array so RAGServer.configWarnings stays the one
    // source of truth surfaced via MCP content blocks — P3-T3).
    const configWarnings: string[] = []

    // Resolve effective base directories from env. The resolver is the
    // single source of truth for BASE_DIRS / BASE_DIR / cwd precedence and
    // never silently falls back on invalid BASE_DIRS (AC-010 — root-
    // dependent tools will surface the error; `status` remains callable).
    // Server startup does not consume CLI flags (env-only for MCP client
    // compatibility), so `cliRoots` is intentionally omitted here.
    //
    // Sensitive-path pre-check on the RAW user-supplied paths (Finding #3):
    // run the policy against the values supplied via env before the resolver
    // realpath-normalizes them. On platforms where `/etc` realpaths to
    // `/private/etc` (macOS), checking only the post-realpath value would
    // miss the sensitive prefix. Errors from this pre-check produce a
    // configError mirroring the post-realpath path below.
    const rawSensitiveErrors: string[] = []
    if (process.env['BASE_DIRS'] !== undefined && process.env['BASE_DIRS'].length > 0) {
      const parsed = parseBaseDirsEnv(process.env['BASE_DIRS'])
      if (parsed.ok) {
        for (const raw of parsed.value) {
          const sensitive = checkSensitivePath(raw, 'BASE_DIRS')
          if (sensitive) rawSensitiveErrors.push(sensitive)
        }
      }
      // Malformed BASE_DIRS surfaces via resolveBaseDirs below; nothing
      // additional to do here.
    } else if (process.env['BASE_DIR'] !== undefined && process.env['BASE_DIR'].trim().length > 0) {
      const sensitive = checkSensitivePath(process.env['BASE_DIR'], 'BASE_DIR')
      if (sensitive) rawSensitiveErrors.push(sensitive)
    }

    const baseDirsResult = await resolveBaseDirs({
      envBaseDirs: process.env['BASE_DIRS'],
      envBaseDir: process.env['BASE_DIR'],
      cwd: process.cwd(),
    })

    let baseDirsForServer: string[]
    let configError: BaseDirsConfigError | undefined
    if (baseDirsResult.ok) {
      // Apply the sensitive-path policy to every env-resolved root (post-
      // realpath) as well as the pre-check above. A path that traversed a
      // symlink into a sensitive directory only shows up in the realpath
      // form. Attribute rejections to the env var that supplied the value.
      const sourceFlag =
        process.env['BASE_DIRS'] !== undefined && process.env['BASE_DIRS'].length > 0
          ? 'BASE_DIRS'
          : 'BASE_DIR'
      const sensitiveErrors: string[] = [...rawSensitiveErrors]
      for (const root of baseDirsResult.config.baseDirs) {
        const sensitive = checkSensitivePath(root, sourceFlag)
        if (sensitive) sensitiveErrors.push(sensitive)
      }
      if (sensitiveErrors.length > 0) {
        // Treat the rejection as a config error: the server stays callable
        // (so `status` works) but every root-dependent tool fails fast. No
        // silent cwd fallback — see Finding #4.
        baseDirsForServer = []
        // Dedup identical messages so a path that matches the raw-form check
        // AND the post-realpath check reports once.
        configError = new BaseDirsConfigError([...new Set(sensitiveErrors)].join('; '))
        configWarnings.push(configError.message)
      } else {
        baseDirsForServer = baseDirsResult.config.baseDirs
        for (const warning of baseDirsResult.warnings) {
          configWarnings.push(warning.message)
        }
      }
    } else {
      // Degraded mode: pass an empty `baseDirs` so any code path that
      // forgets the `assertConfigOk` guard fails closed (rather than
      // operating against `cwd`). The `configError` is stashed on the
      // server so root-dependent tools surface it; `status` remains callable
      // and exposes the diagnostic content block (AC-010). Removed the
      // pre-existing `[process.cwd()]` fallback per Finding #4.
      baseDirsForServer = []
      configError = baseDirsResult.error
      configWarnings.push(baseDirsResult.error.message)
    }

    // Build the immutable config object. `baseDirs` carries the resolver
    // output (or the degraded-mode cwd fallback); the discriminated union
    // in RAGServerConfig forbids passing `baseDir` alongside `baseDirs`.
    const config: ConstructorParameters<typeof RAGServer>[0] = {
      dbPath: process.env['DB_PATH'] || './lancedb/',
      modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: process.env['CACHE_DIR'] || './models/',
      baseDirs: baseDirsForServer,
      maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10), // 100MB
      device,
    }

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
    if (configError !== undefined) {
      config.configError = configError
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
