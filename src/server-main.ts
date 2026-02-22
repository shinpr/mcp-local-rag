// MCP Server entry point
import { RAGServer } from './server/index.js'
import type { GroupingMode } from './vectordb/index.js'

// ============================================
// Environment Variable Parsers
// ============================================

/**
 * Parse grouping mode from environment variable
 */
function parseGroupingMode(value: string | undefined): GroupingMode | undefined {
  if (!value) return undefined
  const normalized = value.toLowerCase().trim()
  if (normalized === 'similar' || normalized === 'related') {
    return normalized
  }
  console.error(
    `Invalid RAG_GROUPING value: "${value}". Expected "similar" or "related". Ignoring.`
  )
  return undefined
}

/**
 * Parse max distance from environment variable
 */
function parseMaxDistance(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(`Invalid RAG_MAX_DISTANCE value: "${value}". Expected positive number. Ignoring.`)
    return undefined
  }
  return parsed
}

/**
 * Parse max files from environment variable
 */
function parseMaxFiles(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    console.error(
      `Invalid RAG_MAX_FILES value: "${value}". Expected positive integer (>= 1). Ignoring.`
    )
    return undefined
  }
  return parsed
}

/**
 * Parse hybrid weight from environment variable
 */
function parseHybridWeight(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.error(
      `Invalid RAG_HYBRID_WEIGHT value: "${value}". Expected 0.0-1.0. Using default (0.6).`
    )
    return undefined
  }
  return parsed
}

// ============================================
// Server Startup
// ============================================

/**
 * Start the RAG MCP Server
 */
export async function startServer(): Promise<void> {
  try {
    // RAGServer configuration
    const config: ConstructorParameters<typeof RAGServer>[0] = {
      dbPath: process.env['DB_PATH'] || './lancedb/',
      modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
      cacheDir: process.env['CACHE_DIR'] || './models/',
      baseDir: process.env['BASE_DIR'] || process.cwd(),
      maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10), // 100MB
    }

    // Add quality filter settings only if defined
    const maxDistance = parseMaxDistance(process.env['RAG_MAX_DISTANCE'])
    const grouping = parseGroupingMode(process.env['RAG_GROUPING'])
    const maxFiles = parseMaxFiles(process.env['RAG_MAX_FILES'])
    const hybridWeight = parseHybridWeight(process.env['RAG_HYBRID_WEIGHT'])
    if (maxDistance !== undefined) {
      config.maxDistance = maxDistance
    }
    if (grouping !== undefined) {
      config.grouping = grouping
    }
    if (maxFiles !== undefined) {
      config.maxFiles = maxFiles
    }
    if (hybridWeight !== undefined) {
      config.hybridWeight = hybridWeight
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
