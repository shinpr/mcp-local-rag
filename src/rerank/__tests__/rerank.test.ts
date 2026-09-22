// End-to-end behaviour of the rerank step against a real child process.
//
// The child is a generated Node script rather than a mocked `spawn`: what this
// task has to prove -- argv elements, the stdin payload, a killed process, and
// a request that survives every failure -- is observable only in what the child
// receives and leaves behind.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RerankResult, rerankCandidates } from '../index.js'

const workDir = mkdtempSync(join(tmpdir(), 'rerank-test-'))
let fixtureCount = 0

/** Writes a child script and returns a complete command template naming it directly. */
function fixtureCommand(source: string, configuredArgs = '--query {query} --top {top}'): string {
  fixtureCount += 1
  const scriptPath = join(workDir, `fixture-${fixtureCount}.mjs`)
  writeFileSync(scriptPath, source)
  return `${process.execPath} ${scriptPath}${configuredArgs ? ` ${configuredArgs}` : ''}`
}

function artifactPath(name: string): string {
  fixtureCount += 1
  return join(workDir, `${name}-${fixtureCount}.json`)
}

/** Child that records what it received and echoes the input back reversed. */
function recordingReranker(argvPath: string, stdinPath: string): string {
  return `
import { readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv))
writeFileSync(${JSON.stringify(stdinPath)}, stdin)
const topFlagIndex = argv.findIndex((argument) => argument === '--top' || argument === '--limit')
const top = Number(argv[topFlagIndex + 1])
const items = JSON.parse(stdin).reverse().slice(0, top)
process.stdout.write(JSON.stringify(items))
`
}

type TestCandidate = RerankResult

function candidate(id: string, chunkIndex: number): TestCandidate {
  return {
    filePath: join(workDir, `${id}.md`),
    chunkIndex,
    text: `confidential body of ${id}`,
    score: 0.25,
    fileTitle: `Title ${id}`,
    images: [],
  }
}

const candidates = [candidate('a', 0), candidate('b', 1), candidate('c', 2)]

function spyOnStderr() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

let stderrSpy: ReturnType<typeof spyOnStderr>

beforeEach(() => {
  stderrSpy = spyOnStderr()
})

afterEach(() => {
  stderrSpy.mockRestore()
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function stderrLines(): string[] {
  return stderrSpy.mock.calls.map((call) => call.join(' '))
}

describe('rerankCandidates with a cooperating child', () => {
  it("should return the server's own candidates in the child's order, trimmed to top", async () => {
    const command = fixtureCommand(recordingReranker(artifactPath('argv'), artifactPath('stdin')))

    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 2,
      command,
      timeoutMs: 5000,
    })

    expect(result).toEqual([candidates[2], candidates[1]])
    expect(stderrLines()).toEqual([])
  })

  it('should write a stdin payload carrying the candidate fields with empty images', async () => {
    const stdinPath = artifactPath('stdin')
    const command = fixtureCommand(recordingReranker(artifactPath('argv'), stdinPath))

    await rerankCandidates({ candidates, query: 'cats', top: 3, command, timeoutMs: 5000 })

    const payload = JSON.parse(readFileSync(stdinPath, 'utf8'))
    expect(payload).toEqual(
      candidates.map((item) => ({
        filePath: item.filePath,
        chunkIndex: item.chunkIndex,
        text: item.text,
        score: item.score,
        fileTitle: item.fileTitle,
        images: [],
      }))
    )
  })

  it('should render custom flags and pass shell metacharacters as one argv element', async () => {
    const argvPath = artifactPath('argv')
    const command = fixtureCommand(
      recordingReranker(argvPath, artifactPath('stdin')),
      '--label "two words" --prompt {query} --limit {top}'
    )
    const query = 'cats; rm -rf / && echo "$(whoami)" | tee /tmp/pwned'

    await rerankCandidates({ candidates, query, top: 3, command, timeoutMs: 5000 })

    expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual([
      '--label',
      'two words',
      '--prompt',
      query,
      '--limit',
      '3',
    ])
  })

  it('should pass the requested top through, not the candidate count', async () => {
    const argvPath = artifactPath('argv')
    const command = fixtureCommand(recordingReranker(argvPath, artifactPath('stdin')))

    const result = await rerankCandidates({
      candidates: candidates.slice(0, 2),
      query: 'cats',
      top: 10,
      command,
      timeoutMs: 5000,
    })

    const argv = JSON.parse(readFileSync(argvPath, 'utf8'))
    expect(argv[argv.indexOf('--top') + 1]).toBe('10')
    expect(result).toEqual([candidates[1], candidates[0]])
  })

  it('should run the command with no candidates and take its empty answer', async () => {
    const argvPath = artifactPath('argv')
    const command = fixtureCommand(recordingReranker(argvPath, artifactPath('stdin')))

    const result = await rerankCandidates({
      candidates: [],
      query: 'cats',
      top: 5,
      command,
      timeoutMs: 5000,
    })

    expect(result).toEqual([])
    expect(stderrLines()).toEqual([])
    const argv = JSON.parse(readFileSync(argvPath, 'utf8'))
    expect(argv[argv.indexOf('--top') + 1]).toBe('5')
  })
})

