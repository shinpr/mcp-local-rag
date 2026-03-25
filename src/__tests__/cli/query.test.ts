// CLI Query Tests
// Test Type: Unit Test
// Tests runQuery functionality with mocked dependencies

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // VectorStore methods
    initialize: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),

    // Embedder methods
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  }
})

// Mock cli/common.js (createVectorStore / createEmbedder factories)
vi.mock('../../cli/common.js', () => ({
  createEmbedder: vi.fn().mockImplementation(() => ({
    embedBatch: mocks.embedBatch,
  })),
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    search: mocks.search,
  })),
}))

// Mock raw-data-utils
vi.mock('../../utils/raw-data-utils.js', () => ({
  isRawDataPath: vi.fn().mockImplementation((filePath: string) => filePath.includes('/raw-data/')),
  extractSourceFromPath: vi.fn().mockImplementation((filePath: string) => {
    if (!filePath.includes('/raw-data/')) return null
    return 'https://example.com/page'
  }),
}))

// Import after mocks are set up
import { parseArgs, runQuery } from '../../cli/query.js'

// ============================================
// Helpers
// ============================================

/**
 * Capture stderr and stdout output during a function call.
 */
function captureOutput(
  fn: () => Promise<void>
): Promise<{ stderr: string[]; stdout: string[]; error: unknown }> {
  const stderr: string[] = []
  const stdout: string[] = []
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  })
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return true
    })

  return fn()
    .then(() => ({ stderr, stdout, error: undefined }))
    .catch((error: unknown) => ({ stderr, stdout, error }))
    .finally(() => {
      errorSpy.mockRestore()
      stdoutSpy.mockRestore()
    })
}

// ============================================
// Tests
// ============================================

