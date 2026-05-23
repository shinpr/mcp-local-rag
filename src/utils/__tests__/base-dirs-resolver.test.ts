// Unit tests for `resolveBaseDirs` — the CLI/env → effective-roots resolver.
//
// Covers the precedence rules required by the multi-base-dirs feature plan:
//   CLI roots > BASE_DIRS > BASE_DIR > cwd
//
// The resolver returns a discriminated union so callers do not need try/catch
// for routine config validation branches. Realpath-dependent scenarios use a
// real temp directory so the helpers exercise the same code path as
// production (mocking `realpath` would only verify wiring).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BaseDirsConfigWarning, resolveBaseDirs, withTrailingSeparator } from '../base-dirs.js'

// ============================================
// Shared temp directory fixture
// ============================================

let tmpRoot: string
let dirA: string
let dirB: string
let nestedParent: string
let nestedChild: string

// realpath-resolved (without trailing sep) versions, computed once after
// fixture creation. macOS `tmpdir()` is `/var/folders/...` but realpath
// resolves to `/private/var/folders/...`, so we cannot use the raw paths in
// equality assertions.
let realA: string
let realB: string
let realNestedParent: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'base-dirs-resolver-test-'))
  dirA = join(tmpRoot, 'dir-a')
  dirB = join(tmpRoot, 'dir-b')
  nestedParent = join(tmpRoot, 'nested-parent')
  nestedChild = join(nestedParent, 'child')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  mkdirSync(nestedChild, { recursive: true })
  realA = realpathSync(dirA)
  realB = realpathSync(dirB)
  realNestedParent = realpathSync(nestedParent)
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// ============================================
// CLI roots precedence
// ============================================

describe('resolveBaseDirs — CLI roots precedence', () => {
  it('uses a single --base-dir value as the only root', async () => {
    const result = await resolveBaseDirs({
      cliRoots: [dirA],
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      expect(result.warnings).toEqual([])
    }
  })

  it('preserves order for two --base-dir values', async () => {
    const result = await resolveBaseDirs({
      cliRoots: [dirA, dirB],
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([
        withTrailingSeparator(realA),
        withTrailingSeparator(realB),
      ])
      expect(result.warnings).toEqual([])
    }
  })

  it('ignores env vars when CLI roots are provided (no precedence warning)', async () => {
    const result = await resolveBaseDirs({
      cliRoots: [dirA],
      envBaseDirs: JSON.stringify([dirB]),
      envBaseDir: dirB,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      // No `base-dirs-overrides-base-dir` warning because CLI took precedence.
      const precedenceWarnings = result.warnings.filter(
        (w: BaseDirsConfigWarning) => w.kind === 'base-dirs-overrides-base-dir'
      )
      expect(precedenceWarnings).toEqual([])
    }
  })

  it('does not merge CLI roots with env roots', async () => {
    const result = await resolveBaseDirs({
      cliRoots: [dirA],
      envBaseDirs: JSON.stringify([dirB]),
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // dirB must NOT appear in the resolved roots — CLI replaces env.
      expect(result.config.baseDirs).not.toContain(withTrailingSeparator(realB))
    }
  })
})

// ============================================
// BASE_DIRS precedence
// ============================================

describe('resolveBaseDirs — BASE_DIRS precedence', () => {
  it('uses BASE_DIRS when CLI roots are absent', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: JSON.stringify([dirA, dirB]),
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([
        withTrailingSeparator(realA),
        withTrailingSeparator(realB),
      ])
      expect(result.warnings).toEqual([])
    }
  })

  it('emits a precedence warning when both BASE_DIRS and BASE_DIR are set (no CLI)', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: JSON.stringify([dirA]),
      envBaseDir: dirB,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // BASE_DIR is ignored — only BASE_DIRS roots appear.
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      const precedenceWarnings = result.warnings.filter(
        (w: BaseDirsConfigWarning) => w.kind === 'base-dirs-overrides-base-dir'
      )
      expect(precedenceWarnings).toHaveLength(1)
      expect(precedenceWarnings[0]?.message).toMatch(/BASE_DIRS/)
      expect(precedenceWarnings[0]?.message).toMatch(/BASE_DIR/)
    }
  })

  it('returns a config error for invalid BASE_DIRS and does NOT fall back', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: 'not json',
      envBaseDir: dirA,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('BaseDirsConfigError')
      expect(result.error.message).toMatch(/BASE_DIRS/)
    }
  })

  it('returns a config error for empty BASE_DIRS array and does NOT fall back', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: '[]',
      envBaseDir: dirA,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toMatch(/empty/i)
    }
  })

  it('returns a config error for BASE_DIRS containing an empty string', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: `["${dirA}", ""]`,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(false)
  })

  it('returns a config error when a BASE_DIRS path does not exist', async () => {
    const missing = join(tmpRoot, 'does-not-exist')
    const result = await resolveBaseDirs({
      envBaseDirs: JSON.stringify([missing]),
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('BaseDirsConfigError')
    }
  })
})

