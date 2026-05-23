// Multi-root MCP server integration tests (P3-T4).
//
// Scope: closes the remaining end-to-end gaps for Phase 3 not already covered
// by P3-T2 (`rag-server.files.integration.test.ts`, multi-root list_files
// shape) and P3-T3 (`rag-server.warning-visibility.test.ts`, content-block
// warnings + configError fail-fast with stubbed warnings).
//
// What this file adds (and intentionally does not duplicate):
//   - End-to-end multi-root ingest_file → list_files round-trip showing each
//     file is annotated with its producing root and persists to one DB.
//   - End-to-end multi-root delete_file scoped to one root, leaving other
//     root's chunks intact.
//   - End-to-end multi-root query_documents returning chunks from any root.
//   - End-to-end multi-root read_chunk_neighbors against a file under a
//     non-first root.
//   - Raw-data ingest_data behavior unchanged in multi-root mode (response
//     shape preserved; warnings additive only) — covers AC-009 raw-data path.
//   - Precedence + nested-pruning warning content produced by REAL
//     `resolveBaseDirs` (not stubbed strings), surfaced via RAGServer
//     responses (AC-003, AC-013).
//   - Invalid `BASE_DIRS` end-to-end via real `resolveBaseDirs`: degraded-mode
//     RAGServer keeps `status` callable and root-dependent tools throw a
//     structured McpError (AC-010 end-to-end).
//
// Construction style: this file wires RAGServer the same way `server-main.ts`
// does (resolveBaseDirs → RAGServer({ baseDirs, configWarnings, configError }))
// so the assertions exercise the real configuration pipeline rather than
// stubbed values. We deliberately do NOT call `startServer()` because it
// owns `process.exit` semantics that are unsafe inside a vitest worker.

import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BaseDirsConfigError, displayPath, resolveBaseDirs } from '../../utils/base-dirs.js'
import { RAGServer } from '../index.js'

// =============================================================================
// Helpers
// =============================================================================

type ContentBlock = { type: string; text: string; annotations?: unknown }

/** Find the first content block whose text contains `needle`. */
function findBlock(content: ReadonlyArray<ContentBlock>, needle: string): ContentBlock | undefined {
  return content.find((b) => b.type === 'text' && b.text.includes(needle))
}

/**
 * Build a RAGServer the same way `server-main.ts` does, but with explicit
 * inputs so tests can simulate env without mutating `process.env` (which
 * vitest workers share). Returns the constructed (uninitialized) server plus
 * the resolved warnings/error so callers can assert on the resolver output
 * directly when useful.
 */
async function buildServerFromResolver(opts: {
  dbPath: string
  cacheDir: string
  envBaseDirs?: string | undefined
  envBaseDir?: string | undefined
  cwd: string
}): Promise<{
  server: RAGServer
  warnings: string[]
  configError: BaseDirsConfigError | undefined
}> {
  const result = await resolveBaseDirs({
    envBaseDirs: opts.envBaseDirs,
    envBaseDir: opts.envBaseDir,
    cwd: opts.cwd,
  })

  const warnings: string[] = []
  let baseDirs: string[]
  let configError: BaseDirsConfigError | undefined

  if (result.ok) {
    baseDirs = result.config.baseDirs
    for (const w of result.warnings) warnings.push(w.message)
  } else {
    // Degraded mode mirror of server-main.ts (post-Finding-#4): pass an empty
    // `baseDirs` so any handler bypassing `assertConfigOk` fails closed at the
    // parser level rather than silently operating against `cwd`.
    baseDirs = []
    configError = result.error
    warnings.push(result.error.message)
  }

  const server = new RAGServer({
    dbPath: opts.dbPath,
    modelName: 'Xenova/all-MiniLM-L6-v2',
    cacheDir: opts.cacheDir,
    baseDirs,
    maxFileSize: 100 * 1024 * 1024,
    configWarnings: warnings,
    ...(configError !== undefined ? { configError } : {}),
  })

  return { server, warnings, configError }
}

