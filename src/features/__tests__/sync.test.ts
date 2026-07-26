import * as fs from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildVectorChunks } from '../../ingest/compute.js'
import { type VectorChunk, VectorStore } from '../../vectordb/index.js'
import {
  executeSyncPlan,
  planSync,
  runSync,
  type SyncCollaborators,
  type SyncCoverage,
  type SyncExecutor,
  type SyncManifestRow,
  type SyncPathKind,
  type SyncPlan,
  type SyncScanResult,
} from '../sync.js'

// Literal SHA-256 hex digests used as content identities. They are opaque
// fixture values here: the planner compares them for equality and never
// recomputes them, so no production hashing code participates in the oracle.
const HASH_A = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const HASH_B = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const HASH_C = '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752'

const ROOT = '/docs-root'
const OTHER_ROOT = '/other-root'
const DB_PATH = '/docs-root/.rag-db'

const noCoverage = (): SyncCoverage => ({
  unreadableDirs: [],
  depthLimitedDirs: [],
  skippedSymlinks: [],
})

/** Planner input with POSIX defaults; each test overrides only what it exercises. */
function planInput(
  overrides: Partial<Parameters<typeof planSync>[0]> = {}
): Parameters<typeof planSync>[0] {
  return {
    roots: [ROOT],
    dbPath: DB_PATH,
    excludePaths: [],
    platform: 'linux',
    request: { kind: 'roots' },
    diskFiles: [],
    dbRows: [],
    coverage: noCoverage(),
    ...overrides,
  }
}

const upsertPaths = (plan: SyncPlan): string[] => plan.upserts.map((action) => action.filePath)
const prunedPaths = (plan: SyncPlan): string[] =>
  plan.prunes.flatMap((action) => action.storedPaths)

// ============================================================
// Planner: content-hash decisions (SYNC-001)
// ============================================================

