// Pure helpers for the `list_files` surface and base-dir config normalization,
// kept out of `RAGServer` so neither depends on instance state. Traversal lives
// in `utils/scan.ts`; only the wording, sort and warning selection are here.

import { displayPath } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'
import type { RAGServerConfig } from './types.js'

/**
 * `list_files` presentation over {@link bfsCollectSupportedFiles}: renders the
 * walker's coverage facts as sorted absolute paths plus non-fatal warnings.
 *
 * A `readdir` failure becomes a warning rather than aborting the call — one
 * unreadable root must not hide files under the others. The depth-limit
 * warning names the base directory and is emitted at most once per call,
 * however many branches were pruned. Symlinks are skipped and not surfaced.
 */
export async function scanBaseDir(
  baseDir: string,
  excludePaths: readonly string[],
  scope?: string[]
): Promise<{ files: string[]; warnings: string[] }> {
  const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles(
    baseDir,
    excludePaths,
    {
      maxDepth: MAX_SCAN_DEPTH,
      scope,
    }
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
 * Normalize both {@link RAGServerConfig} shapes into `{ baseDirs, baseDir }`.
 *
 * Empty `baseDirs` is accepted ONLY in degraded mode, where the server must
 * stay constructible so `status` remains callable and `assertConfigOk` fails
 * every root-dependent tool first. Without a configError an empty array is
 * misuse — reject it rather than build a parser that rejects every path.
 *
 * `baseDir` is the legacy accessor, `baseDirs[0]`; empty-string in degraded
 * mode, where nothing reaches it.
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