// =============================================================================
// AC-008/AC-011/AC-012/AC-013: end-to-end multi-root workflows
// =============================================================================
describe('AC-008/AC-011: multi-root ingest -> list -> query -> delete workflow', () => {
  const testBase = resolve('./tmp/test-multi-root-e2e')
  const rootA = resolve(testBase, 'rootA')
  const rootB = resolve(testBase, 'rootB')
  const dbPath = resolve(testBase, 'lancedb')
  const cacheDir = resolve(testBase, 'cache')

  let server: RAGServer
  let fileA: string
  let fileB: string

  beforeAll(async () => {
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    fileA = resolve(rootA, 'doc-a.txt')
    fileB = resolve(rootB, 'doc-b.txt')
    writeFileSync(
      fileA,
      'Alpha root document about photosynthesis. ' +
        'Photosynthesis is the process by which plants convert sunlight into chemical energy. ' +
        'This sentence pads the document so it clears the minimum chunk filter for ingestion.'
    )
    writeFileSync(
      fileB,
      'Beta root document about gravitational waves. ' +
        'Gravitational waves are ripples in spacetime predicted by general relativity. ' +
        'This sentence pads the document so it clears the minimum chunk filter for ingestion.'
    )

    server = new RAGServer({
      dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir,
      baseDirs: [rootA, rootB],
      maxFileSize: 100 * 1024 * 1024,
    })
    await server.initialize()

    await server.handleIngestFile({ filePath: fileA })
    await server.handleIngestFile({ filePath: fileB })
  }, 120000)

  afterAll(async () => {
    await server.close()
    rmSync(testBase, { recursive: true, force: true })
  })

  // AC interpretation: [AC-008] After ingesting files under different roots, `list_files` reports each file's producing root
  // Validation: list_files annotates fileA with rootA and fileB with rootB, both ingested=true with chunkCount > 0
  it('ingest_file under two roots produces per-root annotated list_files entries', async () => {
    const result = await server.handleListFiles()
    const parsed = JSON.parse(result.content[0].text)

    const entryA = parsed.files.find((f: { filePath: string }) => f.filePath === fileA)
    const entryB = parsed.files.find((f: { filePath: string }) => f.filePath === fileB)
    expect(entryA).toBeDefined()
    expect(entryB).toBeDefined()
    expect(entryA.baseDir).toBe(rootA)
    expect(entryB.baseDir).toBe(rootB)
    expect(entryA.ingested).toBe(true)
    expect(entryB.ingested).toBe(true)
    expect(entryA.chunkCount).toBeGreaterThan(0)
    expect(entryB.chunkCount).toBeGreaterThan(0)
  })

  // AC interpretation: [AC-008/AC-011] query_documents returns chunks ingested under any effective root through the single shared DB
  // Validation: A query that semantically matches doc-b under rootB returns at least one chunk whose filePath equals fileB
  it('query_documents returns chunks ingested from any effective root', async () => {
    const result = await server.handleQueryDocuments({
      query: 'gravitational waves spacetime ripples',
      limit: 5,
    })
    const parsed = JSON.parse(result.content[0].text)
    const fileBHits = parsed.filter((r: { filePath: string }) => r.filePath === fileB)
    expect(fileBHits.length).toBeGreaterThan(0)
  }, 30000)

  // AC interpretation: [AC-008] read_chunk_neighbors works against a file ingested under a non-first root
  // Validation: Calling read_chunk_neighbors on fileB (rootB) returns at least one item with isTarget=true at chunkIndex 0
  it('read_chunk_neighbors returns chunks for a file ingested under a non-first root', async () => {
    const result = await server.handleReadChunkNeighbors({ filePath: fileB, chunkIndex: 0 })
    const parsed = JSON.parse(result.content[0].text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    const target = parsed.find((row: { isTarget: boolean }) => row.isTarget === true)
    expect(target).toBeDefined()
    expect(target.filePath).toBe(fileB)
  }, 30000)

  // AC interpretation: [AC-008] delete_file scoped to one root removes only that file's chunks; the other root's chunks remain
  // Validation: After deleting fileA, list_files shows fileA with ingested=false (file still on disk under rootA) and fileB still ingested=true
  it('delete_file under one root leaves the other root untouched', async () => {
    await server.handleDeleteFile({ filePath: fileA })

    const result = await server.handleListFiles()
    const parsed = JSON.parse(result.content[0].text)

    const entryA = parsed.files.find((f: { filePath: string }) => f.filePath === fileA)
    const entryB = parsed.files.find((f: { filePath: string }) => f.filePath === fileB)
    expect(entryA).toBeDefined()
    expect(entryA.ingested).toBe(false)
    expect(entryB).toBeDefined()
    expect(entryB.ingested).toBe(true)
    expect(entryB.chunkCount).toBeGreaterThan(0)
  }, 30000)
})

// =============================================================================
// AC-009 (raw-data path): ingest_data response shape unchanged in multi-root
// =============================================================================
describe('AC-009: ingest_data behavior unchanged in multi-root mode (warnings additive)', () => {
  const testBase = resolve('./tmp/test-multi-root-raw-data')
  const rootA = resolve(testBase, 'rootA')
  const rootB = resolve(testBase, 'rootB')
  const dbPath = resolve(testBase, 'lancedb')
  const cacheDir = resolve(testBase, 'cache')

  let server: RAGServer

  // Mirrors the precedence-warning string emitted by resolveBaseDirs so the
  // additive-warning assertion below is anchored to the real warning text.
  const PRECEDENCE_WARNING =
    'BASE_DIRS is set; BASE_DIR is ignored. Unset BASE_DIR or remove BASE_DIRS to silence this warning.'

  beforeAll(async () => {
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })

    server = new RAGServer({
      dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir,
      baseDirs: [rootA, rootB],
      maxFileSize: 100 * 1024 * 1024,
      configWarnings: [PRECEDENCE_WARNING],
    })
    await server.initialize()
  }, 60000)

  afterAll(async () => {
    await server.close()
    rmSync(testBase, { recursive: true, force: true })
  })

  // AC interpretation: [AC-009] ingest_data preserves its single-root response shape (filePath/chunkCount/timestamp/fileTitle)
  // even when the server is configured with multiple roots; warnings are an ADDITIVE content block.
  // Validation: Primary content block parses to IngestResult-shaped JSON with chunkCount>0 and filePath under dbPath/raw-data;
  // the warning block appears alongside but does not alter the primary block.
  it('ingest_data raw-data response shape is unchanged; warning block is additive', async () => {
    const result = await server.handleIngestData({
      content:
        'Raw-data ingestion in multi-root mode. ' +
        'This content is long enough to clear the minimum chunk filter and produce at least one chunk. ' +
        'It exists solely to confirm that ingest_data behavior is unaffected by multi-root configuration.',
      metadata: {
        source: 'clipboard://2026-05-23/multi-root-raw-data',
        format: 'text',
      },
    })

    // Primary block: same shape as single-root contract.
    const primary = result.content[0]
    expect(primary.type).toBe('text')
    const parsed = JSON.parse(primary.text)
    expect(parsed.chunkCount).toBeGreaterThan(0)
    expect(typeof parsed.timestamp).toBe('string')
    expect(typeof parsed.filePath).toBe('string')
    // Raw-data path lives under dbPath/raw-data — confirms ingest_data did not
    // accidentally route through any root's filesystem.
    expect(parsed.filePath.startsWith(resolve(dbPath))).toBe(true)
    expect(parsed.filePath).toContain('raw-data')

    // Warning block is additive.
    const warningBlock = findBlock(result.content as ContentBlock[], PRECEDENCE_WARNING)
    expect(warningBlock).toBeDefined()
  }, 60000)

  // AC interpretation: [AC-008] Raw-data ingested via ingest_data is reported under `sources`, not under per-root `files`,
  // even when multiple roots are configured. Confirms the producing-root annotation is intentionally absent for raw-data.
  // Validation: list_files response after ingest_data contains the source under `sources` (no `baseDir` annotation) and
  // no raw-data filePath leaks into the per-root `files` array.
  it('list_files routes raw-data under sources (no baseDir annotation) in multi-root mode', async () => {
    // Idempotent — beforeAll might have ingested already in another test order;
    // we re-ingest with a distinct source to keep this test independent.
    await server.handleIngestData({
      content:
        'A second raw-data document for the multi-root sources routing assertion. ' +
        'This sentence pads the document so it clears the minimum chunk filter.',
      metadata: {
        source: 'clipboard://2026-05-23/multi-root-raw-data-sources',
        format: 'text',
      },
    })

    const result = await server.handleListFiles()
    const parsed = JSON.parse(result.content[0].text)

    const sourceEntry = parsed.sources.find(
      (s: { source?: string }) => s.source === 'clipboard://2026-05-23/multi-root-raw-data-sources'
    )
    expect(sourceEntry).toBeDefined()
    expect(sourceEntry.baseDir).toBeUndefined()

    const rawDataLeaks = parsed.files.filter((f: { filePath: string }) =>
      f.filePath.includes('raw-data')
    )
    expect(rawDataLeaks).toHaveLength(0)
  }, 60000)
})