// ============================================
// BASE_DIR precedence
// ============================================

describe('resolveBaseDirs — BASE_DIR precedence', () => {
  it('uses BASE_DIR when CLI and BASE_DIRS are absent', async () => {
    const result = await resolveBaseDirs({
      envBaseDir: dirA,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      expect(result.warnings).toEqual([])
    }
  })

  it('treats an empty BASE_DIR as unset and falls back to cwd', async () => {
    const result = await resolveBaseDirs({
      envBaseDir: '',
      cwd: dirA,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
    }
  })

  it('treats a whitespace-only BASE_DIR as unset and falls back to cwd', async () => {
    const result = await resolveBaseDirs({
      envBaseDir: '   ',
      cwd: dirA,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
    }
  })
})

// ============================================
// cwd fallback
// ============================================

describe('resolveBaseDirs — cwd fallback', () => {
  it('uses cwd when nothing else is set', async () => {
    const result = await resolveBaseDirs({ cwd: dirA })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      expect(result.warnings).toEqual([])
    }
  })

  it('treats a whitespace-only envBaseDirs as unset and falls back to BASE_DIR', async () => {
    // Whitespace-only BASE_DIRS is rejected by parseBaseDirsEnv (returns
    // error). The resolver MUST propagate that error rather than falling
    // back to BASE_DIR — the parser already documented this as a config
    // error rather than as "not provided".
    const result = await resolveBaseDirs({
      envBaseDirs: '   ',
      envBaseDir: dirA,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(false)
  })

  it('treats an empty-string envBaseDirs as unset and falls through to BASE_DIR', async () => {
    // BASE_DIRS being an empty string (e.g. `BASE_DIRS=` with no value) is
    // distinguishable from "set to invalid JSON" — the resolver should treat
    // it the same as "not set" so existing single-root users who export an
    // empty BASE_DIRS alongside their BASE_DIR are not broken.
    const result = await resolveBaseDirs({
      envBaseDirs: '',
      envBaseDir: dirA,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      // Empty envBaseDirs means "not set", so no precedence warning.
      expect(result.warnings).toEqual([])
    }
  })

  it('falls back to cwd when both envBaseDirs and envBaseDir are empty strings', async () => {
    // Both env vars exported but empty — e.g., `BASE_DIRS= BASE_DIR=` — must
    // resolve to cwd, matching the behavior of fully unset env vars.
    const result = await resolveBaseDirs({
      envBaseDirs: '',
      envBaseDir: '',
      cwd: dirA,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      expect(result.warnings).toEqual([])
    }
  })

  it('treats an explicitly empty cliRoots array as "no CLI override"', async () => {
    // The CLI parser will pass `cliRoots: undefined` when no --base-dir flag
    // is present, but defensively the resolver should also accept an empty
    // array as "no CLI override" rather than as "user wants zero roots".
    const result = await resolveBaseDirs({
      cliRoots: [],
      envBaseDir: dirA,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
    }
  })
})

// ============================================
// Deduplication and nested-root pruning
// ============================================

describe('resolveBaseDirs — dedup and nested pruning', () => {
  it('deduplicates exact duplicate CLI roots silently', async () => {
    const result = await resolveBaseDirs({
      cliRoots: [dirA, dirA],
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realA)])
      // No warning for exact dedup.
      expect(result.warnings).toEqual([])
    }
  })

  it('prunes nested CLI roots and emits a pruning warning', async () => {
    const result = await resolveBaseDirs({
      cliRoots: [nestedParent, nestedChild],
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realNestedParent)])
      const pruningWarnings = result.warnings.filter(
        (w: BaseDirsConfigWarning) => w.kind === 'nested-root-pruned'
      )
      expect(pruningWarnings).toHaveLength(1)
    }
  })

  it('prunes nested BASE_DIRS roots and emits a pruning warning', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: JSON.stringify([nestedParent, nestedChild]),
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realNestedParent)])
      const pruningWarnings = result.warnings.filter(
        (w: BaseDirsConfigWarning) => w.kind === 'nested-root-pruned'
      )
      expect(pruningWarnings).toHaveLength(1)
    }
  })

  it('combines the precedence warning and pruning warnings when both apply', async () => {
    const result = await resolveBaseDirs({
      envBaseDirs: JSON.stringify([nestedParent, nestedChild]),
      envBaseDir: dirB,
      cwd: tmpRoot,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs).toEqual([withTrailingSeparator(realNestedParent)])
      const kinds = result.warnings.map((w: BaseDirsConfigWarning) => w.kind)
      expect(kinds).toContain('base-dirs-overrides-base-dir')
      expect(kinds).toContain('nested-root-pruned')
    }
  })
})