describe('CLI query', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })
  })

  afterEach(() => {
    exitSpy.mockRestore()
    process.exitCode = undefined
  })

  // --------------------------------------------
  // --help shows usage and exits with code 0
  // --------------------------------------------
  it('should show help text and exit with code 0 when --help is passed', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--help']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('query')
    expect(joined).toContain('--limit')
    expect(joined).toContain('-h, --help')
  })

  it('should show help text and exit with code 0 when -h is passed', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['-h']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('query')
  })

  // --------------------------------------------
  // Query text is required
  // --------------------------------------------
  it('should exit with code 1 when no query text is provided', async () => {
    const { stderr, error } = await captureOutput(() => runQuery([]))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('query')
  })

  // --------------------------------------------
  // --limit validation
  // --------------------------------------------
  it('should exit with code 1 when --limit is 0', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--limit', '0', 'search text']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('--limit must be between 1 and 20')
  })

  it('should exit with code 1 when --limit is 21', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--limit', '21', 'search text']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('--limit must be between 1 and 20')
  })

  it('should exit with code 1 when --limit is not a number', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--limit', 'abc', 'search text']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('--limit must be between 1 and 20')
  })

  it('should exit with code 1 when --limit value is missing', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--limit']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Missing value for --limit')
  })

  it('should exit with code 1 when --limit value starts with dash', async () => {
    const { stderr, error } = await captureOutput(() =>
      runQuery(['--limit', '--help', 'search text'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Missing value for --limit')
  })

  // --------------------------------------------
  // JSON output to stdout with search results
  // --------------------------------------------
  it('should output JSON array to stdout with search results', async () => {
    mocks.search.mockResolvedValue([
      {
        filePath: '/path/to/file.md',
        chunkIndex: 0,
        text: 'matched content',
        score: 0.25,
        fileTitle: 'Document Title',
        metadata: { fileName: 'file.md', fileSize: 100, fileType: 'md' },
      },
      {
        filePath: '/path/to/another.md',
        chunkIndex: 1,
        text: 'another match',
        score: 0.5,
        fileTitle: null,
        metadata: { fileName: 'another.md', fileSize: 200, fileType: 'md' },
      },
    ])

    const { stdout, error } = await captureOutput(() => runQuery(['my search query']))

    expect(error).toBeUndefined()

    const parsed = JSON.parse(stdout.join(''))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({
      filePath: '/path/to/file.md',
      chunkIndex: 0,
      text: 'matched content',
      score: 0.25,
      fileTitle: 'Document Title',
    })
    expect(parsed[1]).toEqual({
      filePath: '/path/to/another.md',
      chunkIndex: 1,
      text: 'another match',
      score: 0.5,
      fileTitle: null,
    })
  })

  it('should use embedBatch with query text for embedding generation', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['my search query']))

    expect(mocks.embedBatch).toHaveBeenCalledWith(['my search query'])
  })

  it('should pass limit to vectorStore.search', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['--limit', '5', 'my search query']))

    expect(mocks.search).toHaveBeenCalledWith(expect.any(Array), 'my search query', 5)
  })

  it('should use default limit of 10 when --limit is not specified', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['my search query']))

    expect(mocks.search).toHaveBeenCalledWith(expect.any(Array), 'my search query', 10)
  })

  // --------------------------------------------
  // Source restoration for raw-data files
  // --------------------------------------------
  it('should restore source field for raw-data files', async () => {
    mocks.search.mockResolvedValue([
      {
        filePath: '/db/raw-data/encoded.md',
        chunkIndex: 0,
        text: 'raw data content',
        score: 0.1,
        fileTitle: null,
        metadata: { fileName: 'encoded.md', fileSize: 50, fileType: 'md' },
      },
      {
        filePath: '/path/to/regular.md',
        chunkIndex: 0,
        text: 'regular content',
        score: 0.2,
        fileTitle: 'Regular',
        metadata: { fileName: 'regular.md', fileSize: 100, fileType: 'md' },
      },
    ])

    const { stdout, error } = await captureOutput(() => runQuery(['search text']))

    expect(error).toBeUndefined()

    const parsed = JSON.parse(stdout.join(''))
    expect(parsed).toHaveLength(2)

    // Raw-data file should have source field
    expect(parsed[0].source).toBe('https://example.com/page')
    expect(parsed[0].filePath).toBe('/db/raw-data/encoded.md')

    // Regular file should NOT have source field
    expect(parsed[1].source).toBeUndefined()
  })

  // --------------------------------------------
  // Unknown flags cause exit(1)
  // --------------------------------------------
  it('should exit with code 1 when unknown flags are passed', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--unknown', 'search text']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Unknown option: --unknown')
  })

  it('should error when global flags are passed after subcommand', async () => {
    const { stderr, error } = await captureOutput(() =>
      runQuery(['--db-path', '/db', 'search text'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Unknown option: --db-path')
  })

  // --------------------------------------------
  // Error handling
  // --------------------------------------------
  it('should exit with code 1 and show error on search failure', async () => {
    mocks.search.mockRejectedValue(new Error('Database connection failed'))

    const { stderr, error } = await captureOutput(() => runQuery(['search text']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Database connection failed')
  })

  // --------------------------------------------
  // GlobalOptions parameter
  // --------------------------------------------
  it('should pass global options to resolveGlobalConfig', async () => {
    mocks.search.mockResolvedValue([])

    const { error } = await captureOutput(() =>
      runQuery(['search text'], {
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli-model',
      })
    )

    expect(error).toBeUndefined()

    const { createVectorStore } = await import('../../cli/common.js')
    expect(createVectorStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath: '/cli/db' }))

    const { createEmbedder } = await import('../../cli/common.js')
    expect(createEmbedder).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'cli-model',
        cacheDir: '/cli/cache',
      })
    )
  })

  // --------------------------------------------
  // parseArgs unit tests
  // --------------------------------------------
  describe('parseArgs', () => {
    it('should parse query text as positional argument', () => {
      const result = parseArgs(['my search query'])
      expect(result).toEqual({
        queryText: 'my search query',
        options: {},
        help: false,
      })
    })

    it('should parse --limit option', () => {
      const result = parseArgs(['--limit', '5', 'search text'])
      expect(result).toEqual({
        queryText: 'search text',
        options: { limit: 5 },
        help: false,
      })
    })

    it('should parse --help flag', () => {
      const result = parseArgs(['--help'])
      expect(result.help).toBe(true)
    })

    it('should parse -h flag', () => {
      const result = parseArgs(['-h'])
      expect(result.help).toBe(true)
    })

    it('should handle --limit before query text', () => {
      const result = parseArgs(['--limit', '3', 'my query'])
      expect(result.queryText).toBe('my query')
      expect(result.options.limit).toBe(3)
    })

    it('should handle query text before --limit', () => {
      const result = parseArgs(['my query', '--limit', '3'])
      expect(result.queryText).toBe('my query')
      expect(result.options.limit).toBe(3)
    })

    it('should error on unknown flags', () => {
      expect(() => parseArgs(['--db-path', '/db'])).toThrow('process.exit(1)')
    })

    it('should error when --limit value is missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--limit'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --limit')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --limit value is non-numeric', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--limit', 'abc', 'query text'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('--limit must be between 1 and 20')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --limit value contains trailing non-digits', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--limit', '5abc', 'query text'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('--limit must be between 1 and 20')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should detect --limit value starting with dash as missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--limit', '--help'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --limit')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when multiple positional arguments are given', () => {
      expect(() => parseArgs(['first query', 'second query'])).toThrow('process.exit(1)')
    })
  })

  // --------------------------------------------
  // Empty results
  // --------------------------------------------
  it('should output empty JSON array when no results found', async () => {
    mocks.search.mockResolvedValue([])

    const { stdout, error } = await captureOutput(() => runQuery(['no matches']))

    expect(error).toBeUndefined()

    const parsed = JSON.parse(stdout.join(''))
    expect(parsed).toEqual([])
  })

  // --------------------------------------------
  // --limit boundary values
  // --------------------------------------------
  it('should accept --limit 1 (minimum)', async () => {
    mocks.search.mockResolvedValue([])

    const { error } = await captureOutput(() => runQuery(['--limit', '1', 'query']))

    expect(error).toBeUndefined()
    expect(mocks.search).toHaveBeenCalledWith(expect.any(Array), 'query', 1)
  })

  it('should accept --limit 20 (maximum)', async () => {
    mocks.search.mockResolvedValue([])

    const { error } = await captureOutput(() => runQuery(['--limit', '20', 'query']))

    expect(error).toBeUndefined()
    expect(mocks.search).toHaveBeenCalledWith(expect.any(Array), 'query', 20)
  })
})
