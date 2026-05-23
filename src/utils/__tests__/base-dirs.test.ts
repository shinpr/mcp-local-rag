// Unit tests for the shared base-dirs module.
//
// Covers the pure helpers consumed by both CLI and server entry points:
// - JSON-array parser for the `BASE_DIRS` environment variable
// - Realpath normalization + trailing-separator prefix safety
// - Exact deduplication and nested-root pruning
// - Legacy single-root accessor compatibility
//
// Realpath-dependent scenarios use a real temp directory so the helpers
// exercise the same behavior they will hit in production (mocking `realpath`
// would only verify wiring, not correctness).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type BaseDirsConfig,
  BaseDirsConfigError,
  type BaseDirsConfigWarning,
  dedupAndPruneRoots,
  displayPath,
  legacyBaseDir,
  normalizeRealpath,
  parseBaseDirsEnv,
  withTrailingSeparator,
} from '../base-dirs.js'

// ============================================
// Shared temp directory fixture
// ============================================

let tmpRoot: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'base-dirs-test-'))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ============================================
// parseBaseDirsEnv — JSON-array parser
// ============================================

describe('parseBaseDirsEnv', () => {
  it('parses a valid JSON array of non-empty strings', () => {
    const result = parseBaseDirsEnv('["/a","/b","/c"]')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual(['/a', '/b', '/c'])
    }
  })

  it('rejects non-JSON input', () => {
    const result = parseBaseDirsEnv('not json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BaseDirsConfigError)
      expect(result.error.message).toMatch(/BASE_DIRS/)
    }
  })

  it('rejects delimiter syntax like /a:/b', () => {
    const result = parseBaseDirsEnv('/a:/b')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BaseDirsConfigError)
    }
  })

  it('rejects an empty array', () => {
    const result = parseBaseDirsEnv('[]')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toMatch(/empty/i)
    }
  })

  it('rejects an array containing an empty string', () => {
    const result = parseBaseDirsEnv('[""]')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BaseDirsConfigError)
    }
  })

  it('rejects an array containing a non-string element', () => {
    const result = parseBaseDirsEnv('[1, 2]')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BaseDirsConfigError)
    }
  })

  it('rejects a JSON object (must be an array)', () => {
    const result = parseBaseDirsEnv('{"a":"/a"}')
    expect(result.ok).toBe(false)
  })

  it('rejects a JSON string scalar', () => {
    const result = parseBaseDirsEnv('"/a"')
    expect(result.ok).toBe(false)
  })

  it('trims whitespace around the JSON payload', () => {
    const result = parseBaseDirsEnv('  ["/a"]  ')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual(['/a'])
    }
  })

  it('rejects an array containing a whitespace-only string', () => {
    const result = parseBaseDirsEnv('["   "]')
    expect(result.ok).toBe(false)
  })
})

// ============================================
// withTrailingSeparator — prefix safety helper
// ============================================

describe('withTrailingSeparator', () => {
  it('appends a path separator when one is missing', () => {
    expect(withTrailingSeparator(`${sep}foo${sep}bar`)).toBe(`${sep}foo${sep}bar${sep}`)
  })

  it('leaves an already-suffixed path unchanged', () => {
    expect(withTrailingSeparator(`${sep}foo${sep}bar${sep}`)).toBe(`${sep}foo${sep}bar${sep}`)
  })

  it('produces a prefix that does not match a sibling like /foo/barista', () => {
    const root = withTrailingSeparator(`${sep}foo${sep}bar`)
    const sibling = `${sep}foo${sep}barista`
    expect(sibling.startsWith(root)).toBe(false)
  })

  it('produces a prefix that does match a true child like /foo/bar/baz', () => {
    const root = withTrailingSeparator(`${sep}foo${sep}bar`)
    const child = `${sep}foo${sep}bar${sep}baz`
    expect(child.startsWith(root)).toBe(true)
  })
})

// ============================================
// normalizeRealpath — realpath + trailing separator
// ============================================

describe('normalizeRealpath', () => {
  it('resolves a real directory to its realpath with a trailing separator', async () => {
    const dir = join(tmpRoot, 'real-dir')
    mkdirSync(dir)
    const result = await normalizeRealpath(dir)
    expect(result.endsWith(sep)).toBe(true)
    // realpath may add /private prefix on macOS — only assert tail invariants.
    expect(result).toMatch(/real-dir[\\/]$/)
  })

  it('follows symlinks to the target directory', async () => {
    const target = join(tmpRoot, 'sym-target')
    const link = join(tmpRoot, 'sym-link')
    mkdirSync(target)
    symlinkSync(target, link, 'dir')
    const resolved = await normalizeRealpath(link)
    expect(resolved).toMatch(/sym-target[\\/]$/)
  })

  it('rejects when the path does not exist', async () => {
    await expect(normalizeRealpath(join(tmpRoot, 'does-not-exist'))).rejects.toBeInstanceOf(
      BaseDirsConfigError
    )
  })
})

// ============================================
// dedupAndPruneRoots — exact dedup + nested pruning
// ============================================

