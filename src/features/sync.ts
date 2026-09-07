// Dispatch-agnostic incremental-sync planning and execution: the single core
// shared by the `sync` CLI subcommand and the MCP `sync_start` tool. Every
// collaborator is a local structural interface, so this module imports nothing
// from the domain layers, not even for types.
//
// Path identity: reconciliation compares generated keys
// (`toSyncPathKey(path, platform)`) and answers containment with the unchanged
// `isUnderOrEqual`. Deletion instead uses the verbatim stored `filePath`,
// because that is what the storage predicate matches.
//
// Two spellings, one matcher: `toSyncPathKey` stays purely lexical (a key must
// be derivable for a file no longer on disk), while the requested path's
// CONTAINMENT is decided against canonicalized values — see
// `isRequestedPathContained`. Do not collapse the two by making key generation
// follow symbolic links.
//
// `platform` is an explicit input, so Windows key semantics are provable from a
// POSIX host.

import { isManagedRawDataPath } from '../utils/raw-data-utils.js'
import type { ScanEntryKind } from '../utils/scan.js'
import { isUnderOrEqual } from '../utils/scope-match.js'
import { toSyncPathKey } from '../utils/sync-path-key.js'
import { isQualityProfile, type QualityProfile } from '../utils/visual-profile.js'

// ============================================
// Data contracts
// ============================================

/** Path-granular facts about the regions a directory scan could not observe. */
export interface SyncScanCoverage {
  unreadableDirs: { dirPath: string; code: string }[]
  depthLimitedDirs: string[]
  skippedSymlinks: string[]
}

/**
 * Everything one run could not observe: the scan facts plus the files whose
 * bytes were never read because they exceed the configured size limit. Every
 * path here is an unobserved prefix, so the rows under it are protected from
 * prune.
 */
export interface SyncCoverage extends SyncScanCoverage {
  /** Files skipped by `hashFile` for exceeding the configured size limit. */
  oversizedFiles: string[]
}

/** One bounded directory scan: the supported files found plus its coverage facts. */
export interface SyncScanResult extends SyncScanCoverage {
  files: string[]
}

/**
 * One stored chunk row (or row group) of the database manifest. `filePath` is
 * the verbatim stored spelling — the only value valid for deletion. A `null` or
 * absent `contentHash` marks the row hashless, which makes its file dirty.
 * `visualProfile` is the raw stored value, unvalidated: the vocabulary check
 * belongs to the planner, not to the storage projection.
 */
