// Pure helpers for the RAGServer `list_files` surface and base-dir config
// normalization. Extracted from `RAGServer` so the directory-scan presentation
// and the constructor's config-shape normalization live as standalone,
// behavior-preserving functions independent of instance state. Traversal itself
// belongs to the shared walker in `utils/scan.ts`; only the `list_files`
// wording, sort, and warning selection live here.

import { displayPath } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'
import type { RAGServerConfig } from './types.js'

/**
 * `list_files` presentation adapter over {@link bfsCollectSupportedFiles}:
 * scans one base directory for supported files, excluding system-managed paths
 * (dbPath, cacheDir), and renders the walker's coverage facts as sorted
 * absolute paths plus a list of non-fatal warnings.
 *
 * Behavior contract:
 *  - Depth is bounded by {@link MAX_SCAN_DEPTH}, counted from `baseDir`, so the
 *    same "how deep do we look under a root" boundary applies to every
 *    list/ingest surface.
 *  - A `readdir` failure under one directory becomes a warning rather than
 *    aborting the whole list call. One unreadable root must not hide files
 *    under the other roots, so the policy is best-effort per directory.
 *  - The depth-limit warning names the base directory and is emitted at most
 *    once per call, however many branches were pruned.
 *  - Symlinks are skipped (mirrors the CLI ingest walker); `list_files` does
 *    not surface them.
 *  - When `scope` is provided (non-empty), the predicate is pushed into the
 *    traversal: a directory is visited only if it is in-scope or an ancestor of
 *    some scope prefix, and a file is collected only if it is in-scope. A
 *    baseDir intersecting no prefix is skipped without any `readdir`. An
 *    absent/empty `scope` leaves traversal and collection unchanged.
 */
export async function scanBaseDir(
  baseDir: string,
  excludePaths: readonly string[],
  scope?: string[]
): Promise<{ files: string[]; warnings: string[] }> {
  const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles(
    baseDir,
    excludePaths,
    MAX_SCAN_DEPTH,
    scope
  )

  const warnings: string[] = []
  for (const { dirPath, code } of unreadableDirs) {
    warnings.push(`cannot read directory: ${displayPath(dirPath)} (${code})`)
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
