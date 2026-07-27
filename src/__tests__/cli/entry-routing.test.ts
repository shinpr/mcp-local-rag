// Smoke tests for the top-level CLI entry routing in src/index.ts.
// These spawn the entry as a real subprocess via tsx so we observe the
// actual exit codes and stderr surface that users see.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '../../..')
const ENTRY = resolve(PROJECT_ROOT, 'src/index.ts')

interface RunResult {
  status: number | null
  stderr: string
  stdout: string
}

function runCli(args: string[]): RunResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    timeout: 15000,
  })
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

describe('CLI entry routing', () => {
  it('rejects global CLI flags on the bare server launch and points at env vars', () => {
    const { status, stderr } = runCli(['--db-path', '/tmp/should-not-apply'])

    expect(status).toBe(1)
    expect(stderr).toContain('Global CLI options are not supported')
    expect(stderr).toContain('DB_PATH')
    expect(stderr).toContain('MODEL_NAME')
  })

  it('errors on unknown subcommands and lists the available commands', () => {
    const { status, stderr } = runCli(['definitely-not-a-command'])

    expect(status).toBe(1)
    expect(stderr).toContain('Unknown command:')
    expect(stderr).toContain('skills')
    expect(stderr).toContain('ingest')
    expect(stderr).toContain('read-neighbors')
  })

  it('lists sync among the available commands on an unknown subcommand', () => {
    const { status, stderr } = runCli(['definitely-not-a-command'])

    expect(status).toBe(1)
    expect(stderr).toContain('sync')
  })

  // Dispatch is proven through runSync's own stderr rather than a module mock:
  // `sync --help` is an output signature no other code path produces, so a
  // missing switch arm shows up as a silent exit-0 run with no usage text.
  it('routes sync to the sync command and forwards the arguments after it', () => {
    const { status, stderr } = runCli(['sync', '--help'])

    expect(status).toBe(0)
    expect(stderr).toContain('Usage: mcp-local-rag [global-options] sync [path]')
    expect(stderr.split('Usage: mcp-local-rag [global-options] sync [path]')).toHaveLength(2)
  })

  it('applies global options placed before sync to the sync run', () => {
    const { status, stderr } = runCli(['--db-path', '/etc/mcp-local-rag-should-not-apply', 'sync'])

    expect(status).toBe(1)
    expect(stderr).toContain('sensitive system path')
    expect(stderr).toContain('--db-path')
  })

  it('strips ANSI escape and control characters from the echoed unknown command', () => {
    const evil = '[31mboom[0m\r\n--inject'
    const { status, stderr } = runCli([evil])

    expect(status).toBe(1)
    expect(stderr).toContain('Unknown command:')
    // None of the control characters from the input should reach stderr verbatim.
    expect(stderr).not.toContain('[31m')
    expect(stderr).not.toContain('[0m')
  })
})