export interface SyncManifestRow {
  filePath: string
  contentHash?: string | null
  visualProfile?: string | null
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

/**
 * Result of classifying a requested path on disk. Anything other than
 * `directory` or `file` is refused before the path is read: the union is the
 * walker's own {@link ScanEntryKind} plus `missing`, so a path a caller names and
 * a path the walk discovers pass the identical predicates.
 */
export type SyncPathKind = ScanEntryKind | 'missing'

/** Re-ingest one disk file, then drop the other stored spellings of its key. */
export interface SyncUpsertAction {
  /** Verbatim disk path handed to `ingestFile`. */
  filePath: string
  /** Verbatim stored spellings of the same comparison key, excluding `filePath`. */
  staleStoredPaths: string[]
  /**
   * The profile this file must be re-ingested with, resolved once here so the
   * CLI and MCP adapters cannot reach different conclusions. `null` means
   * normal text ingestion, and is the only value a non-PDF ever carries.
   */
  visualProfile: QualityProfile | null
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
  /**
   * Explicit per-invocation visual request. Present means every eligible PDF in
   * scope is desired at this profile regardless of what is stored, which is also
   * what repairs conflicting or unreadable stored state. Absent means each PDF
   * inherits its own recorded profile.
   */
  visualProfile?: QualityProfile | undefined
}

/** The one controlled error a failed run exposes. */
export interface SyncError {
  message: string
  /** The file, root, or requested path a failure is attributable to. */
  filePath: string | null
}

/** Append an attributable path only when the underlying message does not already contain it. */
export function formatSyncError({ message, filePath }: SyncError): string {
  return filePath === null || message.includes(filePath) ? message : `${message} (${filePath})`
}

export interface SyncCounters {
  upserted: number
  skipped: number
  empty: number
  /** Comparison keys removed from the index. Counts files, not rows, and is not part of `completed`. */
  pruned: number
}

/** One stored spelling per pruned comparison key, so a count of N reports N paths. */
interface PrunedPaths {
  prunedPaths: string[]
}

export interface SyncExecutionResult extends SyncCounters, PrunedPaths {
  error: SyncError | null
}

export interface SyncResult extends SyncCounters, PrunedPaths {
  /** Scanner facts as data. Formatting and reporting belong to the adapters. */
  coverage: SyncCoverage
  error: SyncError | null
}

/** How one planned file must be ingested: run-level images, per-file profile. */
export interface SyncIngestOptions {
  /** `true` stores images for this file, from the current invocation alone. */
  images: boolean
  /** The planner's resolved profile; `null` means normal text ingestion. */
  visualProfile: QualityProfile | null
}

/** Mutating collaborators, injected by the CLI and MCP adapters. */
export interface SyncExecutor {
  /**
   * Parse, chunk, embed, build vectors, then delete-and-insert for this one
   * file, returning the inserted chunk count. Returning `0` must leave the
   * store untouched: the executor relies on that to keep a zero-chunk file's
   * prior rows and hash intact.
   */
  ingestFile(filePath: string, options: SyncIngestOptions): Promise<number>
  /** Delete the rows of exactly one stored path spelling. */
  deleteExactPath(filePath: string): Promise<number>
  optimize(): Promise<void>
}

/** Everything {@link runSync} needs from the outside world. */
export interface SyncCollaborators extends SyncExecutor {
  /**
   * Canonical form of the requested path — its parent chain resolved through
   * symbolic links, the final component verbatim — or `null` when that chain
   * cannot be resolved. Injected because this module performs no filesystem
   * access; both adapters supply `canonicalizeRequestedPath` from `utils/scan.ts`.
   */
  canonicalizeRequestedPath(path: string): Promise<string | null>
  /**
   * Classify the requested path WITHOUT reading it, applying the walker's collect
   * predicates (`classifyRequestedPath` in `utils/scan.ts`) so both surfaces
   * refuse the same paths.
   */
  classifyPath(path: string): Promise<SyncPathKind>
  /**
   * Bounded scan of one root. Deliberately takes no scope predicate: a
   * scope-pruned directory is reported in none of the coverage arrays, so a
   * scope filter here would make unobserved regions invisible and prune unsafe.
   */
  scanDir(rootPath: string): Promise<SyncScanResult>
  /**
   * Hash the file's current bytes, or return `null` to decline reading it because
   * it exceeds the configured size limit. A declined file is left out of the disk
   * manifest and recorded in `coverage.oversizedFiles`, which protects its stored
   * rows from prune — omitting it without that record would make it look deleted.
   */
  hashFile(filePath: string): Promise<string | null>
  /** Every stored chunk row's verbatim path and hash, for the whole table. */
  loadDbManifest(): Promise<SyncManifestRow[]>
}

export interface RunSyncInput {
  /** Configured roots in the `resolve()`-only spelling the DB keys live in. */
  roots: readonly string[]
  /**
   * The same configured roots, canonicalized (realpath'd) — the security domain
   * the requested path's canonical form is checked against. Both adapters already
   * hold this list: the MCP server as `baseDirs`, the CLI as
   * `config.baseDirs.baseDirs`, each the counterpart of its `roots` entry.
   */
  canonicalRoots: readonly string[]
  dbPath: string
  excludePaths: readonly string[]
  platform: NodeJS.Platform
  /** Omitted means "every configured root". */
  requestedPath?: string | undefined
  /** `true` stores images for files already selected as new or changed. */
  images?: boolean | undefined
  /**
   * Explicit visual request for every eligible PDF in scope. Only the CLI
   * supplies it; path-only MCP sync omits it so each PDF inherits its recorded
   * profile.
   */
  visualProfile?: QualityProfile | undefined
  collaborators: SyncCollaborators
}

// ============================================
// Planning (execution order steps 1 and 4)
// ============================================

interface StoredGroup {
  /** Verbatim stored spellings of this key, deduped, in manifest order. */
  paths: string[]
  hashes: (string | null)[]
  /** Raw stored profiles, one per row, with absence already normalized to `null`. */
  profiles: (string | null)[]
}

/** Only a PDF carries visual intent; every other type ignores stored profiles. */
function isEligiblePdf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf')
}