// =============================================================================
// AC-003 + AC-013: real `resolveBaseDirs` produces precedence + pruning
// warnings that surface in tool responses end-to-end.
// =============================================================================
describe('AC-003/AC-013: real resolveBaseDirs warnings surface in MCP responses', () => {
  const testBase = resolve('./tmp/test-multi-root-real-warnings')
  const rootA = resolve(testBase, 'rootA')
  const rootB = resolve(testBase, 'rootB')
  const nestedChild = resolve(rootA, 'nested-child')
  const legacyBase = resolve(testBase, 'legacy-base-dir')
  const dbPath = resolve(testBase, 'lancedb')
  const cacheDir = resolve(testBase, 'cache')

  beforeAll(() => {
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    mkdirSync(nestedChild, { recursive: true })
    mkdirSync(legacyBase, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(testBase, { recursive: true, force: true })
  })

  // AC interpretation: [AC-003] When BASE_DIRS and BASE_DIR are both set with no CLI override, BASE_DIRS wins and a
  // precedence warning is surfaced via MCP responses (not only stderr).
  // Validation: Real resolveBaseDirs run with both envs set produces a precedence-warning content block in status output,
  // and the server's effective roots equal the BASE_DIRS value (BASE_DIR is ignored).
  it('BASE_DIRS > BASE_DIR precedence warning is surfaced via status content (real resolver)', async () => {
    const { server, warnings } = await buildServerFromResolver({
      dbPath,
      cacheDir,
      envBaseDirs: JSON.stringify([rootA, rootB]),
      envBaseDir: legacyBase,
      cwd: testBase,
    })

    try {
      await server.initialize()

      // Resolver produced the precedence warning.
      const precedence = warnings.find((w) => w.includes('BASE_DIRS is set; BASE_DIR is ignored'))
      expect(precedence).toBeDefined()

      // Effective baseDirs came from BASE_DIRS, not BASE_DIR.
      const listed = await server.handleListFiles()
      const parsed = JSON.parse(listed.content[0].text)
      // realpath-normalized roots have a trailing separator — match prefix.
      expect(parsed.baseDirs).toHaveLength(2)
      expect(parsed.baseDirs[0].startsWith(realpathSync(rootA))).toBe(true)
      expect(parsed.baseDirs[1].startsWith(realpathSync(rootB))).toBe(true)
      // BASE_DIR was ignored.
      expect(parsed.baseDirs.some((b: string) => b.startsWith(realpathSync(legacyBase)))).toBe(
        false
      )

      // Warning content block visible on status response.
      const status = await server.handleStatus()
      const warnBlock = findBlock(
        status.content as ContentBlock[],
        'BASE_DIRS is set; BASE_DIR is ignored'
      )
      expect(warnBlock).toBeDefined()
    } finally {
      await server.close()
    }
  }, 60000)

  // AC interpretation: [AC-013] Nested-root pruning warnings emitted by resolveBaseDirs are visible via tool response
  // content blocks (not only CLI stderr).
  // Validation: With BASE_DIRS=[parent, child-of-parent], the resolver prunes the child and emits a warning whose text
  // appears in list_files content; the effective baseDirs contain only the parent root.
  it('nested-root pruning warning surfaces via list_files content (real resolver)', async () => {
    const { server, warnings } = await buildServerFromResolver({
      dbPath,
      cacheDir,
      envBaseDirs: JSON.stringify([rootA, nestedChild]),
      cwd: testBase,
    })

    try {
      await server.initialize()

      // Resolver produced a nested-pruned warning.
      const pruned = warnings.find((w) => w.includes('Nested base directory pruned'))
      expect(pruned).toBeDefined()

      // Effective baseDirs include only the parent root.
      const listed = await server.handleListFiles()
      const parsed = JSON.parse(listed.content[0].text)
      expect(parsed.baseDirs).toHaveLength(1)
      expect(parsed.baseDirs[0].startsWith(realpathSync(rootA))).toBe(true)

      // Warning content block visible on list_files response.
      const warnBlock = findBlock(listed.content as ContentBlock[], 'Nested base directory pruned')
      expect(warnBlock).toBeDefined()
    } finally {
      await server.close()
    }
  }, 60000)

  // AC interpretation: [AC-011] dbPath/cacheDir auto-exclusion remains effective for MCP scans across every root configured via env.
  // Validation: With two roots configured via real BASE_DIRS and a supported file placed inside dbPath, list_files does not
  // include that file (exclusion applies uniformly across roots even when roots are env-resolved).
  it('dbPath/cacheDir exclusion still applies across env-resolved roots', async () => {
    // Place a supported file inside dbPath that would otherwise match the filter.
    const dbInternal = join(dbPath, 'internal-supported.txt')
    writeFileSync(dbInternal, 'should not appear')

    const { server } = await buildServerFromResolver({
      dbPath,
      cacheDir,
      envBaseDirs: JSON.stringify([rootA, rootB]),
      cwd: testBase,
    })

    try {
      await server.initialize()
      const listed = await server.handleListFiles()
      const parsed = JSON.parse(listed.content[0].text)
      const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
      expect(filePaths).not.toContain(dbInternal)
    } finally {
      await server.close()
      rmSync(dbInternal, { force: true })
    }
  }, 60000)
})

// =============================================================================
// Finding #10 (post-launch review): list_files survives a permission-denied
// error on one root and emits a per-root warning instead of failing the
// whole call. Mocks `node:fs/promises.readdir` so this is deterministic
// across CI environments — the production code under test is the new BFS
// loop in `scanBaseDir`.
// =============================================================================
describe('post-launch finding #10: list_files per-root error tolerance', () => {
  const testBase = resolve('./tmp/test-list-files-per-root-err')
  const rootA = resolve(testBase, 'rootA')
  const rootB = resolve(testBase, 'rootB')
  const dbPath = resolve(testBase, 'lancedb')
  const cacheDir = resolve(testBase, 'cache')

  beforeAll(() => {
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(resolve(rootB, 'survives.md'), 'a small markdown file under the accessible root')
  })

  afterAll(() => {
    // Restore permissions before tearing down so rmSync can recurse.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').chmodSync(rootA, 0o755)
    } catch {
      // Ignore — chmod may fail if rootA was already removed.
    }
    rmSync(testBase, { recursive: true, force: true })
  })

  it('list_files surfaces files from accessible roots when another root is inaccessible', async () => {
    // Make rootA unreadable using chmod so `readdir(rootA)` throws EACCES
    // at the syscall layer (Linux/macOS only; Windows skips this test).
    // We rely on the bounded BFS new in Finding #10 to capture the error
    // as a per-root warning and keep scanning rootB.
    if (process.platform === 'win32') return

    const { chmodSync } = await import('node:fs')
    chmodSync(rootA, 0o000)

    const server = new RAGServer({
      dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir,
      baseDirs: [rootA, rootB],
      maxFileSize: 100 * 1024 * 1024,
    })
    await server.initialize()
    try {
      const result = await server.handleListFiles()
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
      // rootB's file survives even though rootA failed.
      expect(filePaths).toContain(resolve(rootB, 'survives.md'))
      // Warning content block names the failing root via `displayPath`
      // (HOME prefix is collapsed to `~` to avoid leaking the OS username
      // through MCP responses; see Finding #10 sanitization).
      const warningBlock = findBlock(
        result.content as ContentBlock[],
        `cannot read directory: ${displayPath(rootA)}`
      )
      expect(warningBlock).toBeDefined()
      // The raw OS error message must not leak into the warning text.
      expect(warningBlock?.text ?? '').not.toContain('permission denied')
    } finally {
      await server.close()
      // Restore permissions so afterAll's rmSync can recurse.
      chmodSync(rootA, 0o755)
    }
  }, 60000)
})

