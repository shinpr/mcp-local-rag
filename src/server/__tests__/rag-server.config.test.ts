// RAGServer degraded-mode construction guards (P3-T1)
//
// Empty `baseDirs` without a `configError` throws; with a `configError` the
// server stays constructible but the parser fails closed on every path.
//
// The config *shape* contract (baseDir/baseDirs wiring, configWarnings/
// configError) is verified observably via real handlers in
// rag-server.files.integration.test.ts (list_files) and
// rag-server.warning-visibility.test.ts, so it is not re-checked here.

import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testModelCacheDir } from '../../__tests__/test-device.js'
import { BaseDirsConfigError } from '../../utils/base-dirs.js'
import { RAGServer } from '../index.js'

describe('RAGServerConfig degraded-mode construction guards (P3-T1)', () => {
  const testDbPath = resolve('./tmp/test-lancedb-config-shape')

  beforeAll(() => {
    mkdirSync(testDbPath, { recursive: true })
  })

  afterAll(() => {
    rmSync(testDbPath, { recursive: true, force: true })
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
          cacheDir: testModelCacheDir(),
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
      cacheDir: testModelCacheDir(),
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
