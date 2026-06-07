// Pure helpers for the RAGServer `list_files` surface and base-dir config
// normalization. Extracted from `RAGServer` so the bounded-BFS directory scan
// and the constructor's config-shape normalization live as standalone,
// behavior-preserving functions independent of instance state.

import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { displayPath } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import type { RAGServerConfig } from './types.js'

/**
 * Bounded BFS scan of a single base directory for supported files,
 * excluding system-managed paths (dbPath, cacheDir). Returns sorted
 * absolute paths plus a list of non-fatal warnings.
 *
 * Behavior contract:
 *  - Depth is bounded by {@link MAX_SCAN_DEPTH}, mirroring the
 *    CLI ingest walker so the same "how deep do we look under a root"
 *    boundary applies to every list/ingest surface.
 *  - A `readdir` failure under one directory is captured as a warning
 *    rather than aborting the whole list call. One unreadable root must not
 *    hide files under the other roots, so the multi-root contract makes this
 *    asymmetry user-visible, so the policy is now best-effort per root.
 *  - Symlinks are skipped (mirrors the CLI ingest walker).
 */
export async function scanBaseDir(
  baseDir: string,
  excludePaths: readonly string[]
): Promise<{ files: string[]; warnings: string[] }> {
  const files: string[] = []
  const warnings: string[] = []
  let depthLimited = false

  const queue: { dirPath: string; depth: number }[] = [{ dirPath: baseDir, depth: 0 }]

  while (queue.length > 0) {
    const { dirPath, depth } = queue.shift()!

    if (depth >= MAX_SCAN_DEPTH) {
      depthLimited = true
      continue
    }

    // TypeScript's `readdir` has overloads keyed on the options shape;
    // pin the encoding to `'utf8'` and cast so the loop body operates on
    // string-encoded Dirent entries (matches the rest of the codebase).
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = (await readdir(dirPath, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as import('node:fs').Dirent<string>[]
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? ((error as NodeJS.ErrnoException).code ?? 'UNKNOWN')
          : 'UNKNOWN'
      warnings.push(`cannot read directory: ${displayPath(dirPath)} (${code})`)
      continue
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isSymbolicLink()) continue
      if (excludePaths.some((ep) => fullPath.startsWith(ep))) continue
      if (entry.isDirectory()) {
        queue.push({ dirPath: fullPath, depth: depth + 1 })
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }

  if (depthLimited) {
    warnings.push(
      `some directories under ${displayPath(baseDir)} were skipped because they exceed the maximum depth (${MAX_SCAN_DEPTH})`
    )
  }

  files.sort()
  return { files, warnings }
}

/**
 * Normalize both {@link RAGServerConfig} shapes into a single
 * `{ baseDirs, baseDir }` pair.
 *
 * Exactly one of `baseDir` / `baseDirs` is supplied (enforced by the
 * discriminated union in `RAGServerConfig`); the runtime check below catches
 * misuse from JS-only callers and degraded-mode bugs.
 *
 * Empty `baseDirs` is accepted ONLY in degraded mode (configError set). In
 * that case the server stays constructible so `status` remains callable, but
 * every root-dependent tool fails fast via `assertConfigOk` before any
 * baseDirs-dependent work. Without configError, an empty array is a misuse:
 * reject up front rather than build a parser that silently rejects every path.
 *
 * `baseDir` is the legacy single-root accessor derived from `baseDirs[0]` —
 * empty-string when in degraded mode with an empty `baseDirs` array. It is
 * never consulted in degraded mode because `assertConfigOk` fires before any
 * handler reaches it.
 */
export function normalizeBaseDirs(config: RAGServerConfig): {
  baseDirs: string[]
  baseDir: string
} {
  const normalizedBaseDirs = config.baseDirs !== undefined ? [...config.baseDirs] : [config.baseDir]
  const firstBaseDir = normalizedBaseDirs[0]
  if (firstBaseDir === undefined && config.configError === undefined) {
    throw new Error(
      'RAGServerConfig must provide either `baseDir` or a non-empty `baseDirs` array (empty `baseDirs` is allowed only in degraded mode with `configError` set).'
    )
  }
  return { baseDirs: normalizedBaseDirs, baseDir: firstBaseDir ?? '' }
}
