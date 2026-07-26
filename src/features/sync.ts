// Dispatch-agnostic incremental-sync planning and execution.
//
// The single core shared by the `sync` CLI subcommand and the MCP `sync_start`
// tool. Every collaborator is declared here as a local structural interface, so
// this module imports nothing from `vectordb/`, `parser/`, `chunker/`,
// `embedder/`, or `ingest/` — not even for types. Persistence, output
// formatting, exit codes, and logging belong to the adapters.
//
// Path identity: reconciliation compares generated keys
// (`toSyncPathKey(path, platform)`), and every containment question is answered
// by the unchanged `isUnderOrEqual` from `scope-match.ts`. This module defines
// no exact-or-descendant, separator-boundary, or trailing-separator logic of its
// own. Deletion, by contrast, always uses the verbatim stored `filePath`
// spellings, because those are what the storage predicate matches.
//
// `platform` is an explicit input rather than a host-platform read, so the
// Windows key semantics are provable from a POSIX host.

import { isManagedRawDataPath } from '../utils/raw-data-utils.js'
import { isUnderOrEqual } from '../utils/scope-match.js'
import { toSyncPathKey } from '../utils/sync-path-key.js'

// ============================================
// Data contracts
// ============================================

/** Path-granular facts about the regions a scan could not observe. */
export interface SyncCoverage {
  unreadableDirs: { dirPath: string; code: string }[]
  depthLimitedDirs: string[]
  skippedSymlinks: string[]
}

/** One bounded directory scan: the supported files found plus its coverage facts. */
export interface SyncScanResult extends SyncCoverage {
  files: string[]
}

/**
 * One stored chunk row (or row group) of the database manifest. `filePath` is
 * the verbatim stored spelling — the only value valid for deletion. A `null` or
 * absent `contentHash` marks the row hashless, which makes its file dirty.
 */
export interface SyncManifestRow {
  filePath: string
  contentHash?: string | null
}

/** One supported file found on disk, with the hash of its current bytes. */
export interface SyncDiskFile {
  filePath: string
  contentHash: string
}

/** How a sync invocation was addressed, after validation and classification. */
export type SyncRequest =
  | { kind: 'roots' }
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string }

/** Result of classifying a requested path on disk. */
export type SyncPathKind = 'directory' | 'file' | 'missing'

/** Re-ingest one disk file, then drop the other stored spellings of its key. */
export interface SyncUpsertAction {
  /** Verbatim disk path handed to `ingestFile`. */
  filePath: string
  /** Verbatim stored spellings of the same comparison key, excluding `filePath`. */
  staleStoredPaths: string[]
}

/** Remove every stored spelling of one comparison key that left the disk. */
export interface SyncPruneAction {
  storedPaths: string[]
}

export interface SyncPlan {
  upserts: SyncUpsertAction[]
  /** Files whose stored content identity already matches the disk bytes. */
  skipped: number
  prunes: SyncPruneAction[]
}

export interface SyncPlanInput {
  roots: readonly string[]
  dbPath: string
  /** Configured database/cache prefixes that must never be pruned. */
  excludePaths: readonly string[]
  platform: NodeJS.Platform
  request: SyncRequest
  diskFiles: readonly SyncDiskFile[]
  dbRows: readonly SyncManifestRow[]
  coverage: SyncCoverage
}

/** The one controlled error a failed run exposes. */
export interface SyncError {
  message: string
  /** The file, root, or requested path a failure is attributable to. */
  filePath: string | null
}

export interface SyncCounters {
  upserted: number
  skipped: number
  empty: number
  /** Comparison keys removed from the index. Counts files, not rows, and is not part of `completed`. */
  pruned: number
}

export interface SyncExecutionResult extends SyncCounters {
  error: SyncError | null
}

export interface SyncResult extends SyncCounters {
  /** Scanner facts as data. Formatting and reporting belong to the adapters. */
  coverage: SyncCoverage
  error: SyncError | null
}

