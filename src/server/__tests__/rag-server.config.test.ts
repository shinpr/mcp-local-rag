// RAGServer configuration shape tests (P3-T1)
//
// Verifies that RAGServerConfig accepts both the legacy `{ baseDir }` shape
// and the new `{ baseDirs }` shape, that resolver warnings are stored on the
// server instance for later attachment (P3-T3), and that a config error
// puts the server in a degraded mode where `status` is still callable.
//
// Note: these are pure construction tests (no DB or embedder traffic). They
// only assert on the constructor wiring and on `handleStatus`, which avoids
// the heavy initialize() / vectorStore.connect() path.

import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BaseDirsConfigError } from '../../utils/base-dirs.js'
import { RAGServer } from '../index.js'

describe('RAGServerConfig shape compatibility (P3-T1)', () => {
  const testDbPath = resolve('./tmp/test-lancedb-config-shape')
  const testDataDir = resolve('./tmp/test-data-config-shape')
  const testDataDirB = resolve('./tmp/test-data-config-shape-b')

  beforeAll(() => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    mkdirSync(testDataDirB, { recursive: true })
  })

  afterAll(() => {
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
    rmSync(testDataDirB, { recursive: true, force: true })
  })

  it('accepts the legacy { baseDir } shape', () => {
    const server = new RAGServer({
      dbPath: testDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDir: testDataDir,
      maxFileSize: 100 * 1024 * 1024,
    })
    // Legacy single-root: baseDirs should expose [baseDir].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDirs).toEqual([testDataDir])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDir).toBe(testDataDir)
  })

  it('accepts the new { baseDirs } shape (multi-root)', () => {
    const server = new RAGServer({
      dbPath: testDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDirs: [testDataDir, testDataDirB],
      maxFileSize: 100 * 1024 * 1024,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDirs).toEqual([testDataDir, testDataDirB])
    // Legacy baseDir field is the first effective root.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDir).toBe(testDataDir)
  })

  it('stores configWarnings on the instance for later attachment', () => {
    const warnings = [
      'BASE_DIRS is set; BASE_DIR is ignored. Unset BASE_DIR or remove BASE_DIRS to silence this warning.',
    ]
    const server = new RAGServer({
      dbPath: testDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDirs: [testDataDir],
      maxFileSize: 100 * 1024 * 1024,
      configWarnings: warnings,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).configWarnings).toEqual(warnings)
  })

  it('is constructible with configError in degraded mode and exposes empty baseDirs', () => {
    // Post-Finding-#4: server-main.ts no longer falls back to `[cwd()]` on
    // configError. The server stays constructible with `baseDirs: []` so
    // `status` remains callable, and downstream guards (`assertConfigOk`,
    // parser fail-close) keep every root-dependent code path inert.
    const configError = new BaseDirsConfigError(
      'BASE_DIRS must be a JSON array of non-empty path strings.'
    )
    const server = new RAGServer({
      dbPath: testDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDirs: [],
      maxFileSize: 100 * 1024 * 1024,
      configError,
    })
    // The configError must be reachable from the instance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).configError).toBe(configError)
    // The internal baseDirs MUST be empty (no silent cwd fallback).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any).baseDirs).toEqual([])
  })

  it('rejects construction with an empty baseDirs array when configError is absent', () => {
    // Without configError, empty `baseDirs` is misconfiguration: the
    // constructor must throw rather than silently build a parser that
    // rejects every path.
    expect(
      () =>
        new RAGServer({
          dbPath: testDbPath,
          modelName: 'Xenova/all-MiniLM-L6-v2',
          cacheDir: './tmp/models',
          baseDirs: [],
          maxFileSize: 100 * 1024 * 1024,
        })
    ).toThrow(/non-empty `baseDirs` array/)
  })

  it('parser constructed with empty baseDirs fails closed on validateFilePath', async () => {
    // Defense-in-depth: even when a handler bypasses `assertConfigOk`, the
    // parser must reject every path under degraded mode.
    const configError = new BaseDirsConfigError(
      'BASE_DIRS must be a JSON array of non-empty path strings.'
    )
    const server = new RAGServer({
      dbPath: testDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: './tmp/models',
      baseDirs: [],
      maxFileSize: 100 * 1024 * 1024,
      configError,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parser = (server as any).parser
    await expect(parser.validateFilePath('/tmp/anything.txt')).rejects.toThrow(
      /No configured base directory/
    )
  })
})