describe('planSync — content-hash decisions (SYNC-001)', () => {
  it('skips a file whose stored per-chunk hashes are all present, identical, and equal to the disk hash', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/a.md`, contentHash: HASH_A }],
        dbRows: [
          { filePath: `${ROOT}/a.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/a.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/a.md`, contentHash: HASH_A },
        ],
      })
    )

    expect(plan).toEqual({ upserts: [], skipped: 1, prunes: [] })
  })

  it('plans an upsert for a file with no stored rows', () => {
    const plan = planSync(
      planInput({ diskFiles: [{ filePath: `${ROOT}/new.md`, contentHash: HASH_A }] })
    )

    expect(plan.upserts).toEqual([{ filePath: `${ROOT}/new.md`, staleStoredPaths: [] }])
    expect(plan.skipped).toBe(0)
  })

  it('plans an upsert when the stored hash differs from the disk hash', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/changed.md`, contentHash: HASH_B }],
        dbRows: [{ filePath: `${ROOT}/changed.md`, contentHash: HASH_A }],
      })
    )

    expect(upsertPaths(plan)).toEqual([`${ROOT}/changed.md`])
    expect(plan.skipped).toBe(0)
  })

  it('plans an upsert when every stored row is hashless (pre-migration file)', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/legacy.md`, contentHash: HASH_A }],
        dbRows: [
          { filePath: `${ROOT}/legacy.md`, contentHash: null },
          { filePath: `${ROOT}/legacy.md` },
        ],
      })
    )

    expect(upsertPaths(plan)).toEqual([`${ROOT}/legacy.md`])
    expect(plan.skipped).toBe(0)
  })

  it('plans an upsert when stored rows disagree on the hash', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/torn.md`, contentHash: HASH_A }],
        dbRows: [
          { filePath: `${ROOT}/torn.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/torn.md`, contentHash: HASH_B },
        ],
      })
    )

    expect(upsertPaths(plan)).toEqual([`${ROOT}/torn.md`])
  })

  it('plans an upsert when only some stored rows carry the matching hash', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/partial.md`, contentHash: HASH_A }],
        dbRows: [
          { filePath: `${ROOT}/partial.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/partial.md`, contentHash: null },
        ],
      })
    )

    expect(upsertPaths(plan)).toEqual([`${ROOT}/partial.md`])
  })

  it('classifies add, modify, and unchanged files in one pass', () => {
    const plan = planSync(
      planInput({
        diskFiles: [
          { filePath: `${ROOT}/same.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/changed.pdf`, contentHash: HASH_B },
          { filePath: `${ROOT}/added.md`, contentHash: HASH_C },
        ],
        dbRows: [
          { filePath: `${ROOT}/same.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/changed.pdf`, contentHash: HASH_A },
        ],
      })
    )

    expect(upsertPaths(plan)).toEqual([`${ROOT}/changed.pdf`, `${ROOT}/added.md`])
    expect(plan.skipped).toBe(1)
    expect(plan.prunes).toEqual([])
  })
})

// ============================================================
// Planner: prune evidence (SYNC-002)
// ============================================================

describe('planSync — prune evidence (SYNC-002)', () => {
  it('prunes a stored path when all four conditions hold', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/kept.md`, contentHash: HASH_A }],
        dbRows: [
          { filePath: `${ROOT}/kept.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/gone.md`, contentHash: HASH_B },
          { filePath: `${ROOT}/gone.md`, contentHash: HASH_B },
        ],
      })
    )

    expect(plan.prunes).toEqual([{ storedPaths: [`${ROOT}/gone.md`] }])
    expect(plan.skipped).toBe(1)
  })

  it('does not prune a stored path that is still present on disk', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/present.md`, contentHash: HASH_A }],
        dbRows: [{ filePath: `${ROOT}/present.md`, contentHash: HASH_B }],
      })
    )

    expect(plan.prunes).toEqual([])
    expect(upsertPaths(plan)).toEqual([`${ROOT}/present.md`])
  })

  it('does not prune a stored path outside every configured root', () => {
    const plan = planSync(
      planInput({ dbRows: [{ filePath: '/elsewhere/orphan.md', contentHash: HASH_A }] })
    )

    expect(plan.prunes).toEqual([])
  })

  it('prunes across every configured root for an omitted path', () => {
    const plan = planSync(
      planInput({
        roots: [ROOT, OTHER_ROOT],
        dbRows: [
          { filePath: `${ROOT}/gone.md`, contentHash: HASH_A },
          { filePath: `${OTHER_ROOT}/gone.md`, contentHash: HASH_B },
          { filePath: '/elsewhere/gone.md', contentHash: HASH_C },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/gone.md`, `${OTHER_ROOT}/gone.md`])
  })

  it('limits prune to the requested directory subtree', () => {
    const plan = planSync(
      planInput({
        request: { kind: 'directory', path: `${ROOT}/sub` },
        dbRows: [
          { filePath: `${ROOT}/sub/gone.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/other/gone.md`, contentHash: HASH_B },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/sub/gone.md`])
  })

  it('rejects a sibling directory that merely shares a name prefix', () => {
    const plan = planSync(
      planInput({
        request: { kind: 'directory', path: `${ROOT}/bar` },
        dbRows: [
          { filePath: `${ROOT}/barista/gone.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/bar/gone.md`, contentHash: HASH_B },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/bar/gone.md`])
  })

  it('treats a trailing separator on the requested directory as equivalent', () => {
    const withSeparator = planSync(
      planInput({
        request: { kind: 'directory', path: `${ROOT}/sub/` },
        dbRows: [{ filePath: `${ROOT}/sub/gone.md`, contentHash: HASH_A }],
      })
    )

    expect(prunedPaths(withSeparator)).toEqual([`${ROOT}/sub/gone.md`])
  })

  it('never prunes another comparison key for a single-file request', () => {
    const plan = planSync(
      planInput({
        request: { kind: 'file', path: `${ROOT}/sub/target.md` },
        diskFiles: [{ filePath: `${ROOT}/sub/target.md`, contentHash: HASH_B }],
        dbRows: [
          { filePath: `${ROOT}/sub/target.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/sub/neighbour.md`, contentHash: HASH_C },
          { filePath: `${ROOT}/gone.md`, contentHash: HASH_C },
        ],
      })
    )

    expect(plan.prunes).toEqual([])
    expect(upsertPaths(plan)).toEqual([`${ROOT}/sub/target.md`])
  })

  it('prunes the requested file itself once it has left the disk', () => {
    const plan = planSync(
      planInput({
        request: { kind: 'file', path: `${ROOT}/sub/target.md` },
        diskFiles: [],
        dbRows: [
          { filePath: `${ROOT}/sub/target.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/sub/neighbour.md`, contentHash: HASH_C },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/sub/target.md`])
  })
})

// ============================================================
// Planner: unobserved regions protect only affected rows
// ============================================================

describe('planSync — unobserved scan regions', () => {
  const absentRows: SyncManifestRow[] = [
    { filePath: `${ROOT}/hidden/gone.md`, contentHash: HASH_A },
    { filePath: `${ROOT}/observed/gone.md`, contentHash: HASH_B },
  ]

  it('protects rows under an unreadable directory while pruning observed siblings', () => {
    const plan = planSync(
      planInput({
        dbRows: absentRows,
        coverage: {
          ...noCoverage(),
          unreadableDirs: [{ dirPath: `${ROOT}/hidden`, code: 'EACCES' }],
        },
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/observed/gone.md`])
  })

  it('protects rows under a depth-limited directory while pruning observed siblings', () => {
    const plan = planSync(
      planInput({
        dbRows: absentRows,
        coverage: { ...noCoverage(), depthLimitedDirs: [`${ROOT}/hidden`] },
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/observed/gone.md`])
  })

  it('protects rows under a skipped symlink while pruning observed siblings', () => {
    const plan = planSync(
      planInput({
        dbRows: absentRows,
        coverage: { ...noCoverage(), skippedSymlinks: [`${ROOT}/hidden`] },
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/observed/gone.md`])
  })

  it('protects the unobserved directory path itself, not only its descendants', () => {
    const plan = planSync(
      planInput({
        dbRows: [{ filePath: `${ROOT}/link.md`, contentHash: HASH_A }],
        coverage: { ...noCoverage(), skippedSymlinks: [`${ROOT}/link.md`] },
      })
    )

    expect(plan.prunes).toEqual([])
  })

  it('keeps a sibling whose name merely extends an unobserved directory name eligible', () => {
    const plan = planSync(
      planInput({
        dbRows: [{ filePath: `${ROOT}/hidden-too/gone.md`, contentHash: HASH_A }],
        coverage: { ...noCoverage(), depthLimitedDirs: [`${ROOT}/hidden`] },
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/hidden-too/gone.md`])
  })
})

// ============================================================
// Planner: managed and excluded rows
// ============================================================

describe('planSync — managed and excluded rows', () => {
  it('never prunes a managed raw-data row even when it is in scope and absent from disk', () => {
    const plan = planSync(
      planInput({
        dbRows: [
          { filePath: `${DB_PATH}/raw-data/aHR0cHM6Ly9leGFtcGxlLmNvbQ.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/gone.md`, contentHash: HASH_B },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/gone.md`])
  })

  it('never prunes a row under a configured excluded path', () => {
    const plan = planSync(
      planInput({
        excludePaths: [`${ROOT}/.cache`],
        dbRows: [
          { filePath: `${ROOT}/.cache/derived.md`, contentHash: HASH_A },
          { filePath: `${ROOT}/gone.md`, contentHash: HASH_B },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual([`${ROOT}/gone.md`])
  })
})

// ============================================================
// Planner: Windows comparison keys
// ============================================================

describe('planSync — Windows comparison keys', () => {
  const WIN_ROOT = 'C:\\Root'

  it('skips a live file whose stored spelling differs only in case', () => {
    const plan = planSync(
      planInput({
        platform: 'win32',
        roots: [WIN_ROOT],
        dbPath: 'C:\\Db',
        diskFiles: [{ filePath: 'C:\\Root\\Sub\\Live.md', contentHash: HASH_A }],
        dbRows: [{ filePath: 'c:\\root\\sub\\live.md', contentHash: HASH_A }],
      })
    )

    expect(plan).toEqual({ upserts: [], skipped: 1, prunes: [] })
  })

  // Reachable without any interrupted run: `deleteChunks` matches the exact
  // path, so ingesting `C:\Root\Sub\Live.md` and later `c:\root\sub\live.md`
  // leaves two correct-hash row sets for one file. Treating that as converged
  // would skip the key forever and leave searches returning duplicate hits.
  it('re-ingests a key stored under two spellings even when both carry the current disk hash', () => {
    const plan = planSync(
      planInput({
        platform: 'win32',
        roots: [WIN_ROOT],
        dbPath: 'C:\\Db',
        diskFiles: [{ filePath: 'C:\\Root\\Sub\\Live.md', contentHash: HASH_A }],
        dbRows: [
          { filePath: 'C:\\Root\\Sub\\Live.md', contentHash: HASH_A },
          { filePath: 'c:\\root\\sub\\live.md', contentHash: HASH_A },
        ],
      })
    )

    expect(plan).toEqual({
      upserts: [
        { filePath: 'C:\\Root\\Sub\\Live.md', staleStoredPaths: ['c:\\root\\sub\\live.md'] },
      ],
      skipped: 0,
      prunes: [],
    })
  })

  it('deletes the verbatim stored spelling, not the generated key, when re-ingesting', () => {
    const plan = planSync(
      planInput({
        platform: 'win32',
        roots: [WIN_ROOT],
        dbPath: 'C:\\Db',
        diskFiles: [{ filePath: 'C:\\Root\\Sub\\Live.md', contentHash: HASH_B }],
        dbRows: [
          { filePath: 'c:\\root\\sub\\live.md', contentHash: HASH_A },
          { filePath: 'C:\\ROOT\\SUB\\LIVE.MD', contentHash: HASH_A },
        ],
      })
    )

    expect(plan.upserts).toEqual([
      {
        filePath: 'C:\\Root\\Sub\\Live.md',
        staleStoredPaths: ['c:\\root\\sub\\live.md', 'C:\\ROOT\\SUB\\LIVE.MD'],
      },
    ])
    expect(plan.prunes).toEqual([])
  })

  it('groups every stored spelling of one absent Windows file into a single prune action', () => {
    const plan = planSync(
      planInput({
        platform: 'win32',
        roots: [WIN_ROOT],
        dbPath: 'C:\\Db',
        dbRows: [
          { filePath: 'c:\\root\\sub\\gone.md', contentHash: HASH_A },
          { filePath: 'C:\\Root\\Sub\\Gone.md', contentHash: HASH_A },
        ],
      })
    )

    expect(plan.prunes).toEqual([
      { storedPaths: ['c:\\root\\sub\\gone.md', 'C:\\Root\\Sub\\Gone.md'] },
    ])
  })

  it('rejects a Windows sibling directory that shares a name prefix', () => {
    const plan = planSync(
      planInput({
        platform: 'win32',
        roots: [WIN_ROOT],
        dbPath: 'C:\\Db',
        request: { kind: 'directory', path: 'C:\\Root\\bar' },
        dbRows: [
          { filePath: 'c:\\root\\barista\\gone.md', contentHash: HASH_A },
          { filePath: 'c:\\root\\bar\\gone.md', contentHash: HASH_B },
        ],
      })
    )

    expect(prunedPaths(plan)).toEqual(['c:\\root\\bar\\gone.md'])
  })

  it('treats a trailing Windows separator on the requested directory as equivalent', () => {
    const plan = planSync(
      planInput({
        platform: 'win32',
        roots: [WIN_ROOT],
        dbPath: 'C:\\Db',
        request: { kind: 'directory', path: 'C:\\Root\\Sub\\' },
        dbRows: [{ filePath: 'c:\\root\\sub\\gone.md', contentHash: HASH_A }],
      })
    )

    expect(prunedPaths(plan)).toEqual(['c:\\root\\sub\\gone.md'])
  })

  it('keeps POSIX keys case-sensitive so two spellings stay two files', () => {
    const plan = planSync(
      planInput({
        diskFiles: [{ filePath: `${ROOT}/Live.md`, contentHash: HASH_A }],
        dbRows: [{ filePath: `${ROOT}/live.md`, contentHash: HASH_A }],
      })
    )

    expect(upsertPaths(plan)).toEqual([`${ROOT}/Live.md`])
    expect(prunedPaths(plan)).toEqual([`${ROOT}/live.md`])
  })
})

// ============================================================
// Executor with injected fakes
// ============================================================

function createExecutor(
  overrides: {
    ingest?: (filePath: string) => Promise<number>
    remove?: (filePath: string) => Promise<number>
    optimize?: () => Promise<void>
  } = {}
): { executor: SyncExecutor; log: string[] } {
  const log: string[] = []
  return {
    log,
    executor: {
      ingestFile: async (filePath) => {
        log.push(`ingest:${filePath}`)
        return overrides.ingest ? await overrides.ingest(filePath) : 3
      },
      deleteExactPath: async (filePath) => {
        log.push(`delete:${filePath}`)
        return overrides.remove ? await overrides.remove(filePath) : 1
      },
      optimize: async () => {
        log.push('optimize')
        if (overrides.optimize) await overrides.optimize()
      },
    },
  }
}

const upsertOf = (filePath: string, staleStoredPaths: string[] = []) => ({
  filePath,
  staleStoredPaths,
})

describe('executeSyncPlan — mutation gating', () => {
  it('touches no collaborator for a skip-only plan', async () => {
    const { executor, log } = createExecutor()

    const result = await executeSyncPlan({ upserts: [], skipped: 4, prunes: [] }, executor)

    expect(log).toEqual([])
    expect(result).toEqual({ upserted: 0, skipped: 4, empty: 0, pruned: 0, error: null })
  })

  it('records empty and optimizes nothing when a file yields zero chunks', async () => {
    const { executor, log } = createExecutor({ ingest: async () => 0 })

    const result = await executeSyncPlan(
      { upserts: [upsertOf(`${ROOT}/empty.md`, [`${ROOT}/EMPTY.md`])], skipped: 0, prunes: [] },
      executor
    )

    expect(log).toEqual([`ingest:${ROOT}/empty.md`])
    expect(result).toEqual({ upserted: 0, skipped: 0, empty: 1, pruned: 0, error: null })
  })

  it('optimizes exactly once after a mutating run', async () => {
    const { executor, log } = createExecutor()

    const result = await executeSyncPlan(
      {
        upserts: [upsertOf(`${ROOT}/a.md`)],
        skipped: 1,
        prunes: [{ storedPaths: [`${ROOT}/gone.md`] }],
      },
      executor
    )

    expect(log).toEqual([`ingest:${ROOT}/a.md`, `delete:${ROOT}/gone.md`, 'optimize'])
    expect(result).toEqual({ upserted: 1, skipped: 1, empty: 0, pruned: 1, error: null })
  })

  it('deletes stale stored spellings only after a successful insert', async () => {
    const { executor, log } = createExecutor()

    await executeSyncPlan(
      { upserts: [upsertOf(`${ROOT}/A.md`, [`${ROOT}/a.md`])], skipped: 0, prunes: [] },
      executor
    )

    expect(log).toEqual([`ingest:${ROOT}/A.md`, `delete:${ROOT}/a.md`, 'optimize'])
  })

  it('prunes every stored spelling of one key but counts the key once', async () => {
    const { executor, log } = createExecutor()

    const result = await executeSyncPlan(
      { upserts: [], skipped: 0, prunes: [{ storedPaths: ['c:\\a\\g.md', 'C:\\A\\G.md'] }] },
      executor
    )

    expect(log).toEqual(['delete:c:\\a\\g.md', 'delete:C:\\A\\G.md', 'optimize'])
    expect(result.pruned).toBe(1)
  })
})

describe('executeSyncPlan — first error stops the run (SYNC-004)', () => {
  it('suppresses later upserts, all prune, and optimize after the first failure', async () => {
    const { executor, log } = createExecutor({
      ingest: async (filePath) => {
        if (filePath === `${ROOT}/b.md`) throw new Error('embedding failed')
        return 2
      },
    })

    const result = await executeSyncPlan(
      {
        upserts: [upsertOf(`${ROOT}/a.md`), upsertOf(`${ROOT}/b.md`), upsertOf(`${ROOT}/c.md`)],
        skipped: 0,
        prunes: [{ storedPaths: [`${ROOT}/gone.md`] }],
      },
      executor
    )

    expect(log).toEqual([`ingest:${ROOT}/a.md`, `ingest:${ROOT}/b.md`])
    expect(result).toEqual({
      upserted: 1,
      skipped: 0,
      empty: 0,
      pruned: 0,
      error: { message: 'embedding failed', filePath: `${ROOT}/b.md` },
    })
  })

  it('stops at the first prune failure and skips optimize', async () => {
    const { executor, log } = createExecutor({
      remove: async (filePath) => {
        if (filePath === `${ROOT}/second.md`) throw new Error('delete failed')
        return 1
      },
    })

    const result = await executeSyncPlan(
      {
        upserts: [],
        skipped: 0,
        prunes: [{ storedPaths: [`${ROOT}/first.md`] }, { storedPaths: [`${ROOT}/second.md`] }],
      },
      executor
    )

    expect(log).toEqual([`delete:${ROOT}/first.md`, `delete:${ROOT}/second.md`])
    expect(result).toEqual({
      upserted: 0,
      skipped: 0,
      empty: 0,
      pruned: 1,
      error: { message: 'delete failed', filePath: `${ROOT}/second.md` },
    })
  })

  // The stale-spelling deletes run after the insert, which puts them inside the
  // upsert loop's failure boundary. A swallowed failure there would let
  // execution fall through into prune — the one thing SYNC-004 forbids after an
  // error — so the positional log pins both that every stale spelling is
  // attempted and that the first stale failure aborts the run.
  it('aborts the whole run when deleting a stale stored spelling fails mid-upsert', async () => {
    const { executor, log } = createExecutor({
      remove: async (filePath) => {
        if (filePath === `${ROOT}/a-2.md`) throw new Error('delete failed')
        return 1
      },
    })

    const result = await executeSyncPlan(
      {
        upserts: [upsertOf(`${ROOT}/A.md`, [`${ROOT}/a.md`, `${ROOT}/a-2.md`])],
        skipped: 0,
        prunes: [{ storedPaths: [`${ROOT}/gone.md`] }],
      },
      executor
    )

    expect(log).toEqual([`ingest:${ROOT}/A.md`, `delete:${ROOT}/a.md`, `delete:${ROOT}/a-2.md`])
    expect(result).toEqual({
      upserted: 1,
      skipped: 0,
      empty: 0,
      pruned: 0,
      error: { message: 'delete failed', filePath: `${ROOT}/A.md` },
    })
  })

  it('reports an optimize failure as the single controlled error', async () => {
    const { executor } = createExecutor({
      optimize: async () => {
        throw new Error('optimize failed')
      },
    })

    const result = await executeSyncPlan(
      { upserts: [upsertOf(`${ROOT}/a.md`)], skipped: 0, prunes: [] },
      executor
    )

    expect(result.upserted).toBe(1)
    expect(result.error).toEqual({ message: 'optimize failed', filePath: null })
  })
})

// ============================================================
// runSync composition (steps 1-3) with injected fakes
// ============================================================

interface FakeSetup {
  scans?: Record<string, Partial<SyncScanResult>>
  kinds?: Record<string, SyncPathKind>
  hashes?: Record<string, string>
  dbRows?: SyncManifestRow[]
  ingest?: (filePath: string) => Promise<number>
  loadDbManifest?: () => Promise<SyncManifestRow[]>
}

function createCollaborators(setup: FakeSetup = {}): {
  collaborators: SyncCollaborators
  log: string[]
  scanArgs: unknown[][]
} {
  const log: string[] = []
  const scanArgs: unknown[][] = []
  return {
    log,
    scanArgs,
    collaborators: {
      classifyPath: async (path) => {
        log.push(`classify:${path}`)
        return setup.kinds?.[path] ?? 'missing'
      },
      scanDir: async (...args: [string]) => {
        scanArgs.push(args)
        log.push(`scan:${args[0]}`)
        return {
          files: [],
          unreadableDirs: [],
          depthLimitedDirs: [],
          skippedSymlinks: [],
          ...setup.scans?.[args[0]],
        }
      },
      hashFile: async (filePath) => {
        log.push(`hash:${filePath}`)
        const hash = setup.hashes?.[filePath]
        if (hash === undefined) throw new Error(`no fixture hash for ${filePath}`)
        return hash
      },
      loadDbManifest: async () => {
        log.push('manifest')
        if (setup.loadDbManifest) return await setup.loadDbManifest()
        return setup.dbRows ?? []
      },
      ingestFile: async (filePath) => {
        log.push(`ingest:${filePath}`)
        return setup.ingest ? await setup.ingest(filePath) : 2
      },
      deleteExactPath: async (filePath) => {
        log.push(`delete:${filePath}`)
        return 1
      },
      optimize: async () => {
        log.push('optimize')
      },
    },
  }
}

const runInput = (
  collaborators: SyncCollaborators,
  overrides: Partial<Parameters<typeof runSync>[0]> = {}
): Parameters<typeof runSync>[0] => ({
  roots: [ROOT],
  dbPath: DB_PATH,
  excludePaths: [],
  platform: 'linux',
  collaborators,
  ...overrides,
})

describe('runSync — request classification and scan roots', () => {
  it('scans each configured root exactly once, passing only the root path', async () => {
    const { collaborators, log, scanArgs } = createCollaborators({
      scans: {
        [ROOT]: { files: [`${ROOT}/a.md`] },
        [OTHER_ROOT]: { files: [`${OTHER_ROOT}/b.md`] },
      },
      hashes: { [`${ROOT}/a.md`]: HASH_A, [`${OTHER_ROOT}/b.md`]: HASH_B },
    })

    const result = await runSync(runInput(collaborators, { roots: [ROOT, OTHER_ROOT] }))

    expect(scanArgs).toEqual([[ROOT], [OTHER_ROOT]])
    expect(log.filter((entry) => entry.startsWith('classify:'))).toEqual([])
    expect(result.upserted).toBe(2)
    expect(result.error).toBeNull()
  })

  it('scans only the requested directory when a directory path is given', async () => {
    const { collaborators, scanArgs } = createCollaborators({
      kinds: { [`${ROOT}/sub`]: 'directory' },
      scans: { [`${ROOT}/sub`]: { files: [`${ROOT}/sub/a.md`] } },
      hashes: { [`${ROOT}/sub/a.md`]: HASH_A },
    })

    const result = await runSync(
      runInput(collaborators, { roots: [ROOT, OTHER_ROOT], requestedPath: `${ROOT}/sub` })
    )

    expect(scanArgs).toEqual([[`${ROOT}/sub`]])
    expect(result.upserted).toBe(1)
  })

  it('handles a requested file with no directory scan at all', async () => {
    const { collaborators, log } = createCollaborators({
      kinds: { [`${ROOT}/only.md`]: 'file' },
      hashes: { [`${ROOT}/only.md`]: HASH_A },
      dbRows: [{ filePath: `${ROOT}/only.md`, contentHash: HASH_A }],
    })

    const result = await runSync(runInput(collaborators, { requestedPath: `${ROOT}/only.md` }))

    expect(log).toEqual([`classify:${ROOT}/only.md`, `hash:${ROOT}/only.md`, 'manifest'])
    expect(result).toEqual({
      upserted: 0,
      skipped: 1,
      empty: 0,
      pruned: 0,
      coverage: noCoverage(),
      error: null,
    })
  })

  it('rejects a requested path outside every configured root before any I/O', async () => {
    const { collaborators, log } = createCollaborators()

    const result = await runSync(runInput(collaborators, { requestedPath: '/elsewhere/x.md' }))

    expect(log).toEqual([])
    expect(result.error?.filePath).toBe('/elsewhere/x.md')
    expect(result.error?.message).toContain('/elsewhere/x.md')
    expect(result.upserted).toBe(0)
  })

  it('rejects a requested path that does not exist', async () => {
    const { collaborators, log } = createCollaborators({
      kinds: { [`${ROOT}/ghost.md`]: 'missing' },
    })

    const result = await runSync(runInput(collaborators, { requestedPath: `${ROOT}/ghost.md` }))

    expect(log).toEqual([`classify:${ROOT}/ghost.md`])
    expect(result.error?.filePath).toBe(`${ROOT}/ghost.md`)
  })

  it('accepts a configured root itself as the requested directory', async () => {
    const { collaborators, scanArgs } = createCollaborators({
      kinds: { [ROOT]: 'directory' },
      scans: { [ROOT]: { files: [] } },
    })

    const result = await runSync(runInput(collaborators, { requestedPath: ROOT }))

    expect(scanArgs).toEqual([[ROOT]])
    expect(result.error).toBeNull()
  })
})

describe('runSync — gathering', () => {
  it('hashes one representative path per comparison key across overlapping roots', async () => {
    const { collaborators, log } = createCollaborators({
      scans: {
        [ROOT]: { files: [`${ROOT}/dup.md`] },
        [`${ROOT}/sub`]: { files: [`${ROOT}/dup.md`] },
      },
      hashes: { [`${ROOT}/dup.md`]: HASH_A },
    })

    const result = await runSync(runInput(collaborators, { roots: [ROOT, `${ROOT}/sub`] }))

    expect(log.filter((entry) => entry.startsWith('hash:'))).toEqual([`hash:${ROOT}/dup.md`])
    expect(result.upserted).toBe(1)
  })

  it('merges coverage facts from every scanned root into the result', async () => {
    const { collaborators } = createCollaborators({
      scans: {
        [ROOT]: { unreadableDirs: [{ dirPath: `${ROOT}/locked`, code: 'EACCES' }] },
        [OTHER_ROOT]: {
          depthLimitedDirs: [`${OTHER_ROOT}/deep`],
          skippedSymlinks: [`${OTHER_ROOT}/link`],
        },
      },
    })

    const result = await runSync(runInput(collaborators, { roots: [ROOT, OTHER_ROOT] }))

    expect(result.coverage).toEqual({
      unreadableDirs: [{ dirPath: `${ROOT}/locked`, code: 'EACCES' }],
      depthLimitedDirs: [`${OTHER_ROOT}/deep`],
      skippedSymlinks: [`${OTHER_ROOT}/link`],
    })
  })

  it('reports an orchestration failure as one controlled error without mutating', async () => {
    const { collaborators, log } = createCollaborators({
      scans: { [ROOT]: { files: [`${ROOT}/a.md`] } },
      hashes: { [`${ROOT}/a.md`]: HASH_A },
      loadDbManifest: async () => {
        throw new Error('manifest unavailable')
      },
    })

    const result = await runSync(runInput(collaborators))

    expect(log).toEqual([`scan:${ROOT}`, `hash:${ROOT}/a.md`, 'manifest'])
    expect(result).toEqual({
      upserted: 0,
      skipped: 0,
      empty: 0,
      pruned: 0,
      coverage: noCoverage(),
      error: { message: 'manifest unavailable', filePath: null },
    })
  })

  it('reports a hash failure against the file that could not be read', async () => {
    const { collaborators } = createCollaborators({
      scans: { [ROOT]: { files: [`${ROOT}/unreadable.md`] } },
    })

    const result = await runSync(runInput(collaborators))

    expect(result.error?.filePath).toBe(`${ROOT}/unreadable.md`)
  })

  it('protects every in-scope row when a configured root is entirely unreadable', async () => {
    const { collaborators, log } = createCollaborators({
      scans: { [ROOT]: { unreadableDirs: [{ dirPath: ROOT, code: 'EACCES' }] } },
      dbRows: [{ filePath: `${ROOT}/a.md`, contentHash: HASH_A }],
    })

    const result = await runSync(runInput(collaborators))

    expect(log).toEqual([`scan:${ROOT}`, 'manifest'])
    expect(result.pruned).toBe(0)
  })

  it('completes an initial insert and then treats a byte-identical rerun as a no-op', async () => {
    const first = createCollaborators({
      scans: { [ROOT]: { files: [`${ROOT}/a.md`] } },
      hashes: { [`${ROOT}/a.md`]: HASH_A },
    })

    const firstResult = await runSync(runInput(first.collaborators))
    expect(firstResult.upserted).toBe(1)
    expect(first.log).toContain('optimize')

    const second = createCollaborators({
      scans: { [ROOT]: { files: [`${ROOT}/a.md`] } },
      hashes: { [`${ROOT}/a.md`]: HASH_A },
      dbRows: [
        { filePath: `${ROOT}/a.md`, contentHash: HASH_A },
        { filePath: `${ROOT}/a.md`, contentHash: HASH_A },
      ],
    })

    const secondResult = await runSync(runInput(second.collaborators))

    expect(secondResult).toEqual({
      upserted: 0,
      skipped: 1,
      empty: 0,
      pruned: 0,
      coverage: noCoverage(),
      error: null,
    })
    expect(second.log).toEqual([`scan:${ROOT}`, `hash:${ROOT}/a.md`, 'manifest'])
  })
})

// ============================================================
// Early Verification Point: executor against a real VectorStore
// ============================================================

describe('sync executor against a real VectorStore (Early Verification Point)', () => {
  const VECTOR_DIMENSION = 384

  function fakeVector(seed: number): number[] {
    const raw = Array.from({ length: VECTOR_DIMENSION }, (_, index) => Math.sin(seed + index))
    const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
    return raw.map((value) => value / norm)
  }

  async function withStore(
    name: string,
    body: (store: VectorStore, dbPath: string) => Promise<void>
  ): Promise<void> {
    const dbPath = `./tmp/test-sync-${name}`
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true })
    try {
      const store = new VectorStore({ dbPath, tableName: 'chunks' })
      await store.initialize()
      await body(store, dbPath)
    } finally {
      if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true })
    }
  }

  /** Seed rows for one exact stored spelling, mirroring what ingestion writes. */
  async function seed(
    store: VectorStore,
    filePath: string,
    contentHash: string | null,
    chunkCount = 2
  ): Promise<void> {
    await store.insertChunks(
      buildVectorChunks({
        filePath,
        chunks: Array.from({ length: chunkCount }, (_, index) => ({
          index,
          text: `seeded chunk ${index} of ${basename(filePath)}`,
        })),
        embeddings: Array.from({ length: chunkCount }, (_, index) => fakeVector(index + 1)),
        fileSize: 64,
        fileTitle: null,
        contentHash,
      })
    )
  }

  /**
   * `ingestFile` stand-in that reproduces `ingestSingleFile`'s persistence:
   * build the vector chunks first, then delete the file's own rows and insert.
   * The parser/chunker/embedder are out of the picture on purpose (external and
   * slow); the store is real because row survival is the subject.
   */
  function storeIngest(
    store: VectorStore,
    hashes: Record<string, string>,
    log: string[],
    failOn?: string
  ): (filePath: string) => Promise<number> {
    return async (filePath) => {
      log.push(`ingest:${filePath}`)
      if (filePath === failOn) throw new Error('induced ingest failure')
      const chunks = buildVectorChunks({
        filePath,
        chunks: [{ index: 0, text: `fresh chunk of ${basename(filePath)}` }],
        embeddings: [fakeVector(99)],
        fileSize: 32,
        fileTitle: null,
        contentHash: hashes[filePath] ?? null,
      })
      await store.deleteChunks(filePath)
      await store.insertChunks(chunks)
      return chunks.length
    }
  }

  function storeCollaborators(
    store: VectorStore,
    log: string[],
    ingest: (filePath: string) => Promise<number>
  ): SyncExecutor {
    return {
      ingestFile: ingest,
      deleteExactPath: async (filePath) => {
        log.push(`delete:${filePath}`)
        return await store.deleteChunks(filePath)
      },
      optimize: async () => {
        log.push('optimize')
        await store.optimize()
      },
    }
  }

  const hashesOf = async (store: VectorStore, filePath: string): Promise<(string | null)[]> =>
    (await store.getChunksByFilePath(filePath))
      .sort((a: VectorChunk, b: VectorChunk) => a.chunkIndex - b.chunkIndex)
      .map((chunk: VectorChunk) => chunk.contentHash ?? null)

  const manifestFrom = (store: VectorStore) => async (): Promise<SyncManifestRow[]> =>
    await store.listChunkHashes()

  it('(a) prunes an absent sibling while leaving the live file and a prefix-sharing sibling readable', async () => {
    await withStore('scope-siblings', async (store, dbPath) => {
      await seed(store, `${ROOT}/bar/live.md`, HASH_A)
      await seed(store, `${ROOT}/bar/gone.md`, HASH_B)
      await seed(store, `${ROOT}/barista/gone.md`, HASH_C)
      const log: string[] = []

      const result = await runSync({
        roots: [ROOT],
        dbPath,
        excludePaths: [],
        platform: 'linux',
        requestedPath: `${ROOT}/bar`,
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [`${ROOT}/bar/live.md`],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_A,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, {}, log)),
        },
      })

      expect(result).toMatchObject({ upserted: 0, skipped: 1, empty: 0, pruned: 1, error: null })
      expect(await hashesOf(store, `${ROOT}/bar/live.md`)).toEqual([HASH_A, HASH_A])
      expect(await hashesOf(store, `${ROOT}/barista/gone.md`)).toEqual([HASH_C, HASH_C])
      expect(await store.getChunksByFilePath(`${ROOT}/bar/gone.md`)).toEqual([])
    })
  })

  it('(a) never deletes a Windows-equivalent spelling of a live file', async () => {
    await withStore('windows-live', async (store, dbPath) => {
      await seed(store, 'c:\\root\\sub\\live.md', HASH_A)
      const log: string[] = []

      const result = await runSync({
        roots: ['C:\\Root'],
        dbPath,
        excludePaths: [],
        platform: 'win32',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: ['C:\\Root\\Sub\\Live.md'],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_A,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, {}, log)),
        },
      })

      expect(result).toMatchObject({ upserted: 0, skipped: 1, pruned: 0, error: null })
      expect(log).toEqual([])
      expect(await hashesOf(store, 'c:\\root\\sub\\live.md')).toEqual([HASH_A, HASH_A])
    })
  })

  it('(a) replaces the stale Windows spelling when the same file changed', async () => {
    await withStore('windows-changed', async (store, dbPath) => {
      await seed(store, 'c:\\root\\sub\\live.md', HASH_A)
      const diskPath = 'C:\\Root\\Sub\\Live.md'
      const log: string[] = []

      const result = await runSync({
        roots: ['C:\\Root'],
        dbPath,
        excludePaths: [],
        platform: 'win32',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [diskPath],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_B,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, { [diskPath]: HASH_B }, log)),
        },
      })

      expect(result).toMatchObject({ upserted: 1, pruned: 0, error: null })
      expect(log).toEqual([`ingest:${diskPath}`, 'delete:c:\\root\\sub\\live.md', 'optimize'])
      expect(await hashesOf(store, diskPath)).toEqual([HASH_B])
      expect(await store.getChunksByFilePath('c:\\root\\sub\\live.md')).toEqual([])
    })
  })

  /**
   * The state a run interrupted between insert and stale-spelling deletion
   * leaves behind, and the state a double ingest under two Windows spellings
   * produces: one comparison key with two stored spellings carrying different
   * hashes. One sync run must collapse it back to a single spelling.
   */
  it('(a) converges a key stored under two disagreeing Windows spellings in one run', async () => {
    await withStore('windows-two-spellings', async (store, dbPath) => {
      const diskPath = 'C:\\Root\\Sub\\Live.md'
      await seed(store, 'c:\\root\\sub\\live.md', HASH_A)
      await seed(store, diskPath, HASH_B)
      const log: string[] = []

      const result = await runSync({
        roots: ['C:\\Root'],
        dbPath,
        excludePaths: [],
        platform: 'win32',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [diskPath],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_B,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, { [diskPath]: HASH_B }, log)),
        },
      })

      expect(result).toMatchObject({ upserted: 1, skipped: 0, pruned: 0, error: null })
      expect(log).toEqual([`ingest:${diskPath}`, 'delete:c:\\root\\sub\\live.md', 'optimize'])
      expect(await hashesOf(store, diskPath)).toEqual([HASH_B])
      expect(await store.getChunksByFilePath('c:\\root\\sub\\live.md')).toEqual([])
    })
  })

  it('(b) keeps rows under an unobserved prefix readable while pruning the observed sibling', async () => {
    await withStore('unobserved-prefix', async (store, dbPath) => {
      await seed(store, `${ROOT}/deep/hidden.md`, HASH_A, 3)
      await seed(store, `${ROOT}/open/gone.md`, HASH_B)
      const log: string[] = []

      const result = await runSync({
        roots: [ROOT],
        dbPath,
        excludePaths: [],
        platform: 'linux',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [],
            unreadableDirs: [],
            depthLimitedDirs: [`${ROOT}/deep`],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_A,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, {}, log)),
        },
      })

      expect(result).toMatchObject({ pruned: 1, error: null })
      expect(result.coverage.depthLimitedDirs).toEqual([`${ROOT}/deep`])
      expect(await hashesOf(store, `${ROOT}/deep/hidden.md`)).toEqual([HASH_A, HASH_A, HASH_A])
      expect(await store.getChunksByFilePath(`${ROOT}/open/gone.md`)).toEqual([])
    })
  })

  it('(c) keeps managed raw-data and excluded rows out of prune', async () => {
    await withStore('managed-excluded', async (store, dbPath) => {
      const rawDataPath = `${dbPath}/raw-data/aHR0cHM6Ly9leGFtcGxlLmNvbQ.md`
      const cachePath = `${ROOT}/.cache/derived.md`
      await seed(store, rawDataPath, HASH_A)
      await seed(store, cachePath, HASH_B)
      await seed(store, `${ROOT}/gone.md`, HASH_C)
      const log: string[] = []

      const result = await runSync({
        roots: [ROOT, dbPath],
        dbPath,
        excludePaths: [`${ROOT}/.cache`],
        platform: 'linux',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_A,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, {}, log)),
        },
      })

      expect(result).toMatchObject({ pruned: 1, error: null })
      expect(log).toEqual([`delete:${ROOT}/gone.md`, 'optimize'])
      expect(await hashesOf(store, rawDataPath)).toEqual([HASH_A, HASH_A])
      expect(await hashesOf(store, cachePath)).toEqual([HASH_B, HASH_B])
      expect(await store.getChunksByFilePath(`${ROOT}/gone.md`)).toEqual([])
    })
  })

  it('(d) retains earlier upserts and performs no prune after the first failure', async () => {
    await withStore('first-failure', async (store, dbPath) => {
      await seed(store, `${ROOT}/a.md`, HASH_A)
      await seed(store, `${ROOT}/b.md`, HASH_A)
      await seed(store, `${ROOT}/c.md`, HASH_A)
      await seed(store, `${ROOT}/gone.md`, HASH_A)
      const log: string[] = []
      const diskHashes = {
        [`${ROOT}/a.md`]: HASH_B,
        [`${ROOT}/b.md`]: HASH_B,
        [`${ROOT}/c.md`]: HASH_B,
      }

      const result = await runSync({
        roots: [ROOT],
        dbPath,
        excludePaths: [],
        platform: 'linux',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_B,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(store, log, storeIngest(store, diskHashes, log, `${ROOT}/b.md`)),
        },
      })

      expect(result).toMatchObject({
        upserted: 1,
        pruned: 0,
        error: { message: 'induced ingest failure', filePath: `${ROOT}/b.md` },
      })
      expect(log).toEqual([`ingest:${ROOT}/a.md`, `ingest:${ROOT}/b.md`])
      expect(await hashesOf(store, `${ROOT}/a.md`)).toEqual([HASH_B])
      expect(await hashesOf(store, `${ROOT}/b.md`)).toEqual([HASH_A, HASH_A])
      expect(await hashesOf(store, `${ROOT}/c.md`)).toEqual([HASH_A, HASH_A])
      expect(await hashesOf(store, `${ROOT}/gone.md`)).toEqual([HASH_A, HASH_A])
    })
  })

  it('(d) completes every upsert before the first prune', async () => {
    await withStore('upsert-before-prune', async (store, dbPath) => {
      await seed(store, `${ROOT}/changed.md`, HASH_A)
      await seed(store, `${ROOT}/gone.md`, HASH_A)
      const log: string[] = []

      const result = await runSync({
        roots: [ROOT],
        dbPath,
        excludePaths: [],
        platform: 'linux',
        collaborators: {
          classifyPath: async () => 'directory',
          scanDir: async () => ({
            files: [`${ROOT}/changed.md`],
            unreadableDirs: [],
            depthLimitedDirs: [],
            skippedSymlinks: [],
          }),
          hashFile: async () => HASH_B,
          loadDbManifest: manifestFrom(store),
          ...storeCollaborators(
            store,
            log,
            storeIngest(store, { [`${ROOT}/changed.md`]: HASH_B }, log)
          ),
        },
      })

      expect(result).toMatchObject({ upserted: 1, pruned: 1, error: null })
      expect(log).toEqual([`ingest:${ROOT}/changed.md`, `delete:${ROOT}/gone.md`, 'optimize'])
      expect(await hashesOf(store, `${ROOT}/changed.md`)).toEqual([HASH_B])
      expect(await store.getChunksByFilePath(`${ROOT}/gone.md`)).toEqual([])
    })
  })

  it('(e) preserves rows and hash for a zero-chunk file and plans it again next run', async () => {
    await withStore('empty-preserves', async (store, dbPath) => {
      await seed(store, `${ROOT}/empty.md`, HASH_A, 3)
      const log: string[] = []
      const collaborators = (): SyncCollaborators => ({
        classifyPath: async () => 'directory',
        scanDir: async () => ({
          files: [`${ROOT}/empty.md`],
          unreadableDirs: [],
          depthLimitedDirs: [],
          skippedSymlinks: [],
        }),
        hashFile: async () => HASH_B,
        loadDbManifest: manifestFrom(store),
        ...storeCollaborators(store, log, async (filePath) => {
          log.push(`ingest:${filePath}`)
          return 0
        }),
      })

      const first = await runSync({
        roots: [ROOT],
        dbPath,
        excludePaths: [],
        platform: 'linux',
        collaborators: collaborators(),
      })

      expect(first).toMatchObject({ upserted: 0, empty: 1, pruned: 0, error: null })
      expect(log).toEqual([`ingest:${ROOT}/empty.md`])
      expect(await hashesOf(store, `${ROOT}/empty.md`)).toEqual([HASH_A, HASH_A, HASH_A])

      const second = await runSync({
        roots: [ROOT],
        dbPath,
        excludePaths: [],
        platform: 'linux',
        collaborators: collaborators(),
      })

      expect(second).toMatchObject({ upserted: 0, empty: 1, skipped: 0, error: null })
      expect(await hashesOf(store, `${ROOT}/empty.md`)).toEqual([HASH_A, HASH_A, HASH_A])
    })
  })
})