/**
 * The desired profile for one eligible PDF, and the only place a stored profile
 * is interpreted.
 *
 * An explicit override wins outright, which is what lets one CLI run repair
 * stored state this function would otherwise refuse to read: with a preference
 * supplied, nothing has to be inferred from the rows.
 *
 * Without an override the rows must speak with one voice. Multiple known
 * profiles, or a nonempty value outside the vocabulary, leave no defensible
 * choice, so planning fails before anything is mutated rather than silently
 * converging the file onto a guess.
 */
function resolveDesiredProfile(
  filePath: string,
  stored: StoredGroup | undefined,
  override: QualityProfile | undefined
): QualityProfile | null {
  if (override !== undefined) {
    return override
  }
  const known = new Set<QualityProfile>()
  for (const profile of stored?.profiles ?? []) {
    if (profile === null) {
      continue
    }
    if (!isQualityProfile(profile)) {
      throw new Error(
        `Sync cannot infer the visual mode of ${filePath}: it stores an unsupported visual profile "${profile}". Re-run sync with --visual (optionally --visual-quality quality) to set one explicitly, or re-ingest the file.`
      )
    }
    known.add(profile)
  }
  if (known.size > 1) {
    throw new Error(
      `Sync cannot infer the visual mode of ${filePath}: its indexed rows disagree (${[...known].sort().join(', ')}). Re-run sync with --visual (optionally --visual-quality quality) to set one explicitly, or re-ingest the file.`
    )
  }
  return known.values().next().value ?? null
}

/**
 * A comparison key is converged only when it is stored under exactly one
 * spelling, every one of that spelling's rows carries the current disk hash,
 * and — for a PDF — every row already records the desired profile. No rows, a
 * hashless row, disagreeing rows, a stale hash, or a profile mismatch all make
 * it dirty.
 *
 * The single-spelling condition matters because deletion is by exact path: on
 * Windows, ingesting `C:\Docs\A.md` and later `c:\docs\a.md` leaves two row sets
 * for one file, both with the correct hash. Without this condition sync would
 * skip the key forever and searches would keep returning duplicate hits; with
 * it, the key is re-ingested and the other spellings become stale deletions, so
 * one run converges it back to a single spelling.
 */
function isConverged(
  stored: StoredGroup,
  diskHash: string,
  desiredProfile: QualityProfile | null,
  comparesProfile: boolean
): boolean {
  if (stored.paths.length !== 1 || !stored.hashes.every((hash) => hash === diskHash)) {
    return false
  }
  return !comparesProfile || stored.profiles.every((profile) => profile === desiredProfile)
}

/**
 * Decide the skip, upsert, and prune actions for one sync run.
 *
 * A key is pruned only when every one of four conditions holds: inside the
 * requested scope, absent from disk, outside the excluded and managed paths,
 * and outside every unobserved prefix. Dropping any one protects the rows.
 *
 * Throws when an eligible PDF's stored profiles admit no single answer; the
 * caller must surface that before any mutation runs.
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const keyOf = (path: string): string => toSyncPathKey(path, input.platform)
  const isKeyUnder = (key: string, prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) => isUnderOrEqual(key, keyOf(prefix)))

  const request = input.request
  const scopePrefixes = request.kind === 'roots' ? input.roots : ([request.path] as const)
  // A file request addresses exactly one comparison key, so its prune scope is
  // equality rather than `isKeyUnder`'s exact-or-descendant membership: a stored
  // row at `<requested file>/child.md` — left behind by a directory that was later
  // replaced by a file of the same name — is a different key and must survive.
  // Directory and roots requests keep the descendant semantics.
  const requestedFileKey = request.kind === 'file' ? keyOf(request.path) : null
  const isInRequestedScope = (rowKey: string): boolean =>
    requestedFileKey === null ? isKeyUnder(rowKey, scopePrefixes) : rowKey === requestedFileKey

  const diskByKey = groupDiskFilesByKey(input.diskFiles, keyOf)
  const storedByKey = groupStoredRowsByKey(input.dbRows, keyOf)
  const { upserts, skipped } = planUpserts(diskByKey, storedByKey, input.visualProfile)

  const unobservedPrefixes = [
    ...input.coverage.unreadableDirs.map((dir) => dir.dirPath),
    ...input.coverage.depthLimitedDirs,
    ...input.coverage.skippedSymlinks,
    ...input.coverage.oversizedFiles,
  ]

  const prunes: SyncPruneAction[] = []
  for (const [rowKey, group] of storedByKey) {
    const survives =
      diskByKey.has(rowKey) ||
      !isInRequestedScope(rowKey) ||
      isKeyUnder(rowKey, unobservedPrefixes) ||
      isKeyUnder(rowKey, input.excludePaths) ||
      group.paths.some((path) => isManagedRawDataPath(path, input.dbPath))
    if (!survives) {
      prunes.push({ storedPaths: group.paths })
    }
  }

  return { upserts, skipped, prunes }
}

/** First disk spelling wins for each comparison key. */
function groupDiskFilesByKey(
  diskFiles: readonly SyncDiskFile[],
  keyOf: (path: string) => string
): Map<string, SyncDiskFile> {
  const diskByKey = new Map<string, SyncDiskFile>()
  for (const file of diskFiles) {
    const fileKey = keyOf(file.filePath)
    if (!diskByKey.has(fileKey)) {
      diskByKey.set(fileKey, file)
    }
  }
  return diskByKey
}

