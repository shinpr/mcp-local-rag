// Shared bounded directory scan for supported document files.
//
// The single bounded directory walker behind the CLI `ingest` walker, the CLI
// `list` walker, and the MCP server's `list_files` scan: bounded depth, symlink
// skipping, exclude-path filtering, and supported-extension matching.
//
// The four collect predicates live in `classifyScanEntry` so a path a caller
// names explicitly (`classifyRequestedPath`) is judged by the same rules as a
// path the walk discovers — sync accepts both, and only one of them used to be
// filtered.
//
// Presentation (warning wording, when/where warnings are surfaced) and
// post-processing (sort/dedup) stay with each caller — this helper returns
// structured coverage facts (`unreadableDirs`, `depthLimitedDirs`,
// `skippedSymlinks`, and the derived `depthLimited`) so callers preserve their
// own, intentionally-different, user-facing messages. The path-granular facts
// let a caller tell an unobserved region apart from an observed one instead of
// treating any gap as a whole-scan failure.

import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from './limits.js'
import { isInScope, shouldVisitDir } from './scope-match.js'

/**
 * Canonical identity key for the `list`/`list_files` cross-reference: a file's
 * realpath, falling back to the input path when realpath fails (orphaned or
 * raw-data entries). Matching ingested DB entries against scanned files by this
 * key recognizes the same physical file across symlinked spellings (prefix or
 * alias). Storage, lookup, and display still use the normal resolve() path —
 * realpath here is the file-identity comparison, not a user-facing value.
 */
export async function realpathForMatch(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch {
    return filePath
  }
}

/**
 * Canonical form of one explicitly requested path: its parent chain resolved
 * through symbolic links, with the final component appended verbatim. `null` when
 * the parent chain cannot be resolved at all — absent, or a directory this
 * process may not traverse — which a caller must treat as "not contained",
 * because telling those cases apart would report the state of paths outside its
 * configured roots.
 *
 * Only the parent chain is resolved, because the requested entry itself is judged
 * by {@link classifyRequestedPath}'s `lstat`: a symbolic link named directly
 * inside a root is an in-root entry that is refused as a link, not a path to be
 * reported by whatever it points at.
 *
 * `realpath` here is the containment (security) boundary, the same role it plays
 * in `DocumentParser.validateFilePath` — never a spelling anything is stored,
 * looked up, or displayed under. Those stay `resolve()`-only.
 */
export async function canonicalizeRequestedPath(path: string): Promise<string | null> {
  try {
    return join(await realpath(dirname(path)), basename(path))
  } catch {
    return null
  }
}

/** Why the collect predicates below refuse a path. */
export type ScanRejection =
  /** A symbolic link, which is never followed. */
  | 'symlink'
  /** Under a configured excluded prefix (the database or cache directory). */
  | 'excluded'
  /** A regular file whose extension is not a supported document type. */
  | 'unsupported'
  /** Neither a regular file nor a directory (socket, FIFO, device, …). */
  | 'irregular'

/** What a path is, once the collect predicates have judged it. */
export type ScanEntryKind = 'file' | 'directory' | ScanRejection

/** The `Dirent` / `Stats` subset the collect predicates read. */
interface EntryTypeFacts {
  isSymbolicLink(): boolean
  isDirectory(): boolean
  isFile(): boolean
}

/**
 * The collect predicates of {@link bfsCollectSupportedFiles} as one decision, so
 * a discovered directory entry and an explicitly requested path
 * ({@link classifyRequestedPath}) are judged by exactly the same rules instead of
 * by two implementations that can drift.
 *
 * Evaluation order is part of the contract and matches the walk: a symbolic link
 * is reported as a link even under an excluded prefix, and a directory is
 * accepted without any extension test.
 *
 * Both `Dirent` (from `readdir`) and `Stats` (from `lstat`) satisfy
 * {@link EntryTypeFacts} structurally.
 */
export function classifyScanEntry(
  fullPath: string,
  entry: EntryTypeFacts,
  excludePaths: readonly string[]
): ScanEntryKind {
  if (entry.isSymbolicLink()) return 'symlink'
  if (excludePaths.some((ep) => fullPath.startsWith(ep))) return 'excluded'
  if (entry.isDirectory()) return 'directory'
  if (!entry.isFile()) return 'irregular'
  return SUPPORTED_EXTENSIONS.has(extname(fullPath).toLowerCase()) ? 'file' : 'unsupported'
}

