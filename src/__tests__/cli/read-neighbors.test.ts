// CLI read-neighbors Tests
// Test Type: Unit Test
// Tests runReadNeighbors functionality with mocked dependencies.
//
// AC parity: runReadNeighbors does not instantiate an embedder; this test file
// does not import createEmbedder. This provides a static-analysis-level guarantee
// that the read-neighbors CLI path never constructs an embedder.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // VectorStore instance methods used by runReadNeighbors
    initialize: vi.fn(),
    getChunksByRange: vi.fn(),
  }
})

// Mock cli/common.js (createVectorStore factory).
// Intentionally omit createEmbedder — runReadNeighbors must never call it.
vi.mock('../../cli/common.js', () => ({
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    getChunksByRange: mocks.getChunksByRange,
  })),
}))

// Import after mocks are set up
import { runReadNeighbors } from '../../cli/read-neighbors.js'

// ============================================
// Helpers
// ============================================

/**
 * Capture stderr output during a function call.
 * Uses vi.spyOn on console.error since the implementation writes diagnostics
 * (help text and errors) via console.error.
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

describe('CLI read-neighbors', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock process.exit to throw so we can catch it in test code
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })
    // Spy on process.stdout.write to capture JSON output
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // Default: VectorStore methods succeed
    mocks.initialize.mockResolvedValue(undefined)
    mocks.getChunksByRange.mockResolvedValue([])
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stdoutSpy.mockRestore()
    process.exitCode = undefined
  })

  // --------------------------------------------
  // Test 1 — --help prints HELP_TEXT and exit 0
  // --------------------------------------------
  it('should print HELP_TEXT and exit 0 when --help flag provided', async () => {
    const { output, error } = await captureStderr(() => runReadNeighbors(['--help']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    const joined = output.join('\n')
    expect(joined).toContain('Usage:')
    expect(joined).toContain('read-neighbors')
    expect(joined).toContain('--chunk-index')
    expect(joined).toContain('Either --file-path or --source')

    // No DB access when --help is handled
    expect(mocks.initialize).not.toHaveBeenCalled()
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 2 — XOR: both --file-path and --source provided
  // --------------------------------------------
  it('should exit 1 when both --file-path and --source are provided', async () => {
    const { output, error } = await captureStderr(() =>
      runReadNeighbors([
        '--file-path',
        '/abs/path.md',
        '--source',
        'http://ex.com',
        '--chunk-index',
        '5',
      ])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    expect(output.join('\n')).toContain('Cannot specify both --file-path and --source')
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 3 — XOR: neither --file-path nor --source provided
  // --------------------------------------------
  it('should exit 1 when neither --file-path nor --source is provided', async () => {
    const { output, error } = await captureStderr(() => runReadNeighbors(['--chunk-index', '5']))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    expect(output.join('\n')).toContain('Either --file-path or --source is required')
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 4 — Missing --chunk-index
  // --------------------------------------------
  it('should exit 1 when --chunk-index is missing', async () => {
    const { output, error } = await captureStderr(() =>
      runReadNeighbors(['--file-path', '/abs/path.md'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    expect(output.join('\n')).toContain('--chunk-index')
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 5 — Non-integer --chunk-index ("abc")
  // --------------------------------------------
  it('should exit 1 when --chunk-index is non-integer ("abc")', async () => {
    const { output, error } = await captureStderr(() =>
      runReadNeighbors(['--file-path', '/abs/path.md', '--chunk-index', 'abc'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    expect(output.join('\n')).toContain('--chunk-index')
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 6 — Negative --chunk-index ("-1")
  // --------------------------------------------
  it('should exit 1 when --chunk-index is negative ("-1")', async () => {
    const { output, error } = await captureStderr(() =>
      runReadNeighbors(['--file-path', '/abs/path.md', '--chunk-index', '-1'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    expect(output.join('\n')).toContain('--chunk-index')
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 7 — Non-integer --before ("2.5")
  // --------------------------------------------
  it('should exit 1 when --before is non-integer ("2.5")', async () => {
    const { output, error } = await captureStderr(() =>
      runReadNeighbors(['--file-path', '/abs/path.md', '--chunk-index', '5', '--before', '2.5'])
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
    expect(output.join('\n')).toContain('--before')
    expect(mocks.getChunksByRange).not.toHaveBeenCalled()
  })

  // --------------------------------------------
  // Test 8 — Defaults applied (AC-008, AC-012)
  // --------------------------------------------
  it('should use default before=2/after=2 window when neither flag is provided', async () => {
    mocks.getChunksByRange.mockResolvedValueOnce([
      { filePath: '/abs/path.md', chunkIndex: 5, text: 'x', fileTitle: null },
    ])

    const { error } = await captureStderr(() =>
      runReadNeighbors(['--file-path', '/abs/path.md', '--chunk-index', '5'])
    )

    expect(error).toBeUndefined()
    expect(mocks.initialize).toHaveBeenCalledTimes(1)
    expect(mocks.getChunksByRange).toHaveBeenCalledTimes(1)
    // handler-side clamp: minIdx = max(0, 5 - 2) = 3; maxIdx = 5 + 2 = 7
    expect(mocks.getChunksByRange).toHaveBeenCalledWith('/abs/path.md', 3, 7)
  })

  // --------------------------------------------
  // Test 9 — JSON output shape (AC-011)
  // --------------------------------------------
  it('should write JSON output to stdout matching JSON.stringify(items, null, 2) + "\\n"', async () => {
    const rows = [
      { filePath: '/abs/path.md', chunkIndex: 4, text: 'before', fileTitle: 'Doc' },
      { filePath: '/abs/path.md', chunkIndex: 5, text: 'target', fileTitle: 'Doc' },
      { filePath: '/abs/path.md', chunkIndex: 6, text: 'after', fileTitle: 'Doc' },
    ]
    mocks.getChunksByRange.mockResolvedValueOnce(rows)

    const { error } = await captureStderr(() =>
      runReadNeighbors(['--file-path', '/abs/path.md', '--chunk-index', '5'])
    )

    expect(error).toBeUndefined()
    expect(stdoutSpy).toHaveBeenCalledTimes(1)

    const expectedItems = [
      {
        filePath: '/abs/path.md',
        chunkIndex: 4,
        text: 'before',
        isTarget: false,
        fileTitle: 'Doc',
      },
      { filePath: '/abs/path.md', chunkIndex: 5, text: 'target', isTarget: true, fileTitle: 'Doc' },
      { filePath: '/abs/path.md', chunkIndex: 6, text: 'after', isTarget: false, fileTitle: 'Doc' },
    ]
    const written = stdoutSpy.mock.calls[0]![0] as string
    expect(written).toBe(`${JSON.stringify(expectedItems, null, 2)}\n`)
  })

  // --------------------------------------------
  // Test 10 — --source alternative (AC-003, AC-012, AC-020 CLI path)
  // --------------------------------------------
  it('should generate raw-data path from --source and attach source to response items', async () => {
    const SOURCE = 'https://example.com/test'

    // The primitive is called with a generated raw-data path. Capture it via mock
    // and return a row whose filePath is the raw-data path — so runReadNeighbors
    // will extract the source from that path and attach it to each item.
    mocks.getChunksByRange.mockImplementationOnce(
      async (targetPath: string, _minIdx: number, _maxIdx: number) => [
        { filePath: targetPath, chunkIndex: 0, text: 'hello', fileTitle: null },
      ]
    )

    const { error } = await captureStderr(() =>
      runReadNeighbors(['--source', SOURCE, '--chunk-index', '0'])
    )

    expect(error).toBeUndefined()
    expect(mocks.getChunksByRange).toHaveBeenCalledTimes(1)

    // The first argument is the generated raw-data path.
    const [calledPath] = mocks.getChunksByRange.mock.calls[0] as [string, number, number]
    expect(calledPath).toContain('/raw-data/')
    expect(calledPath).toMatch(/\.md$/)
    // Not the raw source string itself.
    expect(calledPath).not.toBe(SOURCE)

    // Response items should include the original source field extracted from the
    // raw-data path.
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
    const written = stdoutSpy.mock.calls[0]![0] as string
    const parsed = JSON.parse(written) as Array<{
      filePath: string
      chunkIndex: number
      text: string
      isTarget: boolean
      fileTitle: string | null
      source?: string
    }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.source).toBe(SOURCE)
    expect(parsed[0]!.isTarget).toBe(true)
  })
})