/** Collect every stored spelling and hash that shares a comparison key. */
function groupStoredRowsByKey(
  dbRows: SyncPlanInput['dbRows'],
  keyOf: (path: string) => string
): Map<string, StoredGroup> {
  const storedByKey = new Map<string, StoredGroup>()
  for (const row of dbRows) {
    const rowKey = keyOf(row.filePath)
    const group = storedByKey.get(rowKey) ?? { paths: [], hashes: [], profiles: [] }
    if (!group.paths.includes(row.filePath)) {
      group.paths.push(row.filePath)
    }
    group.hashes.push(row.contentHash ?? null)
    // An empty string is what the fresh-table create path seeds for Arrow
    // inference, so it means absence exactly like `null` and `undefined`.
    const profile = row.visualProfile ?? null
    group.profiles.push(profile === '' ? null : profile)
    storedByKey.set(rowKey, group)
  }
  return storedByKey
}

/**
 * A disk file is skipped when the index already agrees with it.
 *
 * Profile resolution happens here, per scanned file, which is what confines a
 * corrupt stored value to the file that owns it: a row outside the requested
 * scope, under a missing or oversized file, or attached to a non-PDF is never
 * interpreted and therefore cannot fail an unrelated run.
 */
function planUpserts(
  diskByKey: Map<string, SyncDiskFile>,
  storedByKey: Map<string, StoredGroup>,
  override: QualityProfile | undefined
): { upserts: SyncUpsertAction[]; skipped: number } {
  const upserts: SyncUpsertAction[] = []
  let skipped = 0
  for (const [fileKey, file] of diskByKey) {
    const group = storedByKey.get(fileKey)
    const isPdf = isEligiblePdf(file.filePath)
    const visualProfile = isPdf ? resolveDesiredProfile(file.filePath, group, override) : null
    if (group && isConverged(group, file.contentHash, visualProfile, isPdf)) {
      skipped += 1
      continue
    }
    upserts.push({
      filePath: file.filePath,
      // `ingestFile` replaces its own spelling; any other spelling of the same
      // key would otherwise survive as a duplicate of the same file.
      staleStoredPaths: (group?.paths ?? []).filter((path) => path !== file.filePath),
      visualProfile,
    })
  }
  return { upserts, skipped }
}

// ============================================
// Execution (steps 5-10)
// ============================================

function toMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

/**
 * The controlled error for a requested path the collect predicates refuse. One
 * message per rejection, owned here rather than in the adapters, so the CLI and
 * MCP surfaces refuse the same paths with the same words.
 *
 * The `irregular` case is also what keeps a caller from handing sync something
 * whose read never returns (a FIFO). It fixes that trigger only: nothing here
 * bounds a collaborator that hangs for some other reason, and the MCP mutation
 * guard is still released solely by the job promise settling.
 */
