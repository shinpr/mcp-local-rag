// CLI Query Tests
// Test Type: Unit Test
// Tests runQuery functionality with mocked dependencies

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const cliCommonFactory = () => ({
  createEmbedder: vi.fn().mockImplementation(() => ({
    embedBatch: mocks.embedBatch,
    dispose: vi.fn(),
  })),
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    search: mocks.search,
    close: vi.fn(),
  })),
  // Catch-block renderer; faithful shim preserves the `Error: <message>`
  // stderr behavior the tests assert.
  formatCliError: formatCliErrorShim,
})

// NOTE: the mock factory below mirrors the NEW raw-data-utils contract.
// Managed raw-data detection is based on the configured database path; the
// boundary check `isPathInRawDataDir` is exported for parity but unused by
// the query subcommand (no path traversal surface).
const rawDataUtilsFactory = () => ({
  isManagedRawDataPath: vi
    .fn()
    .mockImplementation((filePath: string) => filePath.includes('/raw-data/')),
  isPathInRawDataDir: vi.fn().mockResolvedValue(false),
  extractSourceFromPath: vi.fn().mockImplementation((filePath: string) => {
    if (!filePath.includes('/raw-data/')) return null
    return 'https://example.com/page'
  }),
})

const MOCKED_PATHS = ['../../cli/common.js', '../../utils/raw-data-utils.js'] as const

import { formatCliErrorShim } from './cli-error-shim.js'

let parseArgs: typeof import('../../cli/query.js').parseArgs
let runQuery: typeof import('../../cli/query.js').runQuery

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

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../cli/common.js', cliCommonFactory)
    vi.doMock('../../utils/raw-data-utils.js', rawDataUtilsFactory)
    ;({ parseArgs, runQuery } = await import('../../cli/query.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

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

    expect(mocks.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ queryText: 'my search query', limit: 5 })
    )
  })

  it('should use default limit of 10 when --limit is not specified', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['my search query']))

    expect(mocks.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ queryText: 'my search query', limit: 10 })
    )
  })

  // --------------------------------------------
  // --scope threading into search options
  // --------------------------------------------
  it('should thread a single --scope value into search options', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['--scope', 'docs/', 'my search query']))

    expect(mocks.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ queryText: 'my search query', limit: 10, scope: ['docs/'] })
    )
  })

  it('should thread repeated --scope values into search options as an array', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['--scope', 'docs/', '--scope', 'src/', 'my search query']))

    expect(mocks.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ scope: ['docs/', 'src/'] })
    )
  })

  it('should not include scope in search options when --scope is absent', async () => {
    mocks.search.mockResolvedValue([])

    await captureOutput(() => runQuery(['my search query']))

    const callOptions = mocks.search.mock.calls[0]?.[1]
    expect(callOptions.scope).toBeUndefined()
  })

  it('should exit with code 1 when --scope value is empty', async () => {
    const { stderr, error } = await captureOutput(() => runQuery(['--scope', '', 'search text']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('--scope')
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

    it('should parse a single --scope into a one-element array', () => {
      const result = parseArgs(['--scope', 'docs/', 'search text'])
      expect(result.queryText).toBe('search text')
      expect(result.options.scope).toEqual(['docs/'])
    })

    it('should accumulate repeated --scope into an array preserving order', () => {
      const result = parseArgs(['--scope', 'docs/', '--scope', 'src/', 'search text'])
      expect(result.options.scope).toEqual(['docs/', 'src/'])
    })

    it('should trim surrounding whitespace from a --scope value', () => {
      const result = parseArgs(['--scope', '  docs/  ', 'search text'])
      expect(result.options.scope).toEqual(['docs/'])
    })

    it('should leave scope undefined when --scope is absent', () => {
      const result = parseArgs(['search text'])
      expect(result.options.scope).toBeUndefined()
    })

    it('should error when --scope value is empty', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--scope', '', 'search text'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('--scope value must not be empty')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --scope value is whitespace-only', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--scope', '   ', 'search text'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('--scope value must not be empty')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --scope value is missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--scope'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --scope')
      } finally {
        errorSpy.mockRestore()
      }
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
    expect(mocks.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ queryText: 'query', limit: 1 })
    )
  })

  it('should accept --limit 20 (maximum)', async () => {
    mocks.search.mockResolvedValue([])

    const { error } = await captureOutput(() => runQuery(['--limit', '20', 'query']))

    expect(error).toBeUndefined()
    expect(mocks.search).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ queryText: 'query', limit: 20 })
    )
  })
})