/** Mutating collaborators, injected by the CLI and MCP adapters. */
export interface SyncExecutor {
  /**
   * Parse, chunk, embed, build vectors, then delete-and-insert for this one
   * file, returning the inserted chunk count. Returning `0` must leave the
   * store untouched: the executor relies on that to keep a zero-chunk file's
   * prior rows and hash intact.
   */
  ingestFile(filePath: string): Promise<number>
  /** Delete the rows of exactly one stored path spelling. */
  deleteExactPath(filePath: string): Promise<number>
  optimize(): Promise<void>
}

/** Everything {@link runSync} needs from the outside world. */
export interface SyncCollaborators extends SyncExecutor {
  classifyPath(path: string): Promise<SyncPathKind>
  /**
   * Bounded scan of one root. Deliberately takes no scope predicate: a
   * scope-pruned directory is reported in none of the coverage arrays, so a
   * scope filter here would make unobserved regions invisible and prune unsafe.
   */
  scanDir(rootPath: string): Promise<SyncScanResult>
  hashFile(filePath: string): Promise<string>
  /** Every stored chunk row's verbatim path and hash, for the whole table. */
  loadDbManifest(): Promise<SyncManifestRow[]>
}

export interface RunSyncInput {
  roots: readonly string[]
  dbPath: string
  excludePaths: readonly string[]
  platform: NodeJS.Platform
  /** Omitted means "every configured root". */
  requestedPath?: string | undefined
  collaborators: SyncCollaborators
}

// ============================================
// Planning (execution order steps 1 and 4)
// ============================================

interface StoredGroup {
  /** Verbatim stored spellings of this key, deduped, in manifest order. */
  paths: string[]
  hashes: (string | null)[]
}

/**
 * A comparison key is converged only when it is stored under exactly one
 * spelling and every one of that spelling's rows carries the current disk hash.
 * No rows, a hashless row, disagreeing rows, or a stale hash all make it dirty.
 *
 * The single-spelling condition matters because deletion is by exact path: on
 * Windows, ingesting `C:\Docs\A.md` and later `c:\docs\a.md` leaves two row sets
 * for one file, both with the correct hash. Without this condition sync would
 * skip the key forever and searches would keep returning duplicate hits; with
 * it, the key is re-ingested and the other spellings become stale deletions, so
 * one run converges it back to a single spelling.
 */
function isConverged(stored: StoredGroup, diskHash: string): boolean {
  return stored.paths.length === 1 && stored.hashes.every((hash) => hash === diskHash)
}

