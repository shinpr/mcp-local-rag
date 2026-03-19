// CLI Ingest Tests
// Test Type: Unit Test
// Tests runIngest functionality with mocked dependencies

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // fs/promises
    stat: vi.fn(),
    readdir: vi.fn(),

    // Component instances
    parseFile: vi.fn(),
    parsePdf: vi.fn(),
    chunkText: vi.fn(),
    embedBatch: vi.fn(),
    initialize: vi.fn(),
    deleteChunks: vi.fn(),
    insertChunks: vi.fn().mockImplementation((chunks: unknown[]) => {
      // Log chunk key fields to stderr for verification
      for (const chunk of chunks) {
        const c = chunk as Record<string, unknown>
        console.error(
          `[mock:insertChunks] filePath=${c.filePath} chunkIndex=${c.chunkIndex} text=${c.text} vectorLen=${Array.isArray(c.vector) ? c.vector.length : 'none'}`
        )
      }
      return Promise.resolve(undefined)
    }),
    optimize: vi.fn().mockImplementation(() => {
      // Log optimize call to stderr for verification
      console.error('[mock:optimize] called')
      return Promise.resolve(undefined)
    }),
  }
})

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
  readdir: mocks.readdir,
}))

// Mock DocumentParser
vi.mock('../../parser/index.js', () => ({
  DocumentParser: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.parseFile = mocks.parseFile
    this.parsePdf = mocks.parsePdf
  }),
  SUPPORTED_EXTENSIONS: new Set(['.pdf', '.docx', '.txt', '.md']),
}))

// Mock SemanticChunker
vi.mock('../../chunker/index.js', () => ({
  SemanticChunker: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.chunkText = mocks.chunkText
  }),
}))

// Mock Embedder
vi.mock('../../embedder/index.js', () => ({
  Embedder: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.embedBatch = mocks.embedBatch
  }),
}))

// Mock VectorStore
vi.mock('../../vectordb/index.js', () => ({
  VectorStore: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = mocks.initialize
    this.deleteChunks = mocks.deleteChunks
    this.insertChunks = mocks.insertChunks
    this.optimize = mocks.optimize
  }),
}))

// Import after mocks are set up
import { parseArgs, resolveConfig, runIngest } from '../../cli/ingest.js'
import { resolveGlobalConfig } from '../../cli/options.js'

// ============================================
// Helpers
// ============================================

/**
 * Capture stderr output during a function call.
 * Uses vi.spyOn on console.error since the implementation uses console.error for stderr.
 */
function captureStderr(fn: () => Promise<void>): Promise<{ output: string[]; error: unknown }> {
  const output: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '))
  })

  return fn()
    .then(() => ({ output, error: undefined }))
    .catch((error: unknown) => ({ output, error }))
    .finally(() => {
      spy.mockRestore()
    })
}

/**
 * Create a mock stat result for a file.
 */
function mockFileStat() {
  return { isFile: () => true, isDirectory: () => false }
}

/**
 * Create a mock stat result for a directory.
 */
function mockDirStat() {
  return { isFile: () => false, isDirectory: () => true }
}

/**
 * Set up default successful mocks for single file ingestion.
 */
function setupSuccessfulIngestion() {
  mocks.parseFile.mockResolvedValue({ content: 'parsed text content', title: 'Test Title' })
  mocks.chunkText.mockResolvedValue([
    { text: 'chunk 1', index: 0 },
    { text: 'chunk 2', index: 1 },
  ])
  mocks.embedBatch.mockResolvedValue([
    [0.1, 0.2],
    [0.3, 0.4],
  ])
  mocks.deleteChunks.mockResolvedValue(undefined)
  mocks.initialize.mockResolvedValue(undefined)
  // insertChunks and optimize use default implementations from mock setup
  // that log to stderr for verification
}

// ============================================
// Tests
// ============================================