// =============================================================================
// Finding #3 + Finding #4 (post-launch review): the MCP server entry point
// must apply the sensitive-path policy to env-resolved roots and must not
// fall back to cwd on a config error.
//
// These tests exercise `startServer`-equivalent wiring directly — we replicate
// the relevant section of `server-main.ts` here so the assertion is anchored
// to the same logic the production entry point runs.
// =============================================================================
describe('post-launch findings #3 + #4: server-main wiring rejects sensitive roots and never falls back to cwd', () => {
  const testBase = resolve('./tmp/test-server-main-policy')
  const dbPath = resolve(testBase, 'lancedb')
  const cacheDir = resolve(testBase, 'cache')

  beforeAll(() => {
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(testBase, { recursive: true, force: true })
  })

  /**
   * Mirror of the env-resolution branch in `src/server-main.ts` so the test
   * exercises the same wiring without invoking `startServer` (which calls
   * `process.exit` on errors and starts the MCP transport — both unsafe
   * inside a vitest worker). The body MUST stay in sync with `server-main.ts`.
   */
  async function buildServerLikeMain(opts: {
    envBaseDirs?: string | undefined
    envBaseDir?: string | undefined
  }): Promise<{ server: RAGServer; configError: BaseDirsConfigError | undefined }> {
    const { checkSensitivePath } = await import('../../utils/sensitive-path.js')
    const { BaseDirsConfigError, parseBaseDirsEnv: parseEnv } = await import(
      '../../utils/base-dirs.js'
    )

    // Pre-check raw user-supplied paths (mirrors server-main.ts, Finding #3).
    const rawSensitiveErrors: string[] = []
    if (opts.envBaseDirs !== undefined && opts.envBaseDirs.length > 0) {
      const parsed = parseEnv(opts.envBaseDirs)
      if (parsed.ok) {
        for (const raw of parsed.value) {
          const sensitive = checkSensitivePath(raw, 'BASE_DIRS')
          if (sensitive) rawSensitiveErrors.push(sensitive)
        }
      }
    } else if (opts.envBaseDir !== undefined && opts.envBaseDir.trim().length > 0) {
      const sensitive = checkSensitivePath(opts.envBaseDir, 'BASE_DIR')
      if (sensitive) rawSensitiveErrors.push(sensitive)
    }

    const baseDirsResult = await resolveBaseDirs({
      envBaseDirs: opts.envBaseDirs,
      envBaseDir: opts.envBaseDir,
      cwd: testBase,
    })

    const warnings: string[] = []
    let baseDirs: string[]
    let configError: BaseDirsConfigError | undefined

    if (baseDirsResult.ok) {
      const sourceFlag =
        opts.envBaseDirs !== undefined && opts.envBaseDirs.length > 0 ? 'BASE_DIRS' : 'BASE_DIR'
      const sensitiveErrors: string[] = [...rawSensitiveErrors]
      for (const root of baseDirsResult.config.baseDirs) {
        const sensitive = checkSensitivePath(root, sourceFlag)
        if (sensitive) sensitiveErrors.push(sensitive)
      }
      if (sensitiveErrors.length > 0) {
        baseDirs = []
        configError = new BaseDirsConfigError([...new Set(sensitiveErrors)].join('; '))
        warnings.push(configError.message)
      } else {
        baseDirs = baseDirsResult.config.baseDirs
        for (const w of baseDirsResult.warnings) warnings.push(w.message)
      }
    } else {
      baseDirs = []
      configError = baseDirsResult.error
      warnings.push(baseDirsResult.error.message)
    }

    const server = new RAGServer({
      dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir,
      baseDirs,
      maxFileSize: 100 * 1024 * 1024,
      configWarnings: warnings,
      ...(configError !== undefined ? { configError } : {}),
    })

    return { server, configError }
  }

  // AC: BASE_DIRS=["/etc"] must NOT be silently accepted by server-main.
  // The server enters degraded mode (configError set, baseDirs empty); root-
  // dependent tools fail fast; `status` surfaces the diagnostic.
  it('rejects BASE_DIRS=["/etc"] as a sensitive system path (degraded mode)', async () => {
    const { server, configError } = await buildServerLikeMain({
      envBaseDirs: JSON.stringify(['/etc']),
    })

    expect(configError).toBeDefined()
    expect(configError?.message).toMatch(/sensitive system path/)
    expect(configError?.message).toContain('BASE_DIRS')

    // baseDirs MUST be empty: no silent cwd fallback.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDirs).toEqual([])

    // Root-dependent tool: must fail fast.
    await expect(server.handleListFiles()).rejects.toBeInstanceOf(McpError)

    // status: must remain callable and expose the diagnostic.
    await server.initialize()
    try {
      const status = await server.handleStatus()
      const diagnostic = findBlock(status.content as ContentBlock[], 'Configuration error:')
      expect(diagnostic).toBeDefined()
      expect(diagnostic?.text).toMatch(/sensitive system path/)
    } finally {
      await server.close()
    }
  }, 60000)

  // AC: BASE_DIR=/usr (single-root sensitive path) is likewise rejected and
  // attributed to BASE_DIR (not BASE_DIRS).
  it('rejects BASE_DIR=/usr as a sensitive system path attributed to BASE_DIR', async () => {
    const { server, configError } = await buildServerLikeMain({ envBaseDir: '/usr' })

    expect(configError).toBeDefined()
    expect(configError?.message).toMatch(/sensitive system path/)
    expect(configError?.message).toContain('BASE_DIR')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDirs).toEqual([])
  })
})

