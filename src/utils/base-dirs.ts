// Shared base-dirs module: one internal representation of the effective
// document roots, used by both the CLI and the MCP server entry point, plus
// the pure helpers that derive it from env vars and CLI flags.

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { AppError, toError } from './errors.js'

// ============================================
// Types
// ============================================

/**
 * Effective document roots, in two index-aligned forms. This is the canonical
 * statement of the path policy; other sites reference it.
 *
 * - `baseDirs`: realpath-resolved — the containment boundary for
 *   `DocumentParser`, and the ONLY place realpath is used.
 * - `rawBaseDirs`: the same roots, resolve()-only. Everything user-facing
 *   scans and displays in this space so paths match the resolve()-stored DB
 *   keys; otherwise a symlinked prefix (macOS /tmp → /private/tmp) would make
 *   ingested files look un-ingested.
 */
export interface BaseDirsConfig {
  baseDirs: string[]
  rawBaseDirs: string[]
}

/**
 * Discriminated union of configuration warnings surfaced by helpers in this
 * module. Both CLI (stderr) and MCP (tool response content block) paths
 * consume these — the consumer decides how to render them.
 */
export type BaseDirsConfigWarning =
  | {
      kind: 'nested-root-pruned'
      message: string
      parent: string
      pruned: string
    }
  | {
      kind: 'base-dirs-overrides-base-dir'
      message: string
    }

/**
 * Configuration error raised by parsers and the realpath helper. Modeled as
 * a dedicated subclass so consumers can distinguish configuration problems
 * from other I/O errors (e.g. `ValidationError` from `DocumentParser`).
 */
export class BaseDirsConfigError extends AppError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, 'config', 'config', options)
    this.name = 'BaseDirsConfigError'
  }
}

/**
 * Result of {@link parseBaseDirsEnv}. A discriminated union avoids forcing
 * callers to use `try/catch` for what is a routine configuration-validation
 * branch (invalid input → structured error → user-facing message).
 */
export type ParseBaseDirsResult =
  | { ok: true; value: string[] }
  | { ok: false; error: BaseDirsConfigError }

// ============================================
// Path display helpers
// ============================================

/**
 * Substitute `$HOME` with `~` for a user-visible path, so a warning flowing
 * out through MCP does not leak the OS username. `$HOME` is read at call time,
 * never cached.
 */
export function displayPath(path: string): string {
  const home = process.env['HOME'] || homedir()
  if (home.length === 0) {
    return path
  }
  const isWin = process.platform === 'win32'
  const cmp = (s: string): string => (isWin ? s.toLowerCase() : s)
  const homeCmp = cmp(home)
  const pathCmp = cmp(path)
  if (pathCmp === homeCmp) {
    return '~'
  }
  if (pathCmp.startsWith(homeCmp + sep) || pathCmp.startsWith(`${homeCmp}/`)) {
    return `~${path.slice(home.length)}`
  }
  return path
}

// ============================================
// JSON-array parser for BASE_DIRS
// ============================================

/**
 * Parse `BASE_DIRS`: only a JSON array of non-empty strings is accepted, so
 * delimiter syntax like `'/a:/b'` is an error rather than a silent misread.
 * Syntax only — existence is {@link normalizeRealpath}'s job.
 */
export function parseBaseDirsEnv(raw: string): ParseBaseDirsResult {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: new BaseDirsConfigError(
        'BASE_DIRS must be a JSON array of non-empty path strings (received empty value).'
      ),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return {
      ok: false,
      error: new BaseDirsConfigError(
        `BASE_DIRS must be a JSON array of non-empty path strings. Failed to parse as JSON: ${truncate(raw)}`,
        { cause: toError(error) }
      ),
    }
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: new BaseDirsConfigError(
        `BASE_DIRS must be a JSON array (received ${describeJsonShape(parsed)}).`
      ),
    }
  }

  if (parsed.length === 0) {
    return {
      ok: false,
      error: new BaseDirsConfigError('BASE_DIRS must not be an empty array.'),
    }
  }

  const value: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i]
    if (typeof item !== 'string') {
      return {
        ok: false,
        error: new BaseDirsConfigError(
          `BASE_DIRS[${i}] must be a string (received ${describeJsonShape(item)}).`
        ),
      }
    }
    if (item.trim().length === 0) {
      return {
        ok: false,
        error: new BaseDirsConfigError(
          `BASE_DIRS[${i}] must be a non-empty, non-whitespace path string.`
        ),
      }
    }
    value.push(item)
  }

  return { ok: true, value }
}