/**
 * Decide the skip, upsert, and prune actions for one sync run. Pure: all
 * filesystem and database facts arrive pre-fetched.
 *
 * A prune action is emitted only when all four conditions hold for the key: it
 * is inside the requested scope, absent from the disk manifest, outside the
 * configured excluded and managed paths, and outside every unobserved scan
 * prefix. Dropping any one of them protects the rows.
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const keyOf = (path: string): string => toSyncPathKey(path, input.platform)
  const isKeyUnder = (key: string, prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) => isUnderOrEqual(key, keyOf(prefix)))

  const scopePrefixes =
    input.request.kind === 'roots' ? input.roots : ([input.request.path] as const)

  const diskByKey = new Map<string, SyncDiskFile>()
  for (const file of input.diskFiles) {
    const fileKey = keyOf(file.filePath)
    if (!diskByKey.has(fileKey)) diskByKey.set(fileKey, file)
  }

  const storedByKey = new Map<string, StoredGroup>()
  for (const row of input.dbRows) {
    const rowKey = keyOf(row.filePath)
    let group = storedByKey.get(rowKey)
    if (!group) {
      group = { paths: [], hashes: [] }
      storedByKey.set(rowKey, group)
    }
    if (!group.paths.includes(row.filePath)) group.paths.push(row.filePath)
    group.hashes.push(row.contentHash ?? null)
  }

  const upserts: SyncUpsertAction[] = []
  let skipped = 0
  for (const [fileKey, file] of diskByKey) {
    const group = storedByKey.get(fileKey)
    if (group && isConverged(group, file.contentHash)) {
      skipped += 1
      continue
    }
    upserts.push({
      filePath: file.filePath,
      // `ingestFile` replaces its own spelling; any other spelling of the same
      // key would otherwise survive as a duplicate of the same file.
      staleStoredPaths: (group?.paths ?? []).filter((path) => path !== file.filePath),
    })
  }

  const unobservedPrefixes = [
    ...input.coverage.unreadableDirs.map((dir) => dir.dirPath),
    ...input.coverage.depthLimitedDirs,
    ...input.coverage.skippedSymlinks,
  ]

  const prunes: SyncPruneAction[] = []
  for (const [rowKey, group] of storedByKey) {
    if (diskByKey.has(rowKey)) continue
    if (!isKeyUnder(rowKey, scopePrefixes)) continue
    if (isKeyUnder(rowKey, unobservedPrefixes)) continue
    if (isKeyUnder(rowKey, input.excludePaths)) continue
    if (group.paths.some((path) => isManagedRawDataPath(path, input.dbPath))) continue
    prunes.push({ storedPaths: group.paths })
  }

  return { upserts, skipped, prunes }
}

// ============================================
// Execution (steps 5-10)
// ============================================

function toMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

/**
 * Apply a plan: upserts first, then prune, then a single `optimize()`.
 *
 * The first failure anywhere stops the run. Earlier successful mutations stay,
 * every remaining upsert and the entire prune phase are abandoned, and exactly
 * one error is returned. No rollback, retry, or failure classification is
 * attempted — an interrupted run is recovered by rerunning sync.
 *
 * A zero-chunk ingest counts as `empty` and mutates nothing for that file, so
 * its prior rows stay searchable and the next run plans it again.
 */
export async function executeSyncPlan(
  plan: SyncPlan,
  executor: SyncExecutor
): Promise<SyncExecutionResult> {
  let upserted = 0
  let empty = 0
  let pruned = 0
  let mutated = false
  let error: SyncError | null = null

  for (const action of plan.upserts) {
    try {
      const chunkCount = await executor.ingestFile(action.filePath)
      if (chunkCount === 0) {
        empty += 1
        continue
      }
      upserted += 1
      mutated = true
      // After the insert, not before: a zero-chunk result must leave every
      // stored spelling of this key untouched.
      for (const stalePath of action.staleStoredPaths) {
        await executor.deleteExactPath(stalePath)
      }
    } catch (caught) {
      error = { message: toMessage(caught), filePath: action.filePath }
      break
    }
  }

  if (error === null) {
    for (const action of plan.prunes) {
      try {
        for (const storedPath of action.storedPaths) {
          await executor.deleteExactPath(storedPath)
          mutated = true
        }
        pruned += 1
      } catch (caught) {
        error = { message: toMessage(caught), filePath: action.storedPaths[0] ?? null }
        break
      }
    }
  }

  if (error === null && mutated) {
    try {
      await executor.optimize()
    } catch (caught) {
      error = { message: toMessage(caught), filePath: null }
    }
  }

  return { upserted, skipped: plan.skipped, empty, pruned, error }
}

// ============================================
// Composition (steps 1-3, then plan, then execute)
// ============================================

type GatherOutcome =
  | {
      ok: true
      coverage: SyncCoverage
      request: SyncRequest
      diskFiles: SyncDiskFile[]
      dbRows: SyncManifestRow[]
    }
  | { ok: false; coverage: SyncCoverage; error: SyncError }

/**
 * Steps 1-3: validate and classify the requested path, scan the roots it
 * implies, hash the supported disk files, and load the database manifest.
 *
 * `attributedPath` tracks what a thrown error should be blamed on, so an
 * orchestration failure still names the file, root, or requested path involved.
 */