describe('rerankCandidates fallback', () => {
  it('should return the pre-rerank ordering when the command template has invalid quoting', async () => {
    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command: `${process.execPath} "unterminated`,
      timeoutMs: 5000,
    })

    expect(result).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
    expect(stderrLines()[0]).toMatch(/invalid quoting/)
  })

  it('should return the pre-rerank ordering when the command does not exist', async () => {
    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command: join(workDir, 'no-such-reranker'),
      timeoutMs: 5000,
    })

    expect(result).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
    expect(stderrLines()[0]).toMatch(/directly executable/)
  })

  it.skipIf(process.platform === 'win32')(
    'should say the command must be directly executable when it is not',
    async () => {
      const shimPath = join(workDir, 'reranker-shim.cmd')
      writeFileSync(shimPath, '@echo off\r\n', { mode: 0o644 })

      const result = await rerankCandidates({
        candidates,
        query: 'cats',
        top: 3,
        command: shimPath,
        timeoutMs: 5000,
      })

      expect(result).toEqual(candidates)
      expect(stderrLines()).toHaveLength(1)
      expect(stderrLines()[0]).toMatch(/directly executable/)
    }
  )

  it('should return the pre-rerank ordering when the command exits non-zero', async () => {
    const command = fixtureCommand(`
process.stderr.write('child diagnostics\\n')
process.stdout.write('[]')
process.exit(3)
`)

    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command,
      timeoutMs: 5000,
    })

    expect(result).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
    expect(stderrLines()[0]).toMatch(/3/)
  })

  it('should kill the spawned process when the timeout elapses', async () => {
    const markerPath = join(workDir, 'outlived-the-kill.txt')
    const command = fixtureCommand(`
import { writeFileSync } from 'node:fs'
setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'still running')
  process.stdout.write('[]')
}, 1500)
`)

    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command,
      timeoutMs: 200,
    })

    expect(result).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
    expect(stderrLines()[0]).toMatch(/timed out/)

    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(existsSync(markerPath)).toBe(false)
  })

  it('should fall back within the budget when the child ignores the kill signal', async () => {
    // A child that traps SIGTERM -- or one whose descendant holds the inherited
    // stdout open -- never emits `close`, so waiting for the child to end after
    // the kill would leave the request pending forever.
    const command = fixtureCommand(`
process.on('SIGTERM', () => {})
setTimeout(() => {
  process.stdout.write('[]')
}, 3000)
`)

    const call = rerankCandidates({ candidates, query: 'cats', top: 3, command, timeoutMs: 200 })
    const settledInBudget = await Promise.race([
      call.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
    ])

    expect(settledInBudget).toBe(true)
    expect(await call).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
    expect(stderrLines()[0]).toMatch(/timed out/)
  })

  it('should return the pre-rerank ordering when stdout is not JSON', async () => {
    const command = fixtureCommand(`process.stdout.write('not json at all')`)

    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command,
      timeoutMs: 5000,
    })

    expect(result).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
  })

  it('should take a repeated item as the command s answer', async () => {
    const command = fixtureCommand(`
import { readFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify([...items, items[0]]))
`)

    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command,
      timeoutMs: 5000,
    })

    expect(result).toHaveLength(candidates.length + 1)
    expect(stderrLines()).toHaveLength(0)
  })

  it('should carry neither document text nor the configured arguments on stderr', async () => {
    const command = fixtureCommand(
      `process.stdout.write('not json at all')`,
      '--api-token sk-not-a-real-token'
    )

    await rerankCandidates({ candidates, query: 'cats', top: 3, command, timeoutMs: 5000 })

    const line = stderrLines()[0] ?? ''
    expect(line).not.toContain('sk-not-a-real-token')
    expect(line).not.toContain('--api-token')
    for (const item of candidates) {
      expect(line).not.toContain(item.text)
    }
  })

  it('should return the pre-rerank ordering when the configured command is blank', async () => {
    const result = await rerankCandidates({
      candidates,
      query: 'cats',
      top: 3,
      command: '   ',
      timeoutMs: 5000,
    })

    expect(result).toEqual(candidates)
    expect(stderrLines()).toHaveLength(1)
  })
})
