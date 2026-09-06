// Proves the `scope` predicate is pushed INTO the BFS walk rather than applied
// as a post-scan filter, for BOTH walkers — `scanBaseDir` and
// `bfsCollectSupportedFiles` are separate code paths.
//
// Mocking (shared-registry safe: doMock/doUnmock plus dynamic import, per
// project-context):
//   - `readdir` is wrapped to RECORD every queried directory into `visited[]`
//     and optionally throw EACCES for a deny-path, otherwise delegating to the
//     real one. The absence of a recorded directory is what proves pushdown.
//   - `join` is switched to backslash-join only for the synthetic Windows case,
//     since a real `\`-path tree cannot exist on a POSIX host.
//
// No `realpathForMatch` assertions: the walkers never call it. The chmod-based
// real-FS unreadable sentinel is auxiliary only, since chmod is unreliable on
// Windows CI — the EACCES mock discharges the proof.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Mock } from 'vitest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// Mock setup (vi.hoisted for isolate:false; installed via doMock in beforeAll)
// ============================================================================

interface ScanMocks {
  readdir: Mock
  join: Mock
  /** Captured real implementations, filled by the factories below. */
  actualReaddir: typeof import('node:fs/promises').readdir | undefined
  actualJoin: typeof import('node:path').join | undefined
}

const mocks = vi.hoisted<ScanMocks>(() => ({
  readdir: vi.fn(),
  join: vi.fn(),
  actualReaddir: undefined,
  actualJoin: undefined,
}))

const fsPromisesFactory = async (
  importOriginal: () => Promise<typeof import('node:fs/promises')>
) => {
  const actual = await importOriginal()
  mocks.actualReaddir = actual.readdir
  return { ...actual, readdir: mocks.readdir }
}

const pathFactory = async (importOriginal: () => Promise<typeof import('node:path')>) => {
  const actual = await importOriginal()
  mocks.actualJoin = actual.join
  return { ...actual, join: mocks.join }
}

const MOCKED_PATHS = ['node:fs/promises', 'node:path'] as const

// Every directory the walker asked `readdir` for, in call order. Reset per test.
const visited: string[] = []

let scanBaseDir: typeof import('../../server/list-scanner.js').scanBaseDir
let bfsCollectSupportedFiles: typeof import('../scan.js').bfsCollectSupportedFiles

// ============================================================================
// Helpers
// ============================================================================

function eaccesError(path: string): NodeJS.ErrnoException {
  const err = Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), {
    code: 'EACCES',
  })
  return err
}

/**
 * readdir impl backed by the REAL filesystem: records the queried dir, throws
 * EACCES for any path in `deny`, otherwise delegates to the real readdir.
 */
function realDelegate(deny: Set<string> = new Set()) {
  return async (dirPath: string) => {
    visited.push(dirPath)
    if (deny.has(dirPath)) {
      throw eaccesError(dirPath)
    }
    const actualReaddir = mocks.actualReaddir
    if (actualReaddir === undefined) {
      throw new Error('readdir factory did not capture the real implementation')
    }
    return actualReaddir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  }
}

type EntryType = 'file' | 'directory' | 'symlink'

function mockDirent(name: string, type: EntryType) {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  }
}

/**
 * readdir impl backed by an in-memory tree, leaving `join` as the real (host)
 * join. Used for entry shapes a real fixture cannot portably produce — a
 * symlink `Dirent` (creating real symlinks needs elevation on Windows CI).
 */
function useSyntheticTree(dirMap: Map<string, Array<[string, EntryType]>>) {
  mocks.readdir.mockImplementation(async (dirPath: string) => {
    visited.push(dirPath)
    const entries = dirMap.get(dirPath)
    if (!entries) {
      const err = Object.assign(new Error(`ENOENT: ${dirPath}`), { code: 'ENOENT' })
      throw err
    }
    return entries.map(([name, type]) => mockDirent(name, type))
  })
}

/**
 * readdir impl backed by an in-memory tree (used for the synthetic backslash
 * separator case, which cannot exist on a POSIX filesystem). Also flips `join`
 * to backslash-join so the walker composes Windows-style child paths.
 */
