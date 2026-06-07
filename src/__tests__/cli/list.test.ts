// CLI List Tests
// Test Type: Unit Test
// Tests runList functionality with mocked dependencies

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

    // Shared CLI base-dirs resolver. Per-test impls can mirror precedence
    // (CLI roots replace env roots, env falls through to cwd) or simulate
    // resolver errors.
    resolveCliBaseDirs: vi.fn(),
  }
})

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const fsPromisesFactory = async (
  importOriginal: () => Promise<typeof import('node:fs/promises')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readdir: mocks.readdir,
  }
}

const cliCommonFactory = () => ({
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    listFiles: mocks.listFiles,
  })),
  resolveCliBaseDirsOrExit: vi
    .fn()
    .mockImplementation((cliRoots: string[]) => mocks.resolveCliBaseDirs(cliRoots)),
  // Pure helper used by the catch block; real implementation preserves the
  // `Error: <message>` stderr behavior the tests assert.
  toErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
})

const MOCKED_PATHS = ['node:fs/promises', '../../cli/common.js'] as const

import { resolve } from 'node:path'

let parseArgs: typeof import('../../cli/list.js').parseArgs
let runList: typeof import('../../cli/list.js').runList

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
  type: 'file' | 'directory' | 'symlink' = 'file'
): {
  name: string
  parentPath: string
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
} {
  return {
    name,
    parentPath,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  }
}

// ============================================
// Tests
// ============================================