/**
 * Classify one explicitly requested path with {@link classifyScanEntry}, so a
 * path a caller names is subject to the same predicates as a path the walker
 * discovers.
 *
 * `lstat` rather than `stat`, so a symbolic link is reported as a link instead of
 * as whatever it points at; and `lstat` rather than any read, so a caller can
 * refuse the path before its bytes cost anything — reading a FIFO blocks forever,
 * and reading through a link reaches outside the configured roots.
 *
 * Any stat failure is `'missing'`: an unreachable path and an absent one are the
 * same non-answer to "what is here".
 */
export async function classifyRequestedPath(
  path: string,
  excludePaths: readonly string[]
): Promise<ScanEntryKind | 'missing'> {
  try {
    return classifyScanEntry(path, await lstat(path), excludePaths)
  } catch {
    return 'missing'
  }
}

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
  /**
   * Each entry is the first unvisited directory of a branch pruned for
   * exceeding `maxDepth` — the directory that was reached but never read. That
   * path and every descendant of it is unobserved by this scan; its ancestors
   * and fully visited siblings are not listed.
   */
  depthLimitedDirs: string[]
  /** Full paths of directory entries skipped because they are symbolic links. */
  skippedSymlinks: string[]
  /** True if any branch was pruned for exceeding `maxDepth`. */
  depthLimited: boolean
}

/**
 * Bounded BFS scan of a single root, collecting every supported file up to
 * `maxDepth` levels deep, counted from `rootPath` itself. Symlinks are skipped
 * (never followed) and recorded in `skippedSymlinks`; paths under any
 * `excludePaths` prefix are filtered out. A per-directory `readdir` failure is
 * captured into `unreadableDirs` and does not abort the scan (best-effort per
 * directory); a branch pruned at `maxDepth` is captured into `depthLimitedDirs`.
 *
 * When `scope` is provided (non-empty), the predicate is pushed into the
 * traversal: a directory is visited only if it is in-scope or an ancestor of
 * some scope prefix, and a file is collected only if it is in-scope. A root that
 * intersects no prefix is skipped without any `readdir`. An absent/empty `scope`
 * leaves traversal and collection byte-for-byte unchanged.
 *
 * Does not sort, dedupe, or emit warnings — callers handle those so their
 * existing output contracts are preserved.
 */
export async function bfsCollectSupportedFiles(
  rootPath: string,
  excludePaths: readonly string[],
  maxDepth: number = MAX_SCAN_DEPTH,
  scope?: string[]
): Promise<DirScanResult> {
  const files: string[] = []
  const unreadableDirs: UnreadableDir[] = []
  const depthLimitedDirs: string[] = []
  const skippedSymlinks: string[] = []

  // Scope pushdown (shared with scanBaseDir via scope-match): visit a directory
  // only if it is in-scope or an ancestor of the scoped subtree, and collect a
  // file only if it is in-scope. A root intersecting no prefix is skipped
  // without any `readdir`; absent scope leaves traversal/collection unchanged.
  const queue: { dirPath: string; depth: number }[] = shouldVisitDir(rootPath, scope)
    ? [{ dirPath: rootPath, depth: 0 }]
    : []

  while (queue.length > 0) {
    const { dirPath, depth } = queue.shift()!

    if (depth >= maxDepth) {
      // `dirPath` was reached but never read, so it is the first unvisited
      // directory of this branch: it and all its descendants are unobserved.
      depthLimitedDirs.push(dirPath)
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
      const kind = classifyScanEntry(fullPath, entry, excludePaths)
      if (kind === 'symlink') {
        skippedSymlinks.push(fullPath)
      } else if (kind === 'directory') {
        if (shouldVisitDir(fullPath, scope)) {
          queue.push({ dirPath: fullPath, depth: depth + 1 })
        }
      } else if (kind === 'file' && isInScope(fullPath, scope)) {
        files.push(fullPath)
      }
    }
  }

  return {
    files,
    unreadableDirs,
    depthLimitedDirs,
    skippedSymlinks,
    depthLimited: depthLimitedDirs.length > 0,
  }
}