function useSyntheticBackslashTree(dirMap: Map<string, Array<[string, EntryType]>>) {
  mocks.join.mockImplementation((...parts: string[]) => parts.join('\\'))
  mocks.readdir.mockImplementation(async (dirPath: string) => {
    visited.push(dirPath)
    const entries = dirMap.get(dirPath)
    if (!entries) {
      const err = Object.assign(new Error(`ENOENT: ${dirPath}`), { code: 'ENOENT' })
      throw err
    }
    return entries.map(([name, type]) => mockDirent(name, type))
  })
}

// Two walkers behind a uniform adapter so every case runs against both.
/**
 * What one walk observed, normalized across walkers so the shared cases can
 * assert on it without knowing which walker produced it.
 */
interface WalkerObservation {
  files: string[]
  /** True when the walk reported the given directory as unreadable. */
  warnedFor: (dir: string) => boolean
  /** How many unreadable directories the walk reported. */
  warnCount: number
}

interface WalkerAdapter {
  name: string
  run: (root: string, scope?: string[]) => Promise<WalkerObservation>
}

let WALKERS: WalkerAdapter[]

// ============================================================================
// Real-FS fixture tree (built once):
//   base/
//     root.md                  (out of scope /a/b)
//     bar.md                   (exact-file scope target)
//     a/
//       in-a.md                (out of scope /a/b)
//       b/
//         in-b.md              (in scope /a/b)
//         c/ deep.md           (in scope; reached via ancestor descent)
//       bc/ boundary.md        (name-prefix sibling: /a/bc must NOT match /a/b)
//     x/ y/ out.md             (non-intersecting branch)
// ============================================================================

let tmpRoot: string
let base: string
let dirA: string
let dirAB: string
let dirABC: string
let dirABc: string
let dirX: string
let dirXY: string
let outsideBase: string

let fRoot: string
let fBar: string
let fInA: string
let fInB: string
let fDeep: string
let fBoundary: string
let fOut: string
let allFiles: string[]
let allDirs: string[]

beforeAll(async () => {
  vi.resetModules()
  for (const p of MOCKED_PATHS) {
    vi.doUnmock(p)
  }
  vi.doMock('node:fs/promises', fsPromisesFactory)
  vi.doMock('node:path', pathFactory)
  ;({ scanBaseDir } = await import('../../server/list-scanner.js'))
  ;({ bfsCollectSupportedFiles } = await import('../scan.js'))

  WALKERS = [
    {
      name: 'scanBaseDir',
      run: async (root, scope) => {
        const result = await scanBaseDir(root, [], scope)
        return {
          files: result.files,
          warnedFor: (dir) => result.warnings.some((w) => w.includes(basename(dir))),
          warnCount: result.warnings.filter((w) => w.includes('cannot read directory')).length,
        }
      },
    },
    {
      name: 'bfsCollectSupportedFiles',
      run: async (root, scope) => {
        const result = await bfsCollectSupportedFiles(root, [], { scope })
        return {
          files: result.files,
          warnedFor: (dir) => result.unreadableDirs.some((u) => u.dirPath === dir),
          warnCount: result.unreadableDirs.length,
        }
      },
    },
  ]

  // Build the real fixture tree with the REAL path/fs (test-file top-level
  // imports are resolved before doMock, so `join`/`mkdirSync` here are genuine).
  tmpRoot = mkdtempSync(join(tmpdir(), 'scope-scan-'))
  base = join(tmpRoot, 'base')
  outsideBase = join(tmpRoot, 'outside')

  dirA = join(base, 'a')
  dirAB = join(base, 'a', 'b')
  dirABC = join(base, 'a', 'b', 'c')
  dirABc = join(base, 'a', 'bc')
  dirX = join(base, 'x')
  dirXY = join(base, 'x', 'y')

  mkdirSync(dirABC, { recursive: true })
  mkdirSync(dirABc, { recursive: true })
  mkdirSync(dirXY, { recursive: true })
  mkdirSync(outsideBase, { recursive: true })

  fRoot = join(base, 'root.md')
  fBar = join(base, 'bar.md')
  fInA = join(dirA, 'in-a.md')
  fInB = join(dirAB, 'in-b.md')
  fDeep = join(dirABC, 'deep.md')
  fBoundary = join(dirABc, 'boundary.md')
  fOut = join(dirXY, 'out.md')

  for (const f of [fRoot, fBar, fInA, fInB, fDeep, fBoundary, fOut]) {
    writeFileSync(f, 'content')
  }

  allFiles = [fRoot, fBar, fInA, fInB, fDeep, fBoundary, fOut]
  allDirs = [base, dirA, dirAB, dirABC, dirABc, dirX, dirXY]
})