describe('CLI list', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('node:fs/promises', fsPromisesFactory)
    vi.doMock('../../cli/common.js', cliCommonFactory)
    ;({ parseArgs, runList } = await import('../../cli/list.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Default resolver impl: CLI roots when provided, otherwise the
    // BASE_DIR env value if set (so existing precedence tests continue to
    // verify CLI > env), otherwise cwd. Per-test impls can override before
    // calling `runList`.
    mocks.resolveCliBaseDirs.mockImplementation((cliRoots: string[]) => {
      const first = cliRoots[0] ?? process.env['BASE_DIR'] ?? process.cwd()
      // Path-canonicalization: `list` scans/displays the NORMAL-path `rawBaseDirs`. These tests
      // do not involve symlinked prefixes, so the raw and realpath'd roots are
      // identical.
      return Promise.resolve({
        config: { baseDirs: [first], rawBaseDirs: [first] },
        warnings: [],
      })
    })
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
      { filePath: resolve(baseDir, 'doc.md'), chunkCount: 3, timestamp: '2025-01-01T00:00:00Z' },
    ])

    // Act
    const { stdout, error } = await captureOutput(() => runList([]))

    // Assert: no error
    expect(error).toBeUndefined()

    // Assert: JSON output to stdout (multi-root-aware shape, Finding #5)
    expect(stdout.length).toBeGreaterThan(0)
    const result = JSON.parse(stdout.join(''))
    expect(result).toHaveProperty('baseDir')
    expect(result).toHaveProperty('baseDirs')
    expect(Array.isArray(result.baseDirs)).toBe(true)
    expect(result.baseDir).toBe(result.baseDirs[0])
    expect(result).toHaveProperty('files')
    expect(result).toHaveProperty('sources')

    // doc.md is ingested, notes.txt is not, image.jpg is unsupported (not listed)
    expect(result.files).toHaveLength(2)
    const docEntry = result.files.find((f: Record<string, unknown>) =>
      String(f.filePath).endsWith('doc.md')
    )
    expect(docEntry).toMatchObject({ ingested: true, chunkCount: 3, baseDir: baseDir })
    const txtEntry = result.files.find((f: Record<string, unknown>) =>
      String(f.filePath).endsWith('notes.txt')
    )
    expect(txtEntry).toMatchObject({ ingested: false, baseDir: baseDir })
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
    // Arrange — scanRoot now uses bounded BFS (Finding #10), so the
    // exclude check must see a real subdirectory under the root. The
    // `lancedb` directory and its `chunks.md` file are returned by
    // `readdir(lancedb)`, where the join() composes a path under
    // `resolvedDbPath` that the excludePaths prefix check rejects.
    const baseDir = process.cwd()
    const resolvedDbPath = resolve(baseDir, 'lancedb')

    mocks.readdir.mockImplementation(async (path: string) => {
      if (path === baseDir) {
        return [mockDirent('doc.md', baseDir), mockDirent('lancedb', baseDir, 'directory')]
      }
      if (path === resolvedDbPath) {
        return [mockDirent('chunks.md', resolvedDbPath)]
      }
      return []
    })
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
  // Multi-root scan (P2-T2)
  // --------------------------------------------
  it('should walk every effective root and aggregate files across roots', async () => {
    // Arrange: two disjoint effective roots, each contributing one file.
    // Reset `initialize` because the preceding error-handling test leaves a
    // rejection installed and `vi.clearAllMocks()` does not reset
    // `mockRejectedValue` (only call history). Same for the other multi-root
    // tests below.
    mocks.initialize.mockResolvedValue(undefined)
    const rootA = resolve('/tmp/list/rootA')
    const rootB = resolve('/tmp/list/rootB')
    mocks.resolveCliBaseDirs.mockResolvedValue({
      config: { baseDirs: [rootA, rootB], rawBaseDirs: [rootA, rootB] },
      warnings: [],
    })
    // readdir is called once per root; mock matches the requested path so
    // the per-root file lists do not bleed across roots.
    mocks.readdir.mockImplementation(async (path: string) => {
      if (path === rootA) return [mockDirent('a.md', rootA)]
      if (path === rootB) return [mockDirent('b.md', rootB)]
      return []
    })
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() =>
      runList(['--base-dir', rootA, '--base-dir', rootB])
    )

    // Assert
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    expect(result.baseDirs).toEqual([rootA, rootB])
    const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
    expect(filePaths).toContain(resolve(rootA, 'a.md'))
    expect(filePaths).toContain(resolve(rootB, 'b.md'))
    expect(filePaths).toHaveLength(2)
    // Each file is annotated with its producing root (Finding #5).
    const aEntry = result.files.find((f: Record<string, unknown>) =>
      String(f.filePath).endsWith('a.md')
    )
    const bEntry = result.files.find((f: Record<string, unknown>) =>
      String(f.filePath).endsWith('b.md')
    )
    expect(aEntry.baseDir).toBe(rootA)
    expect(bEntry.baseDir).toBe(rootB)
  })

  it('should dedup file entries when roots surface the same absolute path', async () => {
    // Arrange: two roots, each yielding the same file path (overlap that
    // survived nested-root pruning — e.g. symlink-equivalent realpaths).
    // The list output must contain the file exactly once.
    mocks.initialize.mockResolvedValue(undefined)
    const rootA = resolve('/tmp/list/share')
    const rootB = resolve('/tmp/list/share') // duplicate after normalization
    const sharedPath = resolve(rootA, 'shared.md')
    mocks.resolveCliBaseDirs.mockResolvedValue({
      config: { baseDirs: [rootA, rootB], rawBaseDirs: [rootA, rootB] },
      warnings: [],
    })
    mocks.readdir.mockImplementation(async () => [mockDirent('shared.md', rootA)])
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() => runList(['--base-dir', rootA]))

    // Assert: file appears once
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
    expect(filePaths.filter((p: string) => p === sharedPath)).toHaveLength(1)
  })

  it('should preserve dbPath and cacheDir exclusion across all roots', async () => {
    // Arrange: two roots, each containing a file under the global
    // dbPath/cacheDir path. Both must be excluded.
    mocks.initialize.mockResolvedValue(undefined)
    const rootA = resolve('/tmp/list/dbA')
    const rootB = resolve('/tmp/list/dbB')
    const dbPath = resolve('/tmp/list/dbA/lancedb')
    mocks.resolveCliBaseDirs.mockResolvedValue({
      config: { baseDirs: [rootA, rootB], rawBaseDirs: [rootA, rootB] },
      warnings: [],
    })
    // Post-Finding-#10: scanRoot now uses bounded BFS. The `lancedb`
    // directory under rootA is returned as a child entry and walked into
    // separately so the excludePaths prefix check actually sees a path
    // under `dbPath`.
    mocks.readdir.mockImplementation(async (path: string) => {
      if (path === rootA) {
        return [mockDirent('keep.md', rootA), mockDirent('lancedb', rootA, 'directory')]
      }
      if (path === dbPath) {
        return [mockDirent('chunks.md', dbPath)]
      }
      if (path === rootB) {
        return [mockDirent('also-keep.md', rootB)]
      }
      return []
    })
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stdout, error } = await captureOutput(() =>
      runList(['--base-dir', rootA, '--base-dir', rootB], {
        dbPath,
        cacheDir: '/tmp/list/cache',
        modelName: 'm',
      })
    )

    // Assert: only the two non-excluded files were listed
    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
    expect(filePaths).toContain(resolve(rootA, 'keep.md'))
    expect(filePaths).toContain(resolve(rootB, 'also-keep.md'))
    expect(filePaths.some((p: string) => p.includes('chunks.md'))).toBe(false)
  })

  it('should keep listing other roots when one root readdir errors (Finding #10)', async () => {
    // Per-root error tolerance: an EACCES under rootA must not hide files
    // under rootB. The CLI prints a per-root warning to stderr and continues.
    mocks.initialize.mockResolvedValue(undefined)
    const rootA = resolve('/tmp/list/inaccessible')
    const rootB = resolve('/tmp/list/accessible')
    mocks.resolveCliBaseDirs.mockResolvedValue({
      config: { baseDirs: [rootA, rootB], rawBaseDirs: [rootA, rootB] },
      warnings: [],
    })
    mocks.readdir.mockImplementation(async (path: string) => {
      if (path === rootA) {
        const err = new Error('EACCES: permission denied, scandir') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      if (path === rootB) return [mockDirent('survives.md', rootB)]
      return []
    })
    mocks.listFiles.mockResolvedValue([])

    const { stdout, stderr, error } = await captureOutput(() =>
      runList(['--base-dir', rootA, '--base-dir', rootB])
    )

    expect(error).toBeUndefined()
    // rootB's file is still listed.
    const result = JSON.parse(stdout.join(''))
    const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
    expect(filePaths).toContain(resolve(rootB, 'survives.md'))
    // Per-root warning was surfaced on stderr.
    const joined = stderr.join('\n')
    expect(joined).toContain(`Warning [${rootA}]: cannot read directory`)
    expect(joined).toContain('EACCES')
    // Do not leak the raw OS error message into the warning content.
    expect(joined).not.toContain('permission denied, scandir')
  })

  it('should stop scanning a root at MAX_DEPTH=10 and emit a depth warning (Finding #10)', async () => {
    // Build a chain of 11 nested directories. The BFS must skip depth 10
    // and produce a warning, but the file at depth 9 must still appear.
    mocks.initialize.mockResolvedValue(undefined)
    const root = resolve('/tmp/list/deep')
    mocks.resolveCliBaseDirs.mockResolvedValue({
      config: { baseDirs: [root], rawBaseDirs: [root] },
      warnings: [],
    })

    const dirMap: Record<string, ReturnType<typeof mockDirent>[]> = {
      [root]: [mockDirent('d1', root, 'directory')],
    }
    let current = root
    for (let i = 1; i <= 10; i++) {
      const next = resolve(`${current}/d${i}`)
      // Depth 9 contains a markdown file (within MAX_DEPTH); depths above
      // continue chaining so depth 10 entry remains a directory that must
      // be SKIPPED with a depth warning.
      if (i === 9) {
        dirMap[next] = [mockDirent('boundary.md', next), mockDirent(`d${i + 1}`, next, 'directory')]
      } else if (i < 10) {
        dirMap[next] = [mockDirent(`d${i + 1}`, next, 'directory')]
      }
      current = next
    }
    mocks.readdir.mockImplementation(async (path: string) => dirMap[path] ?? [])
    mocks.listFiles.mockResolvedValue([])

    const { stdout, stderr, error } = await captureOutput(() => runList(['--base-dir', root]))

    expect(error).toBeUndefined()
    const result = JSON.parse(stdout.join(''))
    const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
    // The depth-9 file is present (within MAX_DEPTH=10).
    expect(filePaths.some((p: string) => p.endsWith('boundary.md'))).toBe(true)
    // The depth warning reached stderr.
    const joined = stderr.join('\n')
    expect(joined).toContain('maximum depth')
  })

  it('should surface nested-root pruning warnings from the resolver to stderr', async () => {
    // Arrange: resolver returns a single effective root plus a pruning
    // warning. The CLI prints warnings on stderr so the JSON stdout
    // contract stays clean.
    mocks.initialize.mockResolvedValue(undefined)
    const root = resolve('/tmp/list/parent')
    mocks.resolveCliBaseDirs.mockResolvedValue({
      config: { baseDirs: [root], rawBaseDirs: [root] },
      warnings: [
        {
          kind: 'nested-root-pruned',
          message: `Nested base directory pruned: ${root}/child/ is inside ${root}/. Keeping ${root}/ only.`,
          parent: `${root}/`,
          pruned: `${root}/child/`,
        },
      ],
    })
    mocks.readdir.mockResolvedValue([])
    mocks.listFiles.mockResolvedValue([])

    // Act
    const { stderr, error } = await captureOutput(() => runList([]))

    // Assert: warning appears on stderr
    expect(error).toBeUndefined()
    const joined = stderr.join('\n')
    expect(joined).toContain('Nested base directory pruned')
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
      expect(result).toEqual({ options: { baseDirs: ['/my/docs'] }, help: false })
    })

    it('should accumulate repeated --base-dir into baseDirs array in CLI order', () => {
      const result = parseArgs(['--base-dir', '/a', '--base-dir', '/b'])
      expect(result.options.baseDirs).toEqual(['/a', '/b'])
    })

    it('should leave baseDirs undefined when --base-dir is not provided', () => {
      const result = parseArgs([])
      expect(result.options.baseDirs).toBeUndefined()
    })

    it('should keep single --base-dir backward-compatible (array of one)', () => {
      const result = parseArgs(['--base-dir', '/only'])
      expect(result.options.baseDirs).toEqual(['/only'])
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

  // --------------------------------------------
  // P2-T3: CLI multi-root precedence / fallback / config-error matrix
  //
  // These tests assert the boundary contract between `runList` and the shared
  // `resolveCliBaseDirsOrExit` helper. They drive each scenario from the
  // resolver mock (env vars, warnings, error path) rather than touching the
  // real env / filesystem so the cases remain deterministic and isolated.
  // --------------------------------------------
  describe('multi-root precedence (P2-T3)', () => {
    it('passes CLI roots verbatim to the resolver and suppresses any env precedence warning', async () => {
      // Arrange: both env vars set, but CLI provides roots. The resolver
      // contract is "CLI replaces env, no precedence warning even if env vars
      // are also set". The CLI must (a) hand the CLI roots to the resolver and
      // (b) NOT print a `base-dirs-overrides-base-dir` message — the resolver
      // is the single source of truth for that warning.
      mocks.initialize.mockResolvedValue(undefined)
      process.env['BASE_DIR'] = '/env/single'
      process.env['BASE_DIRS'] = '["/env/multi/a","/env/multi/b"]'
      const cliRootA = resolve('/cli/precedence/a')
      const cliRootB = resolve('/cli/precedence/b')
      // Resolver behaves like the real one: CLI overrides env, no warnings.
      mocks.resolveCliBaseDirs.mockResolvedValue({
        config: { baseDirs: [cliRootA, cliRootB], rawBaseDirs: [cliRootA, cliRootB] },
        warnings: [],
      })
      mocks.readdir.mockResolvedValue([])
      mocks.listFiles.mockResolvedValue([])

      try {
        // Act
        const { stderr, error } = await captureOutput(() =>
          runList(['--base-dir', cliRootA, '--base-dir', cliRootB])
        )

        // Assert: resolver received the CLI roots verbatim and in order.
        expect(error).toBeUndefined()
        expect(mocks.resolveCliBaseDirs).toHaveBeenCalledWith([cliRootA, cliRootB])

        // Assert: no precedence warning surfaced to stderr (CLI overrides env).
        const joined = stderr.join('\n')
        expect(joined).not.toContain('BASE_DIRS is set')
        expect(joined).not.toContain('BASE_DIR is ignored')
      } finally {
        delete process.env['BASE_DIR']
        delete process.env['BASE_DIRS']
      }
    })

    it('uses BASE_DIRS fallback (multi-root) when no --base-dir is provided', async () => {
      // Arrange: no CLI roots; resolver yields the BASE_DIRS-driven multi-root
      // result. The CLI call site MUST forward an empty `cliRoots` array
      // (signaling "no CLI override") so the resolver applies env precedence.
      mocks.initialize.mockResolvedValue(undefined)
      const envRootA = resolve('/env/multi/a')
      const envRootB = resolve('/env/multi/b')
      mocks.resolveCliBaseDirs.mockResolvedValue({
        config: { baseDirs: [envRootA, envRootB], rawBaseDirs: [envRootA, envRootB] },
        warnings: [],
      })
      mocks.readdir.mockImplementation(async (path: string) => {
        if (path === envRootA) return [mockDirent('a.md', envRootA)]
        if (path === envRootB) return [mockDirent('b.md', envRootB)]
        return []
      })
      mocks.listFiles.mockResolvedValue([])

      // Act
      const { stdout, stderr, error } = await captureOutput(() => runList([]))

      // Assert: resolver invoked with empty CLI roots (env path triggers).
      expect(error).toBeUndefined()
      expect(mocks.resolveCliBaseDirs).toHaveBeenCalledWith([])

      // Assert: both roots were scanned and aggregated in the output.
      const result = JSON.parse(stdout.join(''))
      const filePaths = result.files.map((f: Record<string, unknown>) => f.filePath)
      expect(filePaths).toContain(resolve(envRootA, 'a.md'))
      expect(filePaths).toContain(resolve(envRootB, 'b.md'))

      // Assert: no warnings surfaced because the resolver returned none.
      expect(stderr.join('\n')).not.toMatch(/BASE_DIRS|BASE_DIR/)
    })

    it('surfaces BASE_DIRS > BASE_DIR precedence warning on stderr (no CLI roots)', async () => {
      // Arrange: resolver attaches `base-dirs-overrides-base-dir` because both
      // BASE_DIRS and BASE_DIR are set with no CLI override. The CLI must
      // print the warning message to stderr.
      mocks.initialize.mockResolvedValue(undefined)
      const root = resolve('/env/multi/only')
      mocks.resolveCliBaseDirs.mockResolvedValue({
        config: { baseDirs: [root], rawBaseDirs: [root] },
        warnings: [
          {
            kind: 'base-dirs-overrides-base-dir',
            message:
              'BASE_DIRS is set; BASE_DIR is ignored. Unset BASE_DIR or remove BASE_DIRS to silence this warning.',
          },
        ],
      })
      mocks.readdir.mockResolvedValue([])
      mocks.listFiles.mockResolvedValue([])

      // Act
      const { stderr, error } = await captureOutput(() => runList([]))

      // Assert: precedence message reached stderr.
      expect(error).toBeUndefined()
      const joined = stderr.join('\n')
      expect(joined).toContain('BASE_DIRS is set')
      expect(joined).toContain('BASE_DIR is ignored')
    })

    it('exits non-zero with a stderr error when the resolver rejects invalid BASE_DIRS', async () => {
      // Arrange: `resolveCliBaseDirsOrExit` itself calls process.exit(1) after
      // printing the config error to stderr (see common.ts). We simulate
      // that path by making the mock throw `process.exit(1)` and writing the
      // error message to stderr first, mirroring production behavior.
      mocks.initialize.mockResolvedValue(undefined)
      mocks.resolveCliBaseDirs.mockImplementation(() => {
        console.error(
          'BASE_DIRS must be a JSON array of non-empty path strings. Failed to parse as JSON: not-json'
        )
        throw new Error('process.exit(1)')
      })

      // Act
      const { stderr, error } = await captureOutput(() => runList([]))

      // Assert: CLI propagates exit(1) and the config error is visible.
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('process.exit(1)')
      const joined = stderr.join('\n')
      expect(joined).toContain('BASE_DIRS')
      expect(joined).toContain('JSON')
    })

    it('uses cwd as the only effective root when neither CLI roots nor env vars are set', async () => {
      // Arrange: resolver returns cwd as the only effective root (matches the
      // resolver's final fallback rule). No warnings expected.
      mocks.initialize.mockResolvedValue(undefined)
      const cwd = process.cwd()
      mocks.resolveCliBaseDirs.mockResolvedValue({
        config: { baseDirs: [cwd], rawBaseDirs: [cwd] },
        warnings: [],
      })
      mocks.readdir.mockResolvedValue([])
      mocks.listFiles.mockResolvedValue([])

      // Act
      const { stdout, stderr, error } = await captureOutput(() => runList([]))

      // Assert: baseDir in JSON output is cwd; resolver called with no CLI roots.
      expect(error).toBeUndefined()
      expect(mocks.resolveCliBaseDirs).toHaveBeenCalledWith([])
      const result = JSON.parse(stdout.join(''))
      expect(result.baseDir).toBe(cwd)
      expect(stderr.join('\n')).not.toMatch(/BASE_DIRS|BASE_DIR/)
    })
  })
})
