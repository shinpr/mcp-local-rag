// CLI Status Tests
// Test Type: Unit Test
// Tests runStatus functionality with mocked dependencies

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // VectorStore instance methods
    initialize: vi.fn(),
    getStatus: vi.fn(),
  }
})

// Mock cli/common.js (createVectorStore factory)
vi.mock('../../cli/common.js', () => ({
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    getStatus: mocks.getStatus,
  })),
}))

// Import after mocks are set up
import { runStatus } from '../../cli/status.js'

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

describe('CLI status', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

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
    const { output, error } = await captureStderr(() => runStatus(['--help']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('status')
    expect(joined).toContain('-h, --help')
  })

  it('should show help text and exit with code 0 when -h is passed', async () => {
    const { output, error } = await captureStderr(() => runStatus(['-h']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage: mcp-local-rag')
    expect(joined).toContain('status')
  })

  // --------------------------------------------
  // Outputs JSON result to stdout
  // --------------------------------------------
  it('should initialize VectorStore, call getStatus, and output JSON to stdout', async () => {
    const statusResult = {
      documentCount: 10,
      chunkCount: 100,
      memoryUsage: 2048,
      ftsIndexEnabled: true,
      searchMode: 'hybrid',
    }
    mocks.initialize.mockResolvedValue(undefined)
    mocks.getStatus.mockResolvedValue(statusResult)

    const { error } = await captureStderr(() => runStatus([]))

    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()
    expect(mocks.initialize).toHaveBeenCalledTimes(1)
    expect(mocks.getStatus).toHaveBeenCalledTimes(1)

    const writtenData = stdoutSpy.mock.calls[0]![0] as string
    expect(JSON.parse(writtenData)).toEqual(statusResult)
  })

  // --------------------------------------------
  // Unknown flags cause exit(1)
  // --------------------------------------------
  it('should error and exit with code 1 when unknown flags are passed', async () => {
    const { output, error } = await captureStderr(() => runStatus(['--unknown']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unknown option: --unknown')
  })

  it('should error and exit with code 1 when positional args are passed', async () => {
    const { output, error } = await captureStderr(() => runStatus(['some-arg']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unexpected argument')
  })

  // --------------------------------------------
  // Exit code 1 on error
  // --------------------------------------------
  it('should exit with code 1 when getStatus fails', async () => {
    mocks.initialize.mockResolvedValue(undefined)
    mocks.getStatus.mockRejectedValue(new Error('DB connection failed'))

    const { output, error } = await captureStderr(() => runStatus([]))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('DB connection failed')
  })

  it('should exit with code 1 when initialize fails', async () => {
    mocks.initialize.mockRejectedValue(new Error('Init failed'))

    const { output, error } = await captureStderr(() => runStatus([]))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Init failed')
  })

  // --------------------------------------------
  // GlobalOptions parameter
  // --------------------------------------------
  it('should pass global options to createVectorStore', async () => {
    mocks.initialize.mockResolvedValue(undefined)
    mocks.getStatus.mockResolvedValue({ documentCount: 0, chunkCount: 0, memoryUsage: 0 })

    const { error } = await captureStderr(() =>
      runStatus([], {
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
