// CLI List Tests
// Test Type: Unit Test
// Tests runList functionality with mocked dependencies

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // fs/promises
    readdir: vi.fn(),

    // VectorStore instance methods
    initialize: vi.fn().mockResolvedValue(undefined),
    listFiles: vi.fn().mockResolvedValue([]),
  }
})

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readdir: mocks.readdir,
}))

// Mock cli/common.js (only createVectorStore needed — list does not use Embedder)
vi.mock('../../cli/common.js', () => ({
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    listFiles: mocks.listFiles,
  })),
}))

// Import after mocks are set up
import { parseArgs, runList } from '../../cli/list.js'

// ============================================
// Helpers
// ============================================

/**
 * Capture stderr output and stdout writes during a function call.
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

/**
 * Create a mock Dirent entry for readdir({ withFileTypes: true }).
 */
function mockDirent(
  name: string,
  parentPath: string,
  type: 'file' | 'directory' = 'file'
): {
  name: string
  parentPath: string
  isFile: () => boolean
  isDirectory: () => boolean
} {
  return {
    name,
    parentPath,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
  }
}

// ============================================
// Tests
// ============================================

describe('CLI list', () => {
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
  // --help
  // --------------------------------------------
  it('should show help text and exit with code 0 when --help is passed', async () => {
    const { stderr, error } = await captureOutput(() => runList(['--help']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('list')
    expect(joined).toContain('--base-dir')
    expect(joined).toContain('-h, --help')
  })

  it('should show help text and exit with code 0 when -h is passed', async () => {
    const { stderr, error } = await captureOutput(() => runList(['-h']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('list')
  })

  // --------------------------------------------
  // JSON output to stdout
  // --------------------------------------------
  it('should output JSON to stdout with file list', async () => {
    // Arrange: readdir returns some files
    const baseDir = process.cwd()
    mocks.readdir.mockResolvedValue([
      mockDirent('doc.md', baseDir),
      mockDirent('notes.txt', baseDir),
      mockDirent('image.jpg', baseDir),
    ])
    mocks.listFiles.mockResolvedValue([
      { filePath: `${baseDir}/doc.md`, chunkCount: 3, timestamp: '2025-01-01T00:00:00Z' },
    ])

    // Act
    const { stdout, error } = await captureOutput(() => runList([]))

    // Assert: no error
    expect(error).toBeUndefined()

    // Assert: JSON output to stdout
    expect(stdout.length).toBeGreaterThan(0)
    const result = JSON.parse(stdout.join(''))
    expect(result).toHaveProperty('baseDir')
    expect(result).toHaveProperty('files')
    expect(result).toHaveProperty('sources')

    // doc.md is ingested, notes.txt is not, image.jpg is unsupported (not listed)
    expect(result.files).toHaveLength(2)
    const docEntry = result.files.find((f: Record<string, unknown>) =>
      String(f.filePath).endsWith('doc.md')
    )
    expect(docEntry).toMatchObject({ ingested: true, chunkCount: 3 })
    const txtEntry = result.files.find((f: Record<string, unknown>) =>
      String(f.filePath).endsWith('notes.txt')
    )
    expect(txtEntry).toMatchObject({ ingested: false })
  })

  // --------------------------------------------
  // --base-dir option
  // --------------------------------------------
  it('should parse --base-dir option correctly', async () => {
    // Arrange
    mocks.readdir.mockResolvedValue([])
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() => runList(['--base-dir', '/tmp/my-docs']))

    // Assert: no error
    expect(error).toBeUndefined()

    // Assert: baseDir in output matches --base-dir flag
    const result = JSON.parse(stdout.join(''))
    expect(result.baseDir).toBe('/tmp/my-docs')
  })

  // --------------------------------------------
  // Unknown flags cause exit(1)
  // --------------------------------------------
  it('should exit with code 1 on unknown flags', async () => {
    const { stderr, error } = await captureOutput(() => runList(['--unknown']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Unknown option: --unknown')
  })

  it('should exit with code 1 on unexpected positional arguments', async () => {
    const { stderr, error } = await captureOutput(() => runList(['some-arg']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = stderr.join('\n')
    expect(joined).toContain('Unexpected argument')
  })

  // --------------------------------------------
  // baseDir resolution from env var fallback
  // --------------------------------------------
  it('should resolve baseDir from BASE_DIR env var when no --base-dir flag', async () => {
    // Arrange
    process.env['BASE_DIR'] = '/env/docs'
    mocks.readdir.mockResolvedValue([])
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() => runList([]))

    // Assert
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    expect(result.baseDir).toBe('/env/docs')

    // Cleanup
    delete process.env['BASE_DIR']
  })

  it('should prefer --base-dir flag over BASE_DIR env var', async () => {
    // Arrange
    process.env['BASE_DIR'] = '/env/docs'
    mocks.readdir.mockResolvedValue([])
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() => runList(['--base-dir', '/cli/docs']))

    // Assert
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    expect(result.baseDir).toBe('/cli/docs')

    // Cleanup
    delete process.env['BASE_DIR']
  })

  // --------------------------------------------
  // Sources (ingested via ingest_data)
  // --------------------------------------------
  it('should include sources for DB entries not found in baseDir scan', async () => {
    // Arrange
    mocks.readdir.mockResolvedValue([])
    mocks.listFiles.mockResolvedValue([
      {
        filePath: '/some/db/raw-data/aHR0cHM6Ly9leGFtcGxlLmNvbQ.md',
        chunkCount: 5,
        timestamp: '2025-06-01T00:00:00Z',
      },
    ])

    // Act
    const { stdout, error } = await captureOutput(() => runList([]))

    // Assert
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toHaveProperty('source')
    expect(result.sources[0].chunkCount).toBe(5)
  })

  // --------------------------------------------
  // Excludes dbPath and cacheDir from scan
  // --------------------------------------------
  it('should exclude dbPath and cacheDir paths from file scan', async () => {
    // Arrange
    const baseDir = process.cwd()
    const resolvedDbPath = `${process.cwd()}/lancedb`

    mocks.readdir.mockResolvedValue([
      mockDirent('doc.md', baseDir),
      mockDirent('chunks.md', `${resolvedDbPath}`),
    ])
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() => runList([]))

    // Assert
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    // Only doc.md should be listed, not chunks.md in lancedb dir
    const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
    expect(filePaths.some((p: string) => p.endsWith('doc.md'))).toBe(true)
    expect(filePaths.some((p: string) => p.includes('lancedb'))).toBe(false)
  })

  // --------------------------------------------
  // Error handling
  // --------------------------------------------
  it('should exit with code 1 when VectorStore initialization fails', async () => {
    // Arrange
    mocks.initialize.mockRejectedValue(new Error('DB connection failed'))

    // Act
    const { stderr, error } = await captureOutput(() => runList([]))

    // Assert
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    const joined = stderr.join('\n')
    expect(joined).toContain('DB connection failed')
  })

  // --------------------------------------------
  // parseArgs unit tests
  // --------------------------------------------
  describe('parseArgs', () => {
    it('should parse empty args', () => {
      const result = parseArgs([])
      expect(result).toEqual({ options: {}, help: false })
    })

    it('should parse --base-dir flag', () => {
      const result = parseArgs(['--base-dir', '/my/docs'])
      expect(result).toEqual({ options: { baseDir: '/my/docs' }, help: false })
    })

    it('should parse --help flag', () => {
      const result = parseArgs(['--help'])
      expect(result).toEqual({ options: {}, help: true })
    })

    it('should parse -h flag', () => {
      const result = parseArgs(['-h'])
      expect(result).toEqual({ options: {}, help: true })
    })

    it('should error on unknown flags', () => {
      expect(() => parseArgs(['--verbose'])).toThrow('process.exit(1)')
    })

    it('should error on positional arguments', () => {
      expect(() => parseArgs(['some-path'])).toThrow('process.exit(1)')
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

    it('should detect --base-dir value starting with dash as missing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseArgs(['--base-dir', '--help'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --base-dir')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
