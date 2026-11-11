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
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
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
  /** Under the database or cache directory, or a file matching an `IGNORE_PATHS` pattern. */
  | 'excluded'
  /** A regular file whose extension is not a supported document type. */
  | 'unsupported'
  /** Neither a regular file nor a directory (socket, FIFO, device, …). */
  | 'irregular'

/** What a path is, once the collect predicates have judged it. */
export type ScanEntryKind = 'file' | 'directory' | ScanRejection

/** What the collect predicates refuse as `'excluded'`. */
export interface ScanExclusion {
  /** Database and cache directories, each with a trailing separator. */
  prefixes: readonly string[]
  ignore?: {
    /** Configured roots in both spellings, which `patterns` are relative to. */
    roots: readonly string[]
    patterns: readonly string[]
  }
}

export function buildScanExclusion(input: {
  dbPath: string
  cacheDir: string
  roots: { baseDirs: readonly string[]; rawBaseDirs: readonly string[] }
  ignorePatterns: readonly string[] | undefined
}): ScanExclusion {
  return {
    prefixes: [`${resolve(input.dbPath)}${sep}`, `${resolve(input.cacheDir)}${sep}`],
    // Realpath spellings too: a walk may start from a realpath'd target (macOS
    // cwd), which the resolve()-spelled roots would not lexically contain.
    ignore: {
      roots: [...input.roots.rawBaseDirs, ...input.roots.baseDirs],
      patterns: input.ignorePatterns ?? [],
    },
  }
}

const SUBTREE_SUFFIX = '/**'

function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split('/')
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'))
}

/**
 * True when a pattern matches `filePath` relative to the root containing it,
 * spelled with `/` on every OS.
 *
 * `matchesGlob` never lets `*` or `**` match a name starting with `.`, so a
 * pattern ending in `/**` is also tested against the file's ancestor directories.
 */
function matchesIgnorePattern(filePath: string, ignore: ScanExclusion['ignore']): boolean {
  if (ignore === undefined || ignore.patterns.length === 0) {
    return false
  }
  const root = ignore.roots.find((candidate) => isUnderOrEqual(filePath, candidate))
  if (root === undefined) {
    return false
  }
  const relativePath = relative(root, filePath).split(sep).join('/')
  const ancestors = ancestorDirectories(relativePath)
  return ignore.patterns.some(
    (pattern) =>
      posix.matchesGlob(relativePath, pattern) ||
      (pattern.endsWith(SUBTREE_SUFFIX) &&
        ancestors.some((directory) =>
          posix.matchesGlob(directory, pattern.slice(0, -SUBTREE_SUFFIX.length))
        ))
  )
}

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
 * link even under an excluded prefix, a directory needs no extension test, and
 * ignore patterns apply to supported files only.
 *
 * `platform` is a parameter so the Windows exclusion semantics are provable on
 * a POSIX host. Both `Dirent` and `Stats` satisfy {@link EntryTypeFacts}.
 */
export function classifyScanEntry(
  fullPath: string,
  entry: EntryTypeFacts,
  exclusion: ScanExclusion,
  platform: NodeJS.Platform = process.platform
): ScanEntryKind {
  if (entry.isSymbolicLink()) {
    return 'symlink'
  }
  if (isUnderExcludedPrefix(fullPath, exclusion.prefixes, platform)) {
    return 'excluded'
  }
  if (entry.isDirectory()) {
    return 'directory'
  }
  if (!entry.isFile()) {
    return 'irregular'
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    return 'unsupported'
  }
  return matchesIgnorePattern(fullPath, exclusion.ignore) ? 'excluded' : 'file'
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
  exclusion: ScanExclusion,
  platform: NodeJS.Platform = process.platform
): Promise<ScanEntryKind | 'missing'> {
  try {
    return classifyScanEntry(path, await lstat(path), exclusion, platform)
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
  exclusion: ScanExclusion
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
    const kind = classifyScanEntry(fullPath, entry, rules.exclusion, rules.platform)
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
  exclusion: ScanExclusion,
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
      { exclusion, scope, platform },
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
