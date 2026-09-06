// `runList(--scope)` non-absolute-prefix warning (code-review finding #2).
//
// AC: The `list` help documents that `--scope` must be absolute and a relative
//     prefix matches nothing. This test pins the CLI UX signal: a non-absolute
//     `--scope` prints a non-fatal stderr warning while STILL exiting 0 with a
//     (correctly empty for that prefix) result — relative is unhelpful, not an
//     error. Absolute `--scope` prints no such warning and returns its results.
// Behavior: `runList(['--scope', <relative>])` over a real LanceDB + real-FS
//     fixture (uningested scan, no embedder) → non-absolute prefix filtered by
//     `nonAbsolutePrefixes` and printed as a `Warning [scope]:` stderr line,
//     process exits 0, stdout result stays empty for that prefix; absolute
//     `--scope` emits no such warning and returns its scanned files[].
// ROI: 80
// @category: integration
// @lane: integration
// @dependency: CLI runList + real LanceDB + real-FS fixture (no embedder)
// @complexity: low (no mocks; real dbPath/cacheDir + uningested scan fixture)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runList } from '../../cli/list.js'
import type { GlobalOptions } from '../../cli/options.js'

const NON_ABSOLUTE_WARNING = /Warning \[scope\]: "([^"]+)" is not an absolute path/

function warnedPrefixes(stderr: string[]): string[] {
  const prefixes: string[] = []
  for (const line of stderr) {
    const match = NON_ABSOLUTE_WARNING.exec(line)
    if (match?.[1] !== undefined) {
      prefixes.push(match[1])
    }
  }
  return prefixes
}

/**
 * Run `runList` capturing stdout writes and stderr, with `process.exit` mocked
 * to throw so a non-zero exit surfaces as a caught error rather than killing the
 * test runner.
 */
/** Everything one captured `runList` invocation produced. */
interface CapturedRun {
  stdout: string[]
  stderr: string[]
  error: unknown
}

function captureRunList(args: string[], globalOptions: GlobalOptions) {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return true
    })
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
  return runList(args, globalOptions)
    .then((): CapturedRun => ({ stdout, stderr, error: undefined }))
    .catch((error: unknown): CapturedRun => ({ stdout, stderr, error }))
    .finally(() => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
    })
}

describe('runList(--scope) — non-absolute prefix warning (finding #2)', () => {
  const base = resolve('./tmp/test-cli-list-nonabs-warning')
  const dataDir = join(base, 'data')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')
  const inScopeFile = join(dataDir, 'keep.txt')
  const globalOptions = { dbPath, cacheDir, modelName: 'Xenova/all-MiniLM-L6-v2' }

  beforeAll(() => {
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(inScopeFile, 'A scannable file. '.repeat(20))
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('warns on stderr for a relative --scope but still exits 0 with an empty result', async () => {
    const { stdout, stderr, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', 'relative'],
      globalOptions
    )

    // No exit thrown → exit 0 (relative is unhelpful, not an error).
    expect(error).toBeUndefined()
    expect(warnedPrefixes(stderr)).toContain('relative')

    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
    expect(filePaths).not.toContain(inScopeFile)
  })

  it('emits no non-absolute warning for an absolute --scope and returns its results', async () => {
    const { stdout, stderr, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', dataDir],
      globalOptions
    )

    expect(error).toBeUndefined()
    expect(warnedPrefixes(stderr)).toEqual([])

    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
    expect(filePaths).toContain(inScopeFile)
  })

  it('warns only for the relative prefix in a mixed --scope and keeps absolute results', async () => {
    const { stdout, stderr, error } = await captureRunList(
      ['--base-dir', dataDir, '--scope', dataDir, '--scope', 'relative'],
      globalOptions
    )

    expect(error).toBeUndefined()
    expect(warnedPrefixes(stderr)).toEqual(['relative'])

    const parsed = JSON.parse(stdout.join(''))
    const filePaths: string[] = parsed.files.map((f: { filePath: string }) => f.filePath)
    expect(filePaths).toContain(inScopeFile)
  })
})
