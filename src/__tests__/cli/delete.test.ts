// CLI Delete Tests
// Test Type: Unit Test
// Tests runDelete functionality with mocked dependencies

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // VectorStore instance methods
    initialize: vi.fn(),
    deleteChunks: vi.fn(),
    optimize: vi.fn(),
    // fs.unlink
    unlink: vi.fn(),
  }
})

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const cliCommonFactory = () => ({
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    deleteChunks: mocks.deleteChunks,
    optimize: mocks.optimize,
  })),
  // Catch-block renderer; faithful shim preserves the `Error: <message>`
  // stderr behavior the tests assert.
  formatCliError: formatCliErrorShim,
})

const fsPromisesFactory = async (
  importOriginal: () => Promise<typeof import('node:fs/promises')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    unlink: mocks.unlink,
  }
}

const MOCKED_PATHS = ['../../cli/common.js', 'node:fs/promises'] as const

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { formatCliErrorShim } from './cli-error-shim.js'

let runDelete: typeof import('../../cli/delete.js').runDelete

// Temp dbPath used by the raw-data cleanup tests so the boundary check's
// realpath() resolves a real file. `unlink` itself stays mocked, so we
// observe the call without actually removing anything.
const cleanupDbPath = resolve('./tmp/test-cli-delete-cleanup-db')

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

// ============================================
// Tests
// ============================================