afterAll(() => {
  for (const p of MOCKED_PATHS) {
    vi.doUnmock(p)
  }
  vi.resetModules()
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  visited.length = 0
  mocks.readdir.mockImplementation(realDelegate())
  mocks.join.mockImplementation((...parts: string[]) => {
    const actualJoin = mocks.actualJoin
    if (actualJoin === undefined) {
      throw new Error('join factory did not capture the real implementation')
    }
    return actualJoin(...parts)
  })
})

const sorted = (a: string[]) => [...a].sort()

// ============================================================================
// Per-walker cases (both BFS code paths)
// ============================================================================

describe.each([0, 1])('walker[%i]', (walkerIndex) => {
  const walker = () => WALKERS[walkerIndex]

  // AC: AC3 — in-scope files returned, out-of-scope excluded.
  it('includes in-scope files and excludes everything outside the scope prefix', async () => {
    const result = await walker().run(base, [dirAB])
    const files = result.files
    expect(sorted(files)).toEqual(sorted([fInB, fDeep]))
    for (const excluded of [fRoot, fBar, fInA, fBoundary, fOut]) {
      expect(files).not.toContain(excluded)
    }
  })

  // AC: AC5 — boundary-safe: /a/b must not match the name-prefix sibling /a/bc.
  it('does not match the name-prefix sibling directory (/a/b vs /a/bc)', async () => {
    const result = await walker().run(base, [dirAB])
    expect(result.files).not.toContain(fBoundary)
    expect(visited).not.toContain(dirABc)
  })

  // AC: AC5 — an exact file-path scope matches exactly that file.
  it('matches an exact file-path scope', async () => {
    const result = await walker().run(base, [fBar])
    expect(result.files).toEqual([fBar])
    expect(visited).not.toContain(dirA)
    expect(visited).not.toContain(dirX)
  })

  // AC: AC3/AC5 — a deep scope is reachable via ancestor descent (no false pruning).
  it('reaches a deep scope by descending its ancestor chain without false pruning', async () => {
    const result = await walker().run(base, [dirABC])
    const files = result.files
    expect(files).toEqual([fDeep])
    expect(files).not.toContain(fInB)
    expect(visited).toEqual(expect.arrayContaining([base, dirA, dirAB, dirABC]))
    expect(visited).not.toContain(dirABc)
    expect(visited).not.toContain(dirX)
  })

  // AC: AC4a — a root intersecting no prefix is skipped entirely (zero readdir);
  // scope outside the base dir yields an empty result rather than an error.
  it('skips a non-intersecting root entirely (zero readdir, empty result)', async () => {
    const result = await walker().run(base, [outsideBase])
    expect(result.files).toEqual([])
    expect(visited).toHaveLength(0)
  })

  // AC: AC7 — scope absent is byte-for-byte the full traversal (regression guard).
  it('leaves traversal and collection unchanged when scope is absent (undefined and [])', async () => {
    const undefinedRun = await walker().run(base, undefined)
    const undefinedFiles = undefinedRun.files
    const undefinedVisited = [...visited]

    visited.length = 0
    const emptyRun = await walker().run(base, [])
    const emptyFiles = emptyRun.files
    const emptyVisited = [...visited]

    expect(sorted(undefinedFiles)).toEqual(sorted(allFiles))
    expect(sorted(undefinedVisited)).toEqual(sorted(allDirs))
    // Empty scope array is treated identically to absent scope.
    expect(sorted(emptyFiles)).toEqual(sorted(undefinedFiles))
    expect(sorted(emptyVisited)).toEqual(sorted(undefinedVisited))
  })

  // AC: AC11 (Reference Contract, structure-order) — scope changes membership
  // only, never order. The scoped file list equals the unscoped file list
  // filtered to the surviving members, preserving relative order.
  it('preserves file order under scope (membership-only change)', async () => {
    const unscoped = (await walker().run(base, undefined)).files
    visited.length = 0
    const scoped = (await walker().run(base, [dirAB])).files
    const survivors = new Set(scoped)
    expect(scoped).toEqual(unscoped.filter((f) => survivors.has(f)))
  })

  // Trailing-separator equivalence is a property of the prefix predicate, proved
  // on it directly in scope-match.test.ts. This file asserts pruning behavior,
  // which that spelling does not change.

  // AC: AC4a — THE load-bearing pushdown proof. A readdir mock that returns
  // EACCES for a scope-outside path AND records visits shows that path is never
  // visited under scope (no recorded call, no warning). The companion sentinel
  // assertion proves the probe CAN fire when the path is not pruned, so the
  // non-visitation is real pushdown, not a dead probe.
  it('never descends into a scope-outside subtree (readdir EACCES probe is never called)', async () => {
    mocks.readdir.mockImplementation(realDelegate(new Set([dirX])))
    const scopedResult = await walker().run(base, [dirAB])

    // Pruned: the deny-path was never queried and produced no warning.
    expect(visited).not.toContain(dirX)
    expect(scopedResult.warnedFor(dirX)).toBe(false)
    expect(scopedResult.warnCount).toBe(0)
    // Result is still correct.
    expect(sorted(scopedResult.files)).toEqual(sorted([fInB, fDeep]))

    // Sentinel validity: without scope the SAME deny fires — x is read and warns.
    visited.length = 0
    const unscopedResult = await walker().run(base, undefined)
    expect(visited).toContain(dirX)
    expect(unscopedResult.warnedFor(dirX)).toBe(true)
  })

  // AC: AC10 — an in-scope unreadable directory still warns exactly as today.
  it('still warns when an in-scope directory is unreadable', async () => {
    mocks.readdir.mockImplementation(realDelegate(new Set([dirAB])))
    const result = await walker().run(base, [dirAB])
    expect(visited).toContain(dirAB)
    expect(result.warnedFor(dirAB)).toBe(true)
  })

  // AC: AC10 — an ancestor directory descended to reach a deep scope still warns.
  it('still warns when an ancestor directory on the descent path is unreadable', async () => {
    mocks.readdir.mockImplementation(realDelegate(new Set([dirA])))
    const result = await walker().run(base, [dirABC])
    expect(visited).toContain(dirA)
    expect(result.warnedFor(dirA)).toBe(true)
  })

  // AC: AC8 — cross-platform separator: a `\`-style prefix prunes correctly on a
  // synthetic Windows-style tree (host-OS independent; proves the walker
  // delegates separator handling to scope-match, not a hardcoded `/`).
  it('prunes correctly with a backslash-style separator', async () => {
    const winBase = 'C:\\base'
    const dirMap = new Map<string, Array<[string, EntryType]>>([
      ['C:\\base', [['a', 'directory']]],
      [
        'C:\\base\\a',
        [
          ['b', 'directory'],
          ['bc', 'directory'],
        ],
      ],
      ['C:\\base\\a\\b', [['in-b.md', 'file']]],
      ['C:\\base\\a\\bc', [['boundary.md', 'file']]],
    ])
    useSyntheticBackslashTree(dirMap)

    const result = await walker().run(winBase, ['C:\\base\\a\\b'])
    expect(result.files).toEqual(['C:\\base\\a\\b\\in-b.md'])
    expect(visited).not.toContain('C:\\base\\a\\bc')
  })
})

