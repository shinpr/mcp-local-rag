// Shared bounded directory scan for supported document files: the single
// walker behind CLI `ingest`, CLI `list`, and the MCP `list_files` scan.
//
// The collect predicates live in `classifyScanEntry` so a path a caller names
// explicitly (`classifyRequestedPath`) is judged by the same rules as one the
// walk discovers — sync accepts both, and only one used to be filtered.
//
// Warning wording and sort/dedupe stay with each caller. This helper returns
// path-granular coverage facts instead, so a caller can tell an unobserved
// region apart from a whole-scan failure.

import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from './limits.js'
import { isInScope, isUnderOrEqual, shouldVisitDir } from './scope-match.js'
import { errorCode } from './type-guards.js'

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
 * True when `fullPath` sits under one of the configured excluded prefixes (the
 * database or cache directory).
 *
 * Case-folded on Windows, whose filesystem is case-insensitive: the prefixes are
 * built with `resolve()` only, which preserves whatever case `BASE_DIRS` and
 * `DB_PATH` were spelled in, so a raw comparison let `C:\Docs\lancedb\raw.md`
 * past `c:\docs\lancedb\`. That is worse than a plain miss, because sync's prune
 * guard compares case-folded keys (`toSyncPathKey`): the internals were ingested
 * and then could never be pruned. Both sides now agree.
 *
 * Exact-or-descendant via `isUnderOrEqual`: the prefixes carry a trailing
 * separator, so `startsWith` matched the directory's contents but not the
 * directory itself, and the walk descended into it once per run.
 *
 * Purely lexical — no `realpath`, `stat`, or any other syscall, because this runs
 * once per directory entry on the walk shared with `list_files`, CLI `list`, and
 * CLI `ingest`.
 */
function isUnderExcludedPrefix(
  fullPath: string,
  excludePaths: readonly string[],
  platform: NodeJS.Platform
): boolean {
  const fold = (path: string): string => (platform === 'win32' ? path.toLowerCase() : path)
  const candidate = fold(fullPath)
  return excludePaths.some((prefix) => isUnderOrEqual(candidate, fold(prefix)))
}

/**
 * The collect predicates of {@link bfsCollectSupportedFiles} as one decision,
 * so a discovered entry and an explicitly requested path are judged by the same
 * rules rather than by two implementations that drift.
 *
 * Evaluation order is part of the contract: a symbolic link is reported as a
 * link even under an excluded prefix, and a directory needs no extension test.
 *
 * `platform` is a parameter so the Windows exclusion semantics are provable on
 * a POSIX host. Both `Dirent` and `Stats` satisfy {@link EntryTypeFacts}.
 */
export function classifyScanEntry(
  fullPath: string,
  entry: EntryTypeFacts,
  excludePaths: readonly string[],
  platform: NodeJS.Platform = process.platform
): ScanEntryKind {
  if (entry.isSymbolicLink()) {
    return 'symlink'
  }
  if (isUnderExcludedPrefix(fullPath, excludePaths, platform)) {
    return 'excluded'
  }
  if (entry.isDirectory()) {
    return 'directory'
  }
  if (!entry.isFile()) {
    return 'irregular'
  }
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
  excludePaths: readonly string[],
  platform: NodeJS.Platform = process.platform
): Promise<ScanEntryKind | 'missing'> {
  try {
    return classifyScanEntry(path, await lstat(path), excludePaths, platform)
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

/** Directory entries, or the errno that made the directory unreadable. */
async function readDirEntries(
  dirPath: string
): Promise<{ entries: import('node:fs').Dirent<string>[] } | { code: string }> {
  try {
    return { entries: await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' }) }
  } catch (error) {
    return { code: errorCode(error) ?? 'UNKNOWN' }
  }
}

/** How one directory's entries are classified. */
interface ScanRules {
  excludePaths: readonly string[]
  scope: string[] | undefined
  platform: NodeJS.Platform
}

/** Where a classified entry goes. */
interface ScanSinks {
  files: string[]
  skippedSymlinks: string[]
  queue: { dirPath: string; depth: number }[]
}

/**
 * Route one directory's entries: symlinks are recorded and never followed,
 * in-scope directories are enqueued one level deeper, and in-scope supported
 * files are collected.
 */
function sortEntries(
  entries: readonly import('node:fs').Dirent<string>[],
  visit: { dirPath: string; depth: number },
  rules: ScanRules,
  sinks: ScanSinks
): void {
  for (const entry of entries) {
    const fullPath = join(visit.dirPath, entry.name)
    const kind = classifyScanEntry(fullPath, entry, rules.excludePaths, rules.platform)
    if (kind === 'symlink') {
      sinks.skippedSymlinks.push(fullPath)
    } else if (kind === 'directory' && shouldVisitDir(fullPath, rules.scope)) {
      sinks.queue.push({ dirPath: fullPath, depth: visit.depth + 1 })
    } else if (kind === 'file' && isInScope(fullPath, rules.scope)) {
      sinks.files.push(fullPath)
    }
  }
}

export interface BfsCollectOptions {
  /** Traversal bound; defaults to {@link MAX_SCAN_DEPTH}. */
  maxDepth?: number
  /** Absolute prefixes to restrict traversal and collection to. */
  scope?: string[] | undefined
  /** Selects case sensitivity of the exclusion comparison; defaults to the host. */
  platform?: NodeJS.Platform
}

/**
 * Bounded BFS scan of a single root, depth counted from `rootPath` itself.
 * Symlinks are never followed. An unreadable directory is recorded and does
 * not abort the scan.
 *
 * Does not sort, dedupe, or emit warnings — each caller owns its own output
 * contract for those.
 */
export async function bfsCollectSupportedFiles(
  rootPath: string,
  excludePaths: readonly string[],
  options: BfsCollectOptions = {}
): Promise<DirScanResult> {
  const { maxDepth = MAX_SCAN_DEPTH, scope, platform = process.platform } = options
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
    const visit = queue.shift()
    if (visit === undefined) {
      break
    }
    if (visit.depth >= maxDepth) {
      // `dirPath` was reached but never read, so it is the first unvisited
      // directory of this branch: it and all its descendants are unobserved.
      depthLimitedDirs.push(visit.dirPath)
      continue
    }

    const read = await readDirEntries(visit.dirPath)
    if ('code' in read) {
      unreadableDirs.push({ dirPath: visit.dirPath, code: read.code })
      continue
    }

    sortEntries(
      read.entries,
      visit,
      { excludePaths, scope, platform },
      {
        files,
        skippedSymlinks,
        queue,
      }
    )
  }

  return {
    files,
    unreadableDirs,
    depthLimitedDirs,
    skippedSymlinks,
    depthLimited: depthLimitedDirs.length > 0,
  }
}