function requestedPathRejection(
  kind: Exclude<SyncPathKind, 'file' | 'directory'>,
  path: string
): string {
  switch (kind) {
    case 'missing':
      return `Sync path does not exist: ${path}`
    case 'irregular':
      return `Sync path is not a regular file or directory: ${path}`
    case 'symlink':
      return `Sync path is a symbolic link, which sync never follows: ${path}`
    case 'excluded':
      return `Sync path is inside the database or cache directory: ${path}`
    case 'unsupported':
      return `Sync path is not a supported document type: ${path}`
  }
}

/**
 * The one message every out-of-root request receives. A readable target, an
 * unreadable one, and an absent one are deliberately indistinguishable here, so
 * the error text cannot be used to probe for the existence or readability of
 * paths outside the configured roots. Requests that ARE inside a root keep their
 * specific messages ({@link requestedPathRejection}): those name nothing the
 * caller did not already supply.
 */
function outsideConfiguredRootsMessage(path: string): string {
  return `Sync path is outside every configured root: ${path}`
}

/**
 * Containment of an explicitly requested path, decided before anything reads it.
 * Two questions, both answered by composing generated keys with the unchanged
 * `isUnderOrEqual`:
 *
 * 1. Is the requested spelling under a configured root spelling? This keeps the
 *    request in the same lexical space as the stored DB keys.
 * 2. Is its canonical form under a canonicalized root? This is the security
 *    boundary. `resolve()` cannot see that an intermediate component is a
 *    symbolic link, so question 1 alone accepts `<root>/link/secret.md` whose
 *    real location is outside every root, and the walker's own symlink skipping
 *    does not help: nothing walks an explicitly named path.
 *
 * A path that cannot be canonicalized fails, which is also what makes the
 * rejection uniform.
 */
async function isRequestedPathContained(
  requestedPath: string,
  input: RunSyncInput
): Promise<boolean> {
  const { platform } = input
  const isUnderAny = (path: string, prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) =>
      isUnderOrEqual(toSyncPathKey(path, platform), toSyncPathKey(prefix, platform))
    )

  if (!isUnderAny(requestedPath, input.roots)) {
    return false
  }
  const canonicalPath = await input.collaborators.canonicalizeRequestedPath(requestedPath)
  return canonicalPath !== null && isUnderAny(canonicalPath, input.canonicalRoots)
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
/** Counters and failure state shared by both execution passes. */
interface ExecutionState {
  upserted: number
  empty: number
  pruned: number
  mutated: boolean
  error: SyncError | null
  prunedPaths: string[]
}

/** Ingest every planned file, stopping at the first failure. */
async function runUpserts(
  plan: SyncPlan,
  executor: SyncExecutor,
  images: boolean,
  state: ExecutionState
): Promise<void> {
  for (const action of plan.upserts) {
    try {
      const chunkCount = await executor.ingestFile(action.filePath, {
        images,
        visualProfile: action.visualProfile,
      })
      if (chunkCount === 0) {
        state.empty += 1
        continue
      }
      state.upserted += 1
      state.mutated = true
      // After the insert, not before: a zero-chunk result must leave every
      // stored spelling of this key untouched.
      for (const stalePath of action.staleStoredPaths) {
        await executor.deleteExactPath(stalePath)
      }
    } catch (caught) {
      state.error = { message: toMessage(caught), filePath: action.filePath }
      return
    }
  }
}

/** Delete every planned stale group, stopping at the first failure. */
async function runPrunes(
  plan: SyncPlan,
  executor: SyncExecutor,
  state: ExecutionState
): Promise<void> {
  for (const action of plan.prunes) {
    const [reported] = action.storedPaths
    try {
      for (const storedPath of action.storedPaths) {
        await executor.deleteExactPath(storedPath)
        state.mutated = true
      }
      state.pruned += 1
      if (reported !== undefined) {
        state.prunedPaths.push(reported)
      }
    } catch (caught) {
      state.error = { message: toMessage(caught), filePath: reported ?? null }
      return
    }
  }
}

