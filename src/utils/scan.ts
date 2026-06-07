// Shared bounded directory scan for supported document files.
//
// Extracts the BFS traversal mechanism duplicated by the CLI `ingest` walker,
// the CLI `list` walker, and the MCP server's `list_files` scan: bounded depth,
// symlink skipping, exclude-path filtering, and supported-extension matching.
//
// Presentation (warning wording, when/where warnings are surfaced) and
// post-processing (sort/dedup) stay with each caller — this helper returns
// structured facts (`unreadableDirs`, `depthLimited`) so callers preserve
// their own, intentionally-different, user-facing messages.

import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from './limits.js'

/** A directory that could not be read during the scan. */
export interface UnreadableDir {
  dirPath: string
  /** Node error `code` (e.g. `EACCES`), or `'UNKNOWN'` when unavailable. */
  code: string
}

/** Structured result of a bounded directory scan. */
export interface DirScanResult {
  /** Supported files found under the root, in BFS-discovery order (unsorted). */
  files: string[]
  /** Directories skipped because `readdir` failed (caller decides how to warn). */
  unreadableDirs: UnreadableDir[]
  /** True if any branch was pruned for exceeding `maxDepth`. */
  depthLimited: boolean
}

/**
 * Bounded BFS scan of a single root, collecting every supported file up to
 * `maxDepth` levels deep. Symlinks are skipped; paths under any `excludePaths`
 * prefix are filtered out. A per-directory `readdir` failure is captured into
 * `unreadableDirs` and does not abort the scan (best-effort per directory).
 *
 * Does not sort, dedupe, or emit warnings — callers handle those so their
 * existing output contracts are preserved.
 */
export async function bfsCollectSupportedFiles(
  rootPath: string,
  excludePaths: readonly string[],
  maxDepth: number = MAX_SCAN_DEPTH
): Promise<DirScanResult> {
  const files: string[] = []
  const unreadableDirs: UnreadableDir[] = []
  let depthLimited = false

  const queue: { dirPath: string; depth: number }[] = [{ dirPath: rootPath, depth: 0 }]

  while (queue.length > 0) {
    const { dirPath, depth } = queue.shift()!

    if (depth >= maxDepth) {
      depthLimited = true
      continue
    }

    // TypeScript's `readdir` has overloads keyed on the options shape; pin the
    // encoding to `'utf8'` and cast so the loop operates on string-encoded
    // Dirent entries (matches the rest of the codebase).
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
      unreadableDirs.push({ dirPath, code })
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

  return { files, unreadableDirs, depthLimited }
}