describe('CLI delete', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../cli/common.js', cliCommonFactory)
    vi.doMock('node:fs/promises', fsPromisesFactory)
    ;({ runDelete } = await import('../../cli/delete.js'))
  })

  afterAll(async () => {
    await rm(cleanupDbPath, { recursive: true, force: true })
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock process.exit to throw so we can catch it
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })
    // Spy on process.stdout.write to capture JSON output
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Default: VectorStore methods succeed
    mocks.initialize.mockResolvedValue(undefined)
    mocks.deleteChunks.mockResolvedValue(0)
    mocks.optimize.mockResolvedValue(undefined)
    mocks.unlink.mockResolvedValue(undefined)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stdoutSpy.mockRestore()
    process.exitCode = undefined
  })

  // --------------------------------------------
  // --help shows usage and exits with code 0
  // --------------------------------------------
  it('should show help text and exit with code 0 when --help is passed', async () => {
    const { output, error } = await captureStderr(() => runDelete(['--help']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('delete')
    expect(joined).toContain('-h, --help')
    expect(joined).toContain('--source')
  })

  it('should show help text and exit with code 0 when -h is passed', async () => {
    const { output, error } = await captureStderr(() => runDelete(['-h']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('delete')
  })

  // --------------------------------------------
  // Either <file-path> or --source is required
  // --------------------------------------------
  it('should exit with code 1 when neither file-path nor --source is provided', async () => {
    const { output, error } = await captureStderr(() => runDelete([]))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Either <file-path> or --source is required')
  })

  // --------------------------------------------
  // Both <file-path> and --source cannot be provided
  // --------------------------------------------
  it('should exit with code 1 when both file-path and --source are provided', async () => {
    const { output, error } = await captureStderr(() =>
      runDelete(['--source', 'https://example.com', '/path/to/file.md'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Cannot specify both')
  })

  // --------------------------------------------
  // Delete by file path
  // --------------------------------------------
  it('should delete by file path and output JSON result', async () => {
    const { error } = await captureStderr(() => runDelete(['/path/to/file.md']))

    expect(error).toBeUndefined()

    // Verify VectorStore interactions
    expect(mocks.initialize).toHaveBeenCalledTimes(1)
    expect(mocks.deleteChunks).toHaveBeenCalledWith(resolve('/path/to/file.md'))
    expect(mocks.optimize).toHaveBeenCalledTimes(1)

    // Verify JSON output to stdout
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const writtenData = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(writtenData)
    expect(parsed.filePath).toBe(resolve('/path/to/file.md'))
    expect(parsed.deleted).toBe(true)
    expect(parsed.removedChunks).toBe(0)
    expect(parsed.existed).toBe(false)
    expect(parsed.timestamp).toBeDefined()
  })

  // --------------------------------------------
  // Delete by --source
  // --------------------------------------------
  it('should delete by --source, generating raw-data path', async () => {
    const { error } = await captureStderr(() => runDelete(['--source', 'https://example.com/page']))

    expect(error).toBeUndefined()

    // Verify deleteChunks was called with a generated raw-data path
    expect(mocks.deleteChunks).toHaveBeenCalledTimes(1)
    const calledPath = mocks.deleteChunks.mock.calls[0]![0] as string
    expect(calledPath).toContain('raw-data')
    expect(calledPath).toMatch(/\.md$/)

    // Verify optimize was called
    expect(mocks.optimize).toHaveBeenCalledTimes(1)

    // Verify JSON output
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const writtenData = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(writtenData)
    expect(parsed.deleted).toBe(true)
    expect(parsed.removedChunks).toBe(0)
    expect(parsed.existed).toBe(false)
    expect(parsed.filePath).toContain('raw-data')
  })

  // --------------------------------------------
  // Raw-data file cleanup (unlink .md and .meta.json)
  // --------------------------------------------
  it('should clean up raw-data files (.md and .meta.json) when path is a raw-data path', async () => {
    // Pre-create the on-disk raw-data .md so `isPathInRawDataDir`'s realpath
    // resolves and the cleanup branch runs. `unlink` is mocked so the file
    // stays on disk and is removed by the afterAll cleanup below.
    const { generateRawDataPath } = await import('../../utils/raw-data-utils.js')
    const mdPath = generateRawDataPath(cleanupDbPath, 'https://example.com/page', 'markdown')
    await mkdir(resolve(cleanupDbPath, 'raw-data'), { recursive: true })
    await writeFile(mdPath, 'fixture')

    const { error } = await captureStderr(() =>
      runDelete(['--source', 'https://example.com/page'], { dbPath: cleanupDbPath })
    )

    expect(error).toBeUndefined()

    // unlink should be called twice: once for .md, once for .meta.json
    expect(mocks.unlink).toHaveBeenCalledTimes(2)
    const unlinkCalls = mocks.unlink.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(unlinkCalls.some((p: string) => p.endsWith('.md'))).toBe(true)
    expect(unlinkCalls.some((p: string) => p.endsWith('.meta.json'))).toBe(true)
  })

  it('should not clean up files when path is not a raw-data path', async () => {
    const { error } = await captureStderr(() => runDelete(['/regular/file.md']))

    expect(error).toBeUndefined()

    // unlink should NOT be called for non-raw-data paths
    expect(mocks.unlink).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Non-existent target exits 0 (idempotent)
  // --------------------------------------------
  it('should exit with code 0 when target does not exist (idempotent)', async () => {
    // deleteChunks is a no-op for non-existent paths (no error)
    mocks.deleteChunks.mockResolvedValue(0)
    // unlink fails with ENOENT for non-existent files
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    mocks.unlink.mockRejectedValue(enoentError)

    const { error } = await captureStderr(() =>
      runDelete(['--source', 'https://nonexistent.example.com'])
    )

    expect(error).toBeUndefined()

    // Should still output success JSON
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const writtenData = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(writtenData)
    expect(parsed.deleted).toBe(true)
    expect(parsed.removedChunks).toBe(0)
    expect(parsed.existed).toBe(false)
  })

  it('attempts .meta.json cleanup even when the .md file is already missing', async () => {
    mocks.deleteChunks.mockResolvedValue(0)
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    mocks.unlink.mockRejectedValue(enoentError)

    await captureStderr(() => runDelete(['--source', 'https://example.com/missing']))

    expect(mocks.unlink).toHaveBeenCalledTimes(2)
    const paths = mocks.unlink.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(paths.some((p: string) => p.endsWith('.md'))).toBe(true)
    expect(paths.some((p: string) => p.endsWith('.meta.json'))).toBe(true)
  })

  // --------------------------------------------
  // Path validation for file path argument
  // --------------------------------------------
  it('should reject sensitive system paths for file-path argument', async () => {
    // Sensitive path prefixes (/etc, /usr, etc.) are Unix-specific.
    // On Windows, resolve('/etc/passwd') produces a drive-letter path
    // (e.g. D:\etc\passwd) which doesn't match the Unix prefix check.
    if (process.platform === 'win32') {
      return
    }
    const { output, error } = await captureStderr(() => runDelete(['/etc/passwd']))

    expect(error).toBeUndefined()
    expect(process.exitCode).toBe(1)
    expect(output.join('\n')).toContain('Refusing to use sensitive system path')
  })

  // --------------------------------------------
  // Unknown flags cause exit(1)
  // --------------------------------------------
  it('should error and exit with code 1 when unknown flags are passed', async () => {
    const { output, error } = await captureStderr(() => runDelete(['--unknown']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unknown option: --unknown')
  })

  // --------------------------------------------
  // Missing value for --source
  // --------------------------------------------
  it('should exit with code 1 when --source has no value', async () => {
    const { output, error } = await captureStderr(() => runDelete(['--source']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Missing value for --source')
  })

  it('should exit with code 1 when --source value starts with -', async () => {
    const { output, error } = await captureStderr(() => runDelete(['--source', '--other']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Missing value for --source')
  })

  // --------------------------------------------
  // Exit code 1 on operation failure
  // --------------------------------------------
  it('should exit with code 1 when deleteChunks fails', async () => {
    mocks.deleteChunks.mockRejectedValue(new Error('DB write failed'))

    const { output, error } = await captureStderr(() => runDelete(['/path/to/file.md']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('DB write failed')
  })

  it('should exit with code 1 when initialize fails', async () => {
    mocks.initialize.mockRejectedValue(new Error('Init failed'))

    const { output, error } = await captureStderr(() => runDelete(['/path/to/file.md']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Init failed')
  })

  // --------------------------------------------
  // GlobalOptions parameter
  // --------------------------------------------
  it('should pass global options to createVectorStore', async () => {
    const { error } = await captureStderr(() =>
      runDelete(['/path/to/file.md'], {
        dbPath: '/custom/db',
        cacheDir: '/custom/cache',
        modelName: 'custom-model',
      })
    )

    expect(error).toBeUndefined()

    const { createVectorStore } = await import('../../cli/common.js')
    expect(createVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: '/custom/db' })
    )
  })
})