export async function executeSyncPlan(
  plan: SyncPlan,
  executor: SyncExecutor,
  images = false
): Promise<SyncExecutionResult> {
  const state: ExecutionState = {
    upserted: 0,
    empty: 0,
    pruned: 0,
    mutated: false,
    error: null,
    prunedPaths: [],
  }

  await runUpserts(plan, executor, images, state)
  if (state.error === null) {
    await runPrunes(plan, executor, state)
  }
  if (state.error === null && state.mutated) {
    try {
      await executor.optimize()
    } catch (caught) {
      state.error = { message: toMessage(caught), filePath: null }
    }
  }

  return {
    upserted: state.upserted,
    skipped: plan.skipped,
    empty: state.empty,
    pruned: state.pruned,
    prunedPaths: state.prunedPaths,
    error: state.error,
  }
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
 * `attributedPath` tracks what a thrown error should be blamed on, so an
 * orchestration failure still names the file, root, or requested path involved.
 */
/**
 * Resolve what a sync run addresses and which directories it must walk.
 * Containment is checked against canonical values, and classification happens
 * before any read, so nothing unsupported is hashed or ingested.
 */
async function resolveSyncRequest(
  input: RunSyncInput
): Promise<{ request: SyncRequest; scanRoots: readonly string[] }> {
  const requestedPath = input.requestedPath
  if (requestedPath === undefined) {
    return { request: { kind: 'roots' }, scanRoots: input.roots }
  }
  if (!(await isRequestedPathContained(requestedPath, input))) {
    throw new Error(outsideConfiguredRootsMessage(requestedPath))
  }
  const kind = await input.collaborators.classifyPath(requestedPath)
  if (kind !== 'directory' && kind !== 'file') {
    throw new Error(requestedPathRejection(kind, requestedPath))
  }
  // An explicit directory becomes its own depth-zero BFS root; an explicit
  // file needs no directory walk and no depth evaluation at all.
  return {
    request: { kind, path: requestedPath },
    scanRoots: kind === 'directory' ? [requestedPath] : [],
  }
}

async function gatherSyncInputs(input: RunSyncInput): Promise<GatherOutcome> {
  const { collaborators, platform } = input
  const coverage: SyncCoverage = {
    unreadableDirs: [],
    depthLimitedDirs: [],
    skippedSymlinks: [],
    oversizedFiles: [],
  }
  let attributedPath: string | null = null

  try {
    const requestedPath = input.requestedPath
    if (requestedPath !== undefined) {
      attributedPath = requestedPath
    }
    const { request, scanRoots } = await resolveSyncRequest(input)

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
      if (!diskByKey.has(fileKey)) {
        diskByKey.set(fileKey, filePath)
      }
    }

    const diskFiles: SyncDiskFile[] = []
    for (const filePath of diskByKey.values()) {
      attributedPath = filePath
      const contentHash = await collaborators.hashFile(filePath)
      if (contentHash === null) {
        // Its bytes were never read, so its content identity is unknown for this
        // run. Recording it as an unobserved region is what keeps its stored rows
        // alive: leaving it out of the manifest alone would look like a deletion.
        coverage.oversizedFiles.push(filePath)
        continue
      }
      diskFiles.push({ filePath, contentHash })
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
 * Run one full sync. Counters and coverage facts are plain data — the caller
 * owns printing and exit status. A run with nothing to do calls neither
 * `ingestFile` nor `optimize`, so a true no-op never loads the model.
 */
export async function runSync(input: RunSyncInput): Promise<SyncResult> {
  const gathered = await gatherSyncInputs(input)
  if (!gathered.ok) {
    return {
      upserted: 0,
      skipped: 0,
      empty: 0,
      pruned: 0,
      prunedPaths: [],
      coverage: gathered.coverage,
      error: gathered.error,
    }
  }

  let plan: SyncPlan
  try {
    plan = planSync({
      roots: input.roots,
      dbPath: input.dbPath,
      excludePaths: input.excludePaths,
      platform: input.platform,
      request: gathered.request,
      diskFiles: gathered.diskFiles,
      dbRows: gathered.dbRows,
      coverage: gathered.coverage,
      ...(input.visualProfile === undefined ? {} : { visualProfile: input.visualProfile }),
    })
  } catch (caught) {
    // Planning is pure, so nothing has been written yet: the run reports the
    // same envelope a gathering failure does, with no executor call at all. The
    // message already names the file it is attributable to.
    return {
      upserted: 0,
      skipped: 0,
      empty: 0,
      pruned: 0,
      prunedPaths: [],
      coverage: gathered.coverage,
      error: { message: toMessage(caught), filePath: null },
    }
  }

  const execution = await executeSyncPlan(plan, input.collaborators, input.images === true)
  return { ...execution, coverage: gathered.coverage }
}