// Path-granular coverage facts (`bfsCollectSupportedFiles` only).
//
// Sync turns these paths into prefixes that protect exactly the unobserved
// regions from prune, so each fact must name the first unvisited directory —
// not a boolean, and not a parent path.
describe('bfsCollectSupportedFiles coverage facts', () => {
  it('reports the first unvisited directory in depthLimitedDirs and omits fully visited siblings', async () => {
    // maxDepth 3: base(0) a(1) x(1) a/b(2) a/bc(2) x/y(2) are read; a/b/c(3) is
    // dequeued and skipped, so it is the only unobserved region.
    const result = await bfsCollectSupportedFiles(base, [], { maxDepth: 3 })

    expect(result.depthLimitedDirs).toEqual([dirABC])
    // Fully visited siblings/ancestors are observed and must stay prunable.
    for (const observed of [base, dirA, dirAB, dirABc, dirX, dirXY]) {
      expect(result.depthLimitedDirs).not.toContain(observed)
    }
    expect(sorted(result.files)).toEqual(sorted([fRoot, fBar, fInA, fInB, fBoundary, fOut]))
    expect(result.files).not.toContain(fDeep)
  })

  it('keeps depthLimited equal to depthLimitedDirs.length > 0', async () => {
    const limited = await bfsCollectSupportedFiles(base, [], { maxDepth: 3 })
    expect(limited.depthLimitedDirs.length).toBeGreaterThan(0)
    expect(limited.depthLimited).toBe(true)

    const complete = await bfsCollectSupportedFiles(base, [], { maxDepth: 10 })
    expect(complete.depthLimitedDirs).toEqual([])
    expect(complete.depthLimited).toBe(false)
  })

  it('records every depth-limited branch, one entry per first unvisited directory', async () => {
    // maxDepth 2: a/b, a/bc and x/y are all dequeued and skipped; a/b/c is never
    // enqueued, so descendants of an unobserved directory are not repeated.
    const result = await bfsCollectSupportedFiles(base, [], { maxDepth: 2 })

    expect(sorted(result.depthLimitedDirs)).toEqual(sorted([dirAB, dirABc, dirXY]))
    expect(result.depthLimitedDirs).not.toContain(dirABC)
  })

  it('keeps the { dirPath, code } shape for an unreadable directory', async () => {
    mocks.readdir.mockImplementation(realDelegate(new Set([dirA])))
    const result = await bfsCollectSupportedFiles(base, [])

    expect(result.unreadableDirs).toEqual([{ dirPath: dirA, code: 'EACCES' }])
    expect(result.depthLimitedDirs).toEqual([])
    expect(result.skippedSymlinks).toEqual([])
  })

  it('records the full path of every symlinked entry in skippedSymlinks', async () => {
    // Mocked `Dirent`s, not a real symlink(): Windows CI cannot create symlinks
    // without elevation, so a real-FS fixture would silently skip there.
    const symRoot = join(tmpRoot, 'symlink-tree')
    const symSub = join(symRoot, 'sub')
    useSyntheticTree(
      new Map<string, Array<[string, EntryType]>>([
        [
          symRoot,
          [
            ['linked-dir', 'symlink'],
            ['real.md', 'file'],
            ['sub', 'directory'],
          ],
        ],
        [
          symSub,
          [
            ['linked-file.md', 'symlink'],
            ['ok.md', 'file'],
          ],
        ],
      ])
    )

    const result = await bfsCollectSupportedFiles(symRoot, [])

    expect(result.skippedSymlinks).toEqual([
      join(symRoot, 'linked-dir'),
      join(symSub, 'linked-file.md'),
    ])
    // Symlinks are skipped, never followed: the linked dir was never read.
    expect(visited).not.toContain(join(symRoot, 'linked-dir'))
    expect(sorted(result.files)).toEqual(sorted([join(symRoot, 'real.md'), join(symSub, 'ok.md')]))
  })

  it('counts depth from whichever root it is passed', async () => {
    // Same maxDepth, different roots: /base/a/b as its own depth-zero root
    // reaches deep.md, which /base cannot reach within the same budget.
    const fromBase = await bfsCollectSupportedFiles(base, [], { maxDepth: 2 })
    expect(fromBase.files).not.toContain(fDeep)
    expect(fromBase.depthLimitedDirs).toContain(dirAB)

    visited.length = 0
    const fromSubtree = await bfsCollectSupportedFiles(dirAB, [], { maxDepth: 2 })
    expect(fromSubtree.files).toContain(fDeep)
    expect(fromSubtree.depthLimitedDirs).toEqual([])
    expect(visited).toEqual(expect.arrayContaining([dirAB, dirABC]))
  })
})