async function gatherSyncInputs(input: RunSyncInput): Promise<GatherOutcome> {
  const { collaborators, platform } = input
  const coverage: SyncCoverage = {
    unreadableDirs: [],
    depthLimitedDirs: [],
    skippedSymlinks: [],
  }
  let attributedPath: string | null = null

  try {
    const requestedPath = input.requestedPath
    let request: SyncRequest
    let scanRoots: readonly string[]

    if (requestedPath === undefined) {
      request = { kind: 'roots' }
      scanRoots = input.roots
    } else {
      attributedPath = requestedPath
      const requestedKey = toSyncPathKey(requestedPath, platform)
      const insideConfiguredRoot = input.roots.some((root) =>
        isUnderOrEqual(requestedKey, toSyncPathKey(root, platform))
      )
      if (!insideConfiguredRoot) {
        throw new Error(`Sync path is outside every configured root: ${requestedPath}`)
      }
      const kind = await collaborators.classifyPath(requestedPath)
      if (kind === 'missing') {
        throw new Error(`Sync path does not exist: ${requestedPath}`)
      }
      request = { kind, path: requestedPath }
      // An explicit directory becomes its own depth-zero BFS root; an explicit
      // file needs no directory walk and no depth evaluation at all.
      scanRoots = kind === 'directory' ? [requestedPath] : []
    }

    const scannedFiles: string[] = []
    for (const root of scanRoots) {
      attributedPath = root
      const scan = await collaborators.scanDir(root)
      scannedFiles.push(...scan.files)
      coverage.unreadableDirs.push(...scan.unreadableDirs)
      coverage.depthLimitedDirs.push(...scan.depthLimitedDirs)
      coverage.skippedSymlinks.push(...scan.skippedSymlinks)
    }
    if (request.kind === 'file') {
      scannedFiles.push(request.path)
    }

    // Overlapping roots can surface the same file twice; hash each comparison
    // key once, keeping the first spelling encountered.
    const diskByKey = new Map<string, string>()
    for (const filePath of scannedFiles) {
      const fileKey = toSyncPathKey(filePath, platform)
      if (!diskByKey.has(fileKey)) diskByKey.set(fileKey, filePath)
    }

    const diskFiles: SyncDiskFile[] = []
    for (const filePath of diskByKey.values()) {
      attributedPath = filePath
      diskFiles.push({ filePath, contentHash: await collaborators.hashFile(filePath) })
    }

    attributedPath = null
    const dbRows = await collaborators.loadDbManifest()

    return { ok: true, coverage, request, diskFiles, dbRows }
  } catch (caught) {
    return {
      ok: false,
      coverage,
      error: { message: toMessage(caught), filePath: attributedPath },
    }
  }
}

/**
 * Run one full sync: gather, plan, execute.
 *
 * Returned counters and coverage facts are plain data; the caller decides how to
 * print them and what exit status or job state they imply. A run with nothing to
 * do calls neither `ingestFile` nor `optimize`, so a true no-op never pays for
 * loading the embedding model or compacting the table.
 */
export async function runSync(input: RunSyncInput): Promise<SyncResult> {
  const gathered = await gatherSyncInputs(input)
  if (!gathered.ok) {
    return {
      upserted: 0,
      skipped: 0,
      empty: 0,
      pruned: 0,
      coverage: gathered.coverage,
      error: gathered.error,
    }
  }

  const plan = planSync({
    roots: input.roots,
    dbPath: input.dbPath,
    excludePaths: input.excludePaths,
    platform: input.platform,
    request: gathered.request,
    diskFiles: gathered.diskFiles,
    dbRows: gathered.dbRows,
    coverage: gathered.coverage,
  })

  const execution = await executeSyncPlan(plan, input.collaborators)
  return { ...execution, coverage: gathered.coverage }
}