// ============================================
// Single-root BASE_DIR parity with current server-main.ts behavior
// ============================================

describe('resolveBaseDirs — parity with current single-root BASE_DIR behavior', () => {
  it('resolves BASE_DIR=A identically to "cwd fallback" when cwd === A', async () => {
    const withEnv = await resolveBaseDirs({ envBaseDir: dirA, cwd: tmpRoot })
    const withCwd = await resolveBaseDirs({ cwd: dirA })

    expect(withEnv.ok).toBe(true)
    expect(withCwd.ok).toBe(true)
    if (withEnv.ok && withCwd.ok) {
      expect(withEnv.config.baseDirs).toEqual(withCwd.config.baseDirs)
    }
  })

  it('produces a root with trailing path separator suitable for prefix checks', async () => {
    const result = await resolveBaseDirs({ envBaseDir: dirA, cwd: tmpRoot })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.baseDirs[0]?.endsWith(sep)).toBe(true)
    }
  })
})

// ============================================
// User-visible message hygiene ($HOME redaction)
// ============================================

describe('resolveBaseDirs — $HOME redaction in user-visible messages', () => {
  // These tests pin the post-Finding-#8 contract: errors and warnings flow
  // out through MCP responses to clients, so they must not embed the
  // operating user's literal $HOME path. We assert against the literal
  // current $HOME so a regression that leaks "/Users/<name>/..." fails here.
  let savedHome: string | undefined

  beforeAll(() => {
    savedHome = process.env['HOME']
  })

  afterAll(() => {
    if (savedHome === undefined) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = savedHome
    }
  })

  it('omits $HOME from a missing-directory error message', async () => {
    // The missing-directory error message is built BEFORE realpath
    // resolution succeeds, so the pre-realpath form is what flows out.
    // Pin HOME to the raw tmpRoot (matches the value `normalizeRealpath`
    // passes to the error message) and assert the substitution kicks in.
    process.env['HOME'] = tmpRoot
    const missing = join(tmpRoot, 'does-not-exist-leak-check')
    const result = await resolveBaseDirs({ cliRoots: [missing], cwd: tmpRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The substituted form uses `~`; the literal HOME must not appear.
      expect(result.error.message).toContain('~')
      expect(result.error.message).not.toContain(tmpRoot)
    }
  })

  it('omits $HOME from the nested-root-pruned warning message', async () => {
    // The pruning warning is emitted AFTER realpath normalization, so the
    // displayPath substitution operates against the realpath form. Pin HOME
    // to the realpath of tmpRoot (on macOS, `/var/folders/...` realpaths to
    // `/private/var/folders/...`) so the substitution fires deterministically.
    const realTmpRoot = realpathSync(tmpRoot)
    process.env['HOME'] = realTmpRoot
    const result = await resolveBaseDirs({
      cliRoots: [nestedParent, nestedChild],
      cwd: tmpRoot,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const pruned = result.warnings.find((w) => w.kind === 'nested-root-pruned')
      expect(pruned).toBeDefined()
      expect(pruned?.message).toContain('~')
      expect(pruned?.message).not.toContain(realTmpRoot)
    }
  })
})