// =============================================================================
// AC-010: invalid BASE_DIRS end-to-end via real resolveBaseDirs.
// `status` callable; root-dependent tools throw structured McpError.
// =============================================================================
describe('AC-010: invalid BASE_DIRS end-to-end (real resolveBaseDirs)', () => {
  const testBase = resolve('./tmp/test-multi-root-invalid')
  const dbPath = resolve(testBase, 'lancedb')
  const cacheDir = resolve(testBase, 'cache')

  beforeAll(() => {
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(testBase, { recursive: true, force: true })
  })

  // AC interpretation: [AC-010] Invalid BASE_DIRS does not silently fall back: root-dependent tools must error with the
  // resolver's structured message, while status remains callable and exposes the same message as a diagnostic block.
  // Validation: With BASE_DIRS set to non-JSON garbage, list_files throws McpError carrying the resolver's error text,
  // and status returns a content array containing a "Configuration error: ..." block with that same text.
  it('list_files throws McpError; status remains callable and exposes the same diagnostic', async () => {
    const { server, configError } = await buildServerFromResolver({
      dbPath,
      cacheDir,
      envBaseDirs: 'not-a-valid-json-array',
      cwd: testBase,
    })

    // Resolver returned a structured error and stashed it on the server.
    expect(configError).toBeDefined()
    expect(configError?.message).toMatch(/BASE_DIRS/)

    try {
      await server.initialize()

      // Root-dependent tool: throws structured McpError with the resolver's message.
      const listError = await server
        .handleListFiles()
        .then(() => null)
        .catch((e) => e)
      expect(listError).toBeInstanceOf(McpError)
      expect((listError as Error).message).toMatch(/BASE_DIRS/)

      // status remains callable and surfaces the configError as a diagnostic block.
      const status = await server.handleStatus()
      const diagnostic = findBlock(status.content as ContentBlock[], 'Configuration error:')
      expect(diagnostic).toBeDefined()
      expect(diagnostic?.text).toMatch(/BASE_DIRS/)
    } finally {
      await server.close()
    }
  }, 60000)

  // AC interpretation: [AC-010] Root-dependent tools — the ones that read or
  // write through `baseDirs` — fail fast with the resolver's structured error
  // end-to-end. After the post-launch scope review, the fail-fast set is
  // narrower than every tool: `query_documents` (DB only) and `ingest_data`
  // (DB + dbPath/raw-data only) operate without reading any configured root,
  // so they MUST remain callable in degraded mode. The `source`-mode branches
  // of `delete_file` / `read_chunk_neighbors` likewise route around the
  // configured roots and stay callable. `filePath` mode for either dual-mode
  // tool, plus `ingest_file` and `list_files`, fail fast.
  it('root-dependent tools (filePath/list/ingest_file) fail fast with the resolver error message', async () => {
    const { server } = await buildServerFromResolver({
      dbPath,
      cacheDir,
      envBaseDirs: '{"not":"an array"}',
      cwd: testBase,
    })

    try {
      // No need to initialize — the assertConfigOk() guard fires before any
      // DB access for the fail-fast set, so we can skip the heavy
      // initialize() path for this case.

      await expect(server.handleIngestFile({ filePath: '/tmp/x.txt' })).rejects.toBeInstanceOf(
        McpError
      )
      await expect(server.handleDeleteFile({ filePath: '/tmp/x.txt' })).rejects.toBeInstanceOf(
        McpError
      )
      await expect(
        server.handleReadChunkNeighbors({ filePath: '/tmp/x.txt', chunkIndex: 0 })
      ).rejects.toBeInstanceOf(McpError)
      await expect(server.handleListFiles()).rejects.toBeInstanceOf(McpError)
    } finally {
      // Do not close — server was never initialized.
    }
  })
})