describe('dedupAndPruneRoots', () => {
  it('returns a single root unchanged with no warnings', async () => {
    const root = join(tmpRoot, 'single')
    mkdirSync(root, { recursive: true })
    const resolved = await normalizeRealpath(root)
    const { roots, warnings } = dedupAndPruneRoots([resolved])
    expect(roots).toEqual([resolved])
    expect(warnings).toEqual([])
  })

  it('deduplicates exact duplicate realpath roots without emitting a warning', async () => {
    const root = join(tmpRoot, 'dup')
    mkdirSync(root, { recursive: true })
    const resolved = await normalizeRealpath(root)
    const { roots, warnings } = dedupAndPruneRoots([resolved, resolved])
    expect(roots).toEqual([resolved])
    expect(warnings).toEqual([])
  })

  it('prunes a nested child root and emits a warning referencing parent and child', async () => {
    const parent = join(tmpRoot, 'parent')
    const child = join(parent, 'child')
    mkdirSync(child, { recursive: true })
    const resolvedParent = await normalizeRealpath(parent)
    const resolvedChild = await normalizeRealpath(child)

    const { roots, warnings } = dedupAndPruneRoots([resolvedParent, resolvedChild])
    expect(roots).toEqual([resolvedParent])
    expect(warnings).toHaveLength(1)
    const warning = warnings[0] as BaseDirsConfigWarning
    expect(warning.kind).toBe('nested-root-pruned')
    expect(warning.message).toContain(displayPath(resolvedParent))
    expect(warning.message).toContain(displayPath(resolvedChild))
  })

  it('prunes a nested child even when listed before its parent', async () => {
    const parent = join(tmpRoot, 'order-parent')
    const child = join(parent, 'inner')
    mkdirSync(child, { recursive: true })
    const resolvedParent = await normalizeRealpath(parent)
    const resolvedChild = await normalizeRealpath(child)

    const { roots, warnings } = dedupAndPruneRoots([resolvedChild, resolvedParent])
    expect(roots).toEqual([resolvedParent])
    expect(warnings).toHaveLength(1)
  })

  it('prunes both child and grandchild in a 3-level chain, keeping only the grandparent', async () => {
    // Chain: grandparent / parent / child — the implementation documents that
    // both descendants get pruned and each warning references the closest
    // surviving ancestor (the grandparent, since `parent` is itself pruned).
    const grandparent = join(tmpRoot, 'chain-grand')
    const parent = join(grandparent, 'middle')
    const child = join(parent, 'leaf')
    mkdirSync(child, { recursive: true })
    const resolvedGrand = await normalizeRealpath(grandparent)
    const resolvedParent = await normalizeRealpath(parent)
    const resolvedChild = await normalizeRealpath(child)

    const { roots, warnings } = dedupAndPruneRoots([resolvedGrand, resolvedParent, resolvedChild])

    expect(roots).toEqual([resolvedGrand])
    expect(warnings).toHaveLength(2)
    // Both pruned entries should reference the grandparent as the closest
    // surviving ancestor, not the (also-pruned) parent.
    for (const warning of warnings) {
      expect(warning.kind).toBe('nested-root-pruned')
      if (warning.kind === 'nested-root-pruned') {
        expect(warning.parent).toBe(resolvedGrand)
      }
    }
    const prunedPaths = warnings
      .filter(
        (w): w is Extract<BaseDirsConfigWarning, { kind: 'nested-root-pruned' }> =>
          w.kind === 'nested-root-pruned'
      )
      .map((w) => w.pruned)
    expect(prunedPaths).toContain(resolvedParent)
    expect(prunedPaths).toContain(resolvedChild)
  })

  it('keeps unrelated sibling roots that share a prefix but are not nested', async () => {
    // /foo/bar should NOT be considered nested under /foo/barista.
    const bar = join(tmpRoot, 'bar')
    const barista = join(tmpRoot, 'barista')
    mkdirSync(bar, { recursive: true })
    mkdirSync(barista, { recursive: true })
    const resolvedBar = await normalizeRealpath(bar)
    const resolvedBarista = await normalizeRealpath(barista)

    const { roots, warnings } = dedupAndPruneRoots([resolvedBar, resolvedBarista])
    expect(roots).toEqual([resolvedBar, resolvedBarista])
    expect(warnings).toEqual([])
  })
})

// ============================================
// legacyBaseDir — single-root accessor
// ============================================

describe('legacyBaseDir', () => {
  it('returns the first effective root as the legacy baseDir', () => {
    const config: BaseDirsConfig = { baseDirs: ['/first/', '/second/'] }
    expect(legacyBaseDir(config)).toBe('/first/')
  })

  it('returns the only element for a single-root config', () => {
    const config: BaseDirsConfig = { baseDirs: ['/only/'] }
    expect(legacyBaseDir(config)).toBe('/only/')
  })
})

// ============================================
// displayPath — $HOME substitution for user-visible messages
// ============================================

describe('displayPath', () => {
  // Save+restore $HOME so the assertions stay deterministic even when the
  // test runner inherits the developer's actual home directory.
  let originalHome: string | undefined

  beforeAll(() => {
    originalHome = process.env['HOME']
  })

  afterAll(() => {
    if (originalHome === undefined) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = originalHome
    }
  })

  it('substitutes the exact $HOME prefix with ~', () => {
    process.env['HOME'] = '/Users/jdoe'
    expect(displayPath('/Users/jdoe/work/docs')).toBe('~/work/docs')
  })

  it('returns the exact $HOME path as ~', () => {
    process.env['HOME'] = '/Users/jdoe'
    expect(displayPath('/Users/jdoe')).toBe('~')
  })

  it('leaves sibling paths that merely share a prefix unchanged', () => {
    // `/Users/jdoe-other/...` MUST NOT collapse to `~-other/...`.
    process.env['HOME'] = '/Users/jdoe'
    expect(displayPath('/Users/jdoe-other/docs')).toBe('/Users/jdoe-other/docs')
  })

  it('returns the path unchanged when $HOME is unset', () => {
    delete process.env['HOME']
    expect(displayPath('/Users/jdoe/work/docs')).toBe('/Users/jdoe/work/docs')
  })

  it('returns the path unchanged when $HOME does not match', () => {
    process.env['HOME'] = '/Users/jdoe'
    expect(displayPath('/var/lib/data')).toBe('/var/lib/data')
  })
})