// ============================================
// Realpath normalization
// ============================================

/**
 * Append a trailing path separator if the input does not already end with
 * one. This is the prefix-safety pattern used throughout the parser
 * (`/foo/bar` must not match `/foo/barista`).
 */
export function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

/**
 * Resolve a directory to its realpath and append a trailing separator, so the
 * result works directly as a prefix in a containment check.
 *
 * Throws when the path is not an existing directory: a root must point at one.
 */
export async function normalizeRealpath(path: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(resolve(path))
  } catch (error) {
    throw new BaseDirsConfigError(
      `Failed to resolve base directory: ${displayPath(path)}. The directory may not exist or is inaccessible.`,
      { cause: toError(error) }
    )
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(resolved)
  } catch (error) {
    throw new BaseDirsConfigError(
      `Failed to stat resolved base directory: ${displayPath(resolved)}.`,
      { cause: toError(error) }
    )
  }

  if (!stats.isDirectory()) {
    throw new BaseDirsConfigError(
      `Base directory is not a directory: ${displayPath(path)} (resolved: ${displayPath(resolved)}).`
    )
  }

  return withTrailingSeparator(resolved)
}

// ============================================
// Deduplication and nested-root pruning
// ============================================

/**
 * Output of {@link dedupAndPruneRoots}.
 */
export interface DedupAndPruneResult {
  /** Effective roots in input order, after exact dedup and nested pruning. */
  roots: string[]
  /** Warnings describing pruned nested roots, in pruning order. */
  warnings: BaseDirsConfigWarning[]
}

/**
 * Reduce realpath-normalized roots to the effective set.
 *
 * Exact duplicates are dropped silently — that is convenience, not a mistake.
 * A nested root is pruned in favour of its parent with a warning, which keeps
 * scan output free of duplicates without widening the boundary past the parent
 * the user already configured. Surviving order is preserved so the first
 * element stays a meaningful legacy `baseDir`.
 *
 * Every input MUST already end with a separator — that is what makes the
 * `startsWith` check safe against a sibling like `/foo/barista`.
 */
export function dedupAndPruneRoots(inputs: string[]): DedupAndPruneResult {
  // Pass 1: exact dedup, preserving order.
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const root of inputs) {
    if (!seen.has(root)) {
      seen.add(root)
      deduped.push(root)
    }
  }

  // Pass 2: nested-root pruning.
  //
  // In a chain like `[grandparent, parent, child]` both descendants are pruned
  // and each warning names the closest SURVIVING ancestor, so a warning never
  // points at a path that was itself pruned. Hence two passes: the pre-pass
  // computes the survivors, the main pass resolves ancestors against them.
  // O(n^2) in root count, which is harmless at realistic sizes.
  const roots: string[] = []
  const warnings: BaseDirsConfigWarning[] = []
  // Pre-pass: identify every candidate that has any ancestor in `deduped`
  // (these are the pruned candidates). The candidates that do NOT have any
  // ancestor in `deduped` are the surviving roots.
  const survivors: string[] = []
  for (const candidate of deduped) {
    if (findParent(candidate, deduped) === undefined) {
      survivors.push(candidate)
    }
  }
  for (const candidate of deduped) {
    const survivingAncestor = findParent(candidate, survivors)
    if (survivingAncestor === undefined) {
      // This candidate is itself a surviving root.
      roots.push(candidate)
      continue
    }
    warnings.push({
      kind: 'nested-root-pruned',
      message: `Nested base directory pruned: ${displayPath(candidate)} is inside ${displayPath(survivingAncestor)}. Keeping ${displayPath(survivingAncestor)} only.`,
      parent: survivingAncestor,
      pruned: candidate,
    })
  }

  return { roots, warnings }
}