describe('CLI ingest', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock process.exit to throw so we can catch it
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
  // Single file ingest
  // --------------------------------------------
  it('should parse, chunk, embed, delete, insert, and optimize once for a single file', async () => {
    // Arrange
    const filePath = '/tmp/test/document.md'
    mocks.stat.mockResolvedValue(mockFileStat())
    setupSuccessfulIngestion()

    // Act
    const { output, error } = await captureStderr(() => runIngest([filePath]))

    // Assert: returns normally without process.exit
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: output shows success
    const joined = output.join('\n')
    expect(joined).toContain('OK (2 chunks)')
    expect(joined).toContain('Succeeded: 1')
    expect(joined).toContain('Failed:    0')
    expect(joined).toContain('Total chunks: 2')

    // Assert: optimize was called exactly once (verified via stderr marker)
    const optimizeLines = output.filter((line) => line.includes('[mock:optimize] called'))
    expect(optimizeLines).toHaveLength(1)

    // Assert: insertChunks received VectorChunk with expected structure
    const insertLines = output.filter((line) => line.includes('[mock:insertChunks]'))
    expect(insertLines).toHaveLength(2) // 2 chunks
    // Verify chunk 0 has correct filePath, chunkIndex, text, and vector
    expect(insertLines[0]).toContain(`filePath=${filePath}`)
    expect(insertLines[0]).toContain('chunkIndex=0')
    expect(insertLines[0]).toContain('text=chunk 1')
    expect(insertLines[0]).toContain('vectorLen=2')
    // Verify chunk 1
    expect(insertLines[1]).toContain(`filePath=${filePath}`)
    expect(insertLines[1]).toContain('chunkIndex=1')
    expect(insertLines[1]).toContain('text=chunk 2')
    expect(insertLines[1]).toContain('vectorLen=2')
  })

  // --------------------------------------------
  // Directory ingest
  // --------------------------------------------
  it('should recursively find supported files and ingest all when given a directory', async () => {
    // Arrange: first stat call for path validation, second for collectFiles
    const dirPath = '/tmp/test/docs'
    mocks.stat
      .mockResolvedValueOnce(mockDirStat()) // path validation in runIngest
      .mockResolvedValueOnce(mockDirStat()) // stat in collectFiles

    mocks.readdir.mockResolvedValue([
      { name: 'file1.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'file2.txt', parentPath: '/tmp/test/docs/sub', isFile: () => true },
      { name: 'subdir', parentPath: '/tmp/test/docs', isFile: () => false },
    ])

    setupSuccessfulIngestion()

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: returns normally without process.exit
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: both files processed, optimize called once
    const joined = output.join('\n')
    expect(joined).toContain('[1/2]')
    expect(joined).toContain('[2/2]')
    expect(joined).toContain('Succeeded: 2')
    expect(joined).toContain('Total chunks: 4')

    // Assert: optimize was called exactly once (not per-file)
    const optimizeLines = output.filter((line) => line.includes('[mock:optimize] called'))
    expect(optimizeLines).toHaveLength(1)
  })

  // --------------------------------------------
  // Skip unsupported files
  // --------------------------------------------
  it('should skip unsupported file extensions like .jpg', async () => {
    // Arrange
    const filePath = '/tmp/test/image.jpg'
    mocks.stat.mockResolvedValue(mockFileStat())

    // Act
    const { output, error } = await captureStderr(() => runIngest([filePath]))

    // Assert: exit(1) because no supported files found
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unsupported file extension: .jpg')
  })

  // --------------------------------------------
  // Error skip in bulk
  // --------------------------------------------
  it('should skip failed files and continue processing remaining files', async () => {
    // Arrange
    const dirPath = '/tmp/test/docs'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'good.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'bad.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'good2.txt', parentPath: '/tmp/test/docs', isFile: () => true },
    ])

    mocks.initialize.mockResolvedValue(undefined)
    mocks.optimize.mockResolvedValue(undefined)
    mocks.deleteChunks.mockResolvedValue(undefined)
    mocks.insertChunks.mockResolvedValue(undefined)
    mocks.embedBatch.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    mocks.chunkText.mockResolvedValue([
      { text: 'chunk 1', index: 0 },
      { text: 'chunk 2', index: 1 },
    ])

    // Make the second file (bad.md) fail at parse
    mocks.parseFile
      .mockResolvedValueOnce({ content: 'good content', title: 'Good' })
      .mockRejectedValueOnce(new Error('Parse error: corrupted file'))
      .mockResolvedValueOnce({ content: 'good content 2', title: 'Good2' })

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: returns normally with exitCode=1 for partial failure
    expect(error).toBeUndefined()
    expect(process.exitCode).toBe(1)

    const joined = output.join('\n')
    expect(joined).toContain('FAILED: Parse error: corrupted file')
    expect(joined).toContain('Succeeded: 2')
    expect(joined).toContain('Failed:    1')
  })

  // --------------------------------------------
  // Empty directory
  // --------------------------------------------
  it('should exit gracefully with message when directory has no supported files', async () => {
    // Arrange
    const dirPath = '/tmp/test/empty'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'readme.jpg', parentPath: '/tmp/test/empty', isFile: () => true },
    ])

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: exit(1) with "No supported files found"
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('No supported files found')
  })

  // --------------------------------------------
  // Non-existent path
  // --------------------------------------------
  it('should show error message and exit code 1 for non-existent path', async () => {
    // Arrange
    const filePath = '/tmp/test/nonexistent.md'
    mocks.stat.mockRejectedValue(new Error('ENOENT: no such file or directory'))

    // Act
    const { output, error } = await captureStderr(() => runIngest([filePath]))

    // Assert: exit(1) with error message
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Error: path does not exist')
    expect(joined).toContain(filePath)
  })

  // --------------------------------------------
  // Progress output
  // --------------------------------------------
  it('should output progress in [N/Total] format to stderr', async () => {
    // Arrange
    const dirPath = '/tmp/test/docs'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'a.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'b.txt', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'c.md', parentPath: '/tmp/test/docs/sub', isFile: () => true },
    ])

    setupSuccessfulIngestion()

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: returns normally without process.exit
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: progress format [N/Total]
    const joined = output.join('\n')
    expect(joined).toMatch(/\[1\/3\]/)
    expect(joined).toMatch(/\[2\/3\]/)
    expect(joined).toMatch(/\[3\/3\]/)
  })

  // --------------------------------------------
  // --help shows usage and exits
  // --------------------------------------------
  it('should show help text and exit with code 0 when --help is passed', async () => {
    // Act
    const { output, error } = await captureStderr(() => runIngest(['--help']))

    // Assert: exit(0)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    // Assert: help text contains ingest-specific information
    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('ingest')
    expect(joined).toContain('--base-dir')
    expect(joined).toContain('--max-file-size')
    expect(joined).toContain('-h, --help')
    expect(joined).toContain('104857600')
  })

  it('should show help text and exit with code 0 when -h is passed', async () => {
    // Act
    const { output, error } = await captureStderr(() => runIngest(['-h']))

    // Assert: exit(0)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('ingest')
  })

  // --------------------------------------------
  // Global options passed via globalOptions parameter
  // --------------------------------------------
  it('should use global options passed as parameter', async () => {
    // Arrange: ensure no env vars are set
    delete process.env['DB_PATH']
    delete process.env['BASE_DIR']
    delete process.env['CACHE_DIR']
    delete process.env['MODEL_NAME']
    delete process.env['MAX_FILE_SIZE']

    const filePath = '/tmp/test/document.md'
    mocks.stat.mockResolvedValue(mockFileStat())
    setupSuccessfulIngestion()

    // Act: pass global options via second parameter, ingest-specific via args
    const { error } = await captureStderr(() =>
      runIngest(['--base-dir', '/cli/base', '--max-file-size', '555', filePath], {
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli-model',
      })
    )

    // Assert: returns normally without process.exit
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: VectorStore was called with global db-path
    const { VectorStore } = await import('../../vectordb/index.js')
    expect(VectorStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath: '/cli/db' }))

    // Assert: Embedder was called with global model-name and cache-dir
    const { Embedder } = await import('../../embedder/index.js')
    expect(Embedder).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: 'cli-model',
        cacheDir: '/cli/cache',
      })
    )

    // Assert: DocumentParser was called with ingest-specific base-dir and max-file-size
    const { DocumentParser } = await import('../../parser/index.js')
    expect(DocumentParser).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: '/cli/base',
        maxFileSize: 555,
      })
    )
  })

  // --------------------------------------------
  // Global options via env vars (no CLI flags)
  // --------------------------------------------
  it('should use environment variables when no global options provided', async () => {
    // Arrange: set env vars
    process.env['DB_PATH'] = '/env/db'
    process.env['CACHE_DIR'] = '/env/cache'
    process.env['MODEL_NAME'] = 'env-model'

    const filePath = '/tmp/test/document.md'
    mocks.stat.mockResolvedValue(mockFileStat())
    setupSuccessfulIngestion()

    // Act: no global options
    const { error } = await captureStderr(() => runIngest([filePath]))

    // Assert: returns normally without process.exit
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: VectorStore was called with env db-path
    const { VectorStore } = await import('../../vectordb/index.js')
    expect(VectorStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath: '/env/db' }))

    // Assert: Embedder was called with env model-name and cache-dir
    const { Embedder } = await import('../../embedder/index.js')
    expect(Embedder).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: 'env-model',
        cacheDir: '/env/cache',
      })
    )

    // Cleanup
    delete process.env['DB_PATH']
    delete process.env['CACHE_DIR']
    delete process.env['MODEL_NAME']
  })

  // --------------------------------------------
  // Global options override env vars
  // --------------------------------------------
  it('should use global CLI flags over environment variables', async () => {
    // Arrange: set env vars
    process.env['DB_PATH'] = '/env/db'
    process.env['CACHE_DIR'] = '/env/cache'
    process.env['MODEL_NAME'] = 'env-model'

    const filePath = '/tmp/test/document.md'
    mocks.stat.mockResolvedValue(mockFileStat())
    setupSuccessfulIngestion()

    // Act: pass global options that should override env vars
    const { error } = await captureStderr(() =>
      runIngest([filePath], {
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli-model',
      })
    )

    // Assert: returns normally without process.exit
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: VectorStore was called with CLI db-path, not env
    const { VectorStore } = await import('../../vectordb/index.js')
    expect(VectorStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath: '/cli/db' }))

    // Assert: Embedder was called with CLI model-name and cache-dir
    const { Embedder } = await import('../../embedder/index.js')
    expect(Embedder).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: 'cli-model',
        cacheDir: '/cli/cache',
      })
    )

    // Cleanup
    delete process.env['DB_PATH']
    delete process.env['CACHE_DIR']
    delete process.env['MODEL_NAME']
  })

  // --------------------------------------------
  // Unknown options error (including global flags after subcommand)
  // --------------------------------------------
  it('should error when global flags are passed after subcommand', async () => {
    // Act
    const { output, error } = await captureStderr(() =>
      runIngest(['/some/path', '--db-path', '/db'])
    )

    // Assert: exit(1) with unknown option error
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unknown option: --db-path')
  })

  // --------------------------------------------
  // parseArgs unit tests
  // --------------------------------------------
  describe('parseArgs', () => {
    it('should parse positional argument only', () => {
      const result = parseArgs(['/some/path'])
      expect(result).toEqual({
        positional: '/some/path',
        options: {},
        help: false,
      })
    })

    it('should parse ingest-specific flags with positional', () => {
      const result = parseArgs(['--base-dir', '/base', '--max-file-size', '1024', '/target'])

      expect(result.positional).toBe('/target')
      expect(result.options).toEqual({
        baseDir: '/base',
        maxFileSize: 1024,
      })
      expect(result.help).toBe(false)
    })

    it('should parse --help flag', () => {
      const result = parseArgs(['--help'])
      expect(result.help).toBe(true)
    })

    it('should parse -h flag', () => {
      const result = parseArgs(['-h'])
      expect(result.help).toBe(true)
    })

    it('should handle flags before positional', () => {
      const result = parseArgs(['--base-dir', '/base', '/target'])
      expect(result.positional).toBe('/target')
      expect(result.options.baseDir).toBe('/base')
    })

    it('should handle flags after positional', () => {
      const result = parseArgs(['/target', '--base-dir', '/base'])
      expect(result.positional).toBe('/target')
      expect(result.options.baseDir).toBe('/base')
    })

    it('should error on unknown flags', () => {
      // --db-path is now a global option, not recognized by ingest parseArgs
      expect(() => parseArgs(['--db-path', '/db', '/target'])).toThrow('process.exit(1)')
    })

    // Regression test for issue #79
    it('should error when multiple positional arguments are given', () => {
      // Act & Assert
      expect(() => parseArgs(['/path1', '/path2'])).toThrow('process.exit(1)')
    })

    it('should error when --base-dir value is missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--base-dir'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --base-dir')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --max-file-size value is missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--max-file-size'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --max-file-size')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should detect --base-dir value starting with dash as missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--base-dir', '--max-file-size'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --base-dir')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  // --------------------------------------------
  // Issue #79 regression: multiple positional args
  // --------------------------------------------
  it('should error with message when extra positional arguments are given (issue #79)', async () => {
    // Act
    const { output, error } = await captureStderr(() => runIngest(['/path1', '/path2']))

    // Assert: exit(1) with descriptive error
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unexpected argument: /path2')
    expect(joined).toContain('Only one path is accepted')
  })

  // --------------------------------------------
  // No arguments shows usage
  // --------------------------------------------
  it('should show usage and exit with code 1 when no arguments provided', async () => {
    // Act
    const { output, error } = await captureStderr(() => runIngest([]))

    // Assert: exit(1)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag ingest')
  })

  // --------------------------------------------
  // resolveConfig validation
  // --------------------------------------------
  describe('resolveConfig validation', () => {
    afterEach(() => {
      delete process.env['BASE_DIR']
      delete process.env['MAX_FILE_SIZE']
    })

    it('should error when BASE_DIR env var points to sensitive path', () => {
      process.env['BASE_DIR'] = '/etc/documents'
      const globalConfig = resolveGlobalConfig({})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveConfig(globalConfig, {})).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sensitive system path'))
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when MAX_FILE_SIZE env var is zero', () => {
      process.env['MAX_FILE_SIZE'] = '0'
      const globalConfig = resolveGlobalConfig({})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveConfig(globalConfig, {})).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('must be between 1 and 524288000')
        )
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when MAX_FILE_SIZE env var is negative', () => {
      process.env['MAX_FILE_SIZE'] = '-100'
      const globalConfig = resolveGlobalConfig({})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveConfig(globalConfig, {})).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('must be between 1 and 524288000')
        )
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when MAX_FILE_SIZE env var exceeds 500MB', () => {
      process.env['MAX_FILE_SIZE'] = '999999999'
      const globalConfig = resolveGlobalConfig({})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveConfig(globalConfig, {})).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('must be between 1 and 524288000')
        )
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --base-dir CLI option points to sensitive path', () => {
      const globalConfig = resolveGlobalConfig({})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveConfig(globalConfig, { baseDir: '/proc/self' })).toThrow(
          'process.exit(1)'
        )
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sensitive system path'))
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --max-file-size CLI option is zero', () => {
      const globalConfig = resolveGlobalConfig({})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveConfig(globalConfig, { maxFileSize: 0 })).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('must be between 1 and 524288000')
        )
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