/** Closest ancestor of `candidate` in `all`, measured by prefix length. */
function findParent(candidate: string, all: string[]): string | undefined {
  let best: string | undefined
  for (const other of all) {
    if (other === candidate) {
      continue
    }
    // `other` ends with `sep` (precondition), so this prefix check is
    // sibling-prefix safe.
    if (candidate.startsWith(other)) {
      if (best === undefined || other.length > best.length) {
        best = other
      }
    }
  }
  return best
}

// ============================================
// Root resolver
// ============================================

/**
 * Input to {@link resolveBaseDirs}, in precedence order: `cliRoots` (highest),
 * `envBaseDirs`, `envBaseDir`, `cwd`.
 *
 * The resolver reads no process state, so both entry points can share it and
 * tests can drive it deterministically.
 */
export interface ResolveBaseDirsInput {
  cliRoots?: string[] | undefined
  envBaseDirs?: string | undefined
  envBaseDir?: string | undefined
  cwd: string
}

/**
 * Result of {@link resolveBaseDirs}, discriminated by `ok` — invalid
 * `BASE_DIRS` is a routine user-facing path, not an exception.
 *
 * `warnings` is in display order: the precedence note first, then one entry
 * per pruned root.
 */
export type ResolveBaseDirsResult =
  | { ok: true; config: BaseDirsConfig; warnings: BaseDirsConfigWarning[] }
  | { ok: false; error: BaseDirsConfigError }

/**
 * Resolve effective base directories from CLI / env / cwd.
 *
 * `cliRoots` REPLACES the env roots rather than merging with them; otherwise
 * precedence falls through `BASE_DIRS`, `BASE_DIR`, `cwd`. The
 * `BASE_DIRS > BASE_DIR` warning therefore fires only on an env-driven run.
 *
 * An invalid `BASE_DIRS`, or a root that is not a readable directory, returns
 * `{ ok: false }`. The resolver never falls back to `BASE_DIR` or `cwd` — each
 * caller surfaces the error per its own UI contract.
 */
export async function resolveBaseDirs(input: ResolveBaseDirsInput): Promise<ResolveBaseDirsResult> {
  const selection = selectRoots(input)
  if (!selection.ok) {
    return selection
  }

  const warnings: BaseDirsConfigWarning[] = []
  if (selection.precedenceWarning) {
    warnings.push(selection.precedenceWarning)
  }

  // Realpath-normalize each selected root. Failures (missing directory,
  // permission denied, ...) are surfaced as a structured config error.
  //
  // Pair each realpath'd root (security form) with its resolve()-only form so
  // `rawBaseDirs` mirrors the dedup/prune decisions index-for-index. See
  // {@link BaseDirsConfig} for the path policy.
  const normalized: string[] = []
  const realToRaw = new Map<string, string>()
  for (const root of selection.roots) {
    let real: string
    try {
      real = await normalizeRealpath(root)
    } catch (error) {
      if (error instanceof BaseDirsConfigError) {
        return { ok: false, error }
      }
      throw error
    }
    normalized.push(real)
    // First-occurrence-wins so the surviving raw root matches the first
    // configured spelling of a root that realpaths to the same directory.
    if (!realToRaw.has(real)) {
      realToRaw.set(real, withTrailingSeparator(resolve(root)))
    }
  }

  const { roots, warnings: pruningWarnings } = dedupAndPruneRoots(normalized)
  warnings.push(...pruningWarnings)

  // Project the surviving realpath'd roots back to their resolve()-only forms,
  // preserving order so `rawBaseDirs[i]` and `baseDirs[i]` are the same root.
  const rawRoots = roots.map((real) => realToRaw.get(real) ?? real)

  return {
    ok: true,
    config: { baseDirs: roots, rawBaseDirs: rawRoots },
    warnings,
  }
}

/**
 * Output of {@link selectRoots}. Either picks a source's raw paths (still
 * un-normalized) plus an optional precedence warning, or returns a structured
 * error so the caller can short-circuit.
 */
type SelectRootsResult =
  | {
      ok: true
      roots: string[]
      precedenceWarning?: BaseDirsConfigWarning
    }
  | { ok: false; error: BaseDirsConfigError }

/**
 * Pick which input set of roots wins. String-level only, so the realpath I/O
 * in {@link resolveBaseDirs} stays separate from the precedence rules.
 */
function selectRoots(input: ResolveBaseDirsInput): SelectRootsResult {
  // 1. CLI roots — when non-empty, replace env entirely (no precedence
  //    warning even if env vars are also set, because the user explicitly
  //    overrode them via CLI).
  if (input.cliRoots !== undefined && input.cliRoots.length > 0) {
    return { ok: true, roots: input.cliRoots }
  }

  // 2. BASE_DIRS — when CLI absent. Whitespace-only is treated as an
  //    invalid value (consistent with parseBaseDirsEnv), not as "unset",
  //    so the user notices a malformed env var instead of silently falling
  //    through to BASE_DIR.
  if (input.envBaseDirs !== undefined && input.envBaseDirs.length > 0) {
    const parsed = parseBaseDirsEnv(input.envBaseDirs)
    if (!parsed.ok) {
      return { ok: false, error: parsed.error }
    }

    const precedenceWarning =
      input.envBaseDir !== undefined && input.envBaseDir.trim().length > 0
        ? ({
            kind: 'base-dirs-overrides-base-dir',
            message:
              'BASE_DIRS is set; BASE_DIR is ignored. Unset BASE_DIR or remove BASE_DIRS to silence this warning.',
          } satisfies BaseDirsConfigWarning)
        : undefined

    return precedenceWarning
      ? { ok: true, roots: parsed.value, precedenceWarning }
      : { ok: true, roots: parsed.value }
  }

  // 3. BASE_DIR — when CLI and BASE_DIRS are absent. Whitespace-only is
  //    treated as "unset" (a user clearing the value with spaces gets the
  //    same behavior as not setting it at all).
  if (input.envBaseDir !== undefined && input.envBaseDir.trim().length > 0) {
    return { ok: true, roots: [input.envBaseDir] }
  }

  // 4. cwd — final fallback.
  return { ok: true, roots: [input.cwd] }
}

// ============================================
// Legacy single-root accessor
// ============================================

/**
 * The legacy single-root `baseDir`: the first effective root after pruning.
 * Holds only for a config built via {@link dedupAndPruneRoots}.
 */
export function legacyBaseDir(config: BaseDirsConfig): string {
  const first = config.baseDirs[0]
  if (first === undefined) {
    throw new BaseDirsConfigError('BaseDirsConfig must contain at least one base directory.')
  }
  return first
}

// ============================================
// Private helpers
// ============================================

/** Every shape `describeJsonShape` can report. */
type JsonShape =
  | 'null'
  | 'array'
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'symbol'
  | 'undefined'
  | 'object'
  | 'function'

/**
 * Describe a JSON value's shape for error messages without dumping its full
 * (possibly large) content.
 */
function describeJsonShape(value: unknown): JsonShape {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return typeof value
}

/**
 * Truncate user-supplied input so configuration error messages stay readable
 * even when the offending value is large.
 */
function truncate(input: string, max = 100): string {
  if (input.length <= max) {
    return input
  }
  return `${input.slice(0, max)}...`
}
