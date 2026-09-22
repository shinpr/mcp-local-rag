// External reranking: hand the search candidates to a configured command and
// take its response as an ordering over them.
//
// Every failure mode degrades to the ordering the caller already had, the way
// the FTS fallback in `VectorStore.searchWithKeywordBoost` does. A reranker is
// an improvement to ranking, so a broken one must not fail the request; a
// process that fails to start arrives as an `error` event, and leaving that
// unhandled would take the server process down.

import { spawn } from 'node:child_process'
import { errorCode } from '../utils/type-guards.js'
import { buildRerankArgv, parseRerankCommand } from './command.js'
import { type RerankResult, validateRerankResponse } from './response.js'

export type { RerankResult } from './response.js'

/** One rerank call: the results to hand over, and the command that handles them. */
export interface RerankRequest {
  /** Search results in their pre-rerank order. Returned as-is on failure. */
  candidates: RerankResult[]
  /** Query text, substituted for `{query}` in configured argument templates. */
  query: string
  /** Result count the caller wants, substituted for `{top}`. */
  top: number
  /** Configured executable and argument template. */
  command: string
  /** Per-call budget. The spawned process is killed when it elapses. */
  timeoutMs: number
}

type ChildRun = { ok: true; stdout: string } | { ok: false; reason: string }

/** Complete results in `docs/schema/query-output.schema.json` form. */
function buildRerankPayload(candidates: RerankResult[]): string {
  return JSON.stringify(candidates)
}

/**
 * A missing command, one without execute permission, and a `.cmd` / `.bat` shim
 * on Windows all land here. The operator would otherwise just see reranking not
 * happening, so the line says what the command has to be. Only the error's code
 * is reported: its message repeats the executable.
 */
function spawnFailureReason(error: unknown): string {
  return `the command could not be started (${errorCode(error) ?? 'unknown error'}); it must name a directly executable file, not a .cmd or .bat shim`
}

function runRerankCommand(
  executable: string,
  argv: string[],
  payload: string,
  timeoutMs: number
): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve) => {
    let settled = false
    const stdoutChunks: string[] = []
    let timer: NodeJS.Timeout | undefined

    const finish = (result: ChildRun): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      // No shell on any platform: rendered arguments go straight to spawn and
      // nothing can splice them back into a command string. `stderr` is ignored
      // because the child is untrusted and could otherwise write document text
      // into this server's log stream.
      child = spawn(executable, argv, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (error) {
      finish({ ok: false, reason: spawnFailureReason(error) })
      return
    }

    // The budget itself ends the call. A child that traps the signal, or one
    // whose descendant holds the inherited stdout open, never emits `close`, so
    // waiting for the kill to land would leave the request pending for as long
    // as the child felt like running. Its stdout is dropped and the handle is
    // unreferenced so nothing it does afterwards reaches or holds this server.
    timer = setTimeout(() => {
      child.kill()
      child.stdout?.destroy()
      child.unref()
      finish({ ok: false, reason: `the command timed out after ${timeoutMs}ms and was killed` })
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string): void => {
      stdoutChunks.push(chunk)
    })
    // A child that exits before reading its input makes this write fail; the
    // exit itself is what gets reported.
    child.stdin?.on('error', (): void => {})
    child.stdin?.end(payload)

    child.on('error', (error): void => {
      finish({ ok: false, reason: spawnFailureReason(error) })
    })
    child.on('close', (code, signal): void => {
      if (code === 0) {
        finish({ ok: true, stdout: stdoutChunks.join('') })
        return
      }
      const outcome = code === null ? `was terminated by ${signal}` : `exited with code ${code}`
      finish({ ok: false, reason: `the command ${outcome}` })
    })
  })
}

function fallback<T>(candidates: T[], reason: string): T[] {
  console.error(`Rerank: ${reason}; returning the pre-rerank ordering`)
  return candidates
}

/**
 * What the command produced, or the results unchanged when it could not run or
 * answered with something that is not a valid result set. Never throws.
 */
export async function rerankCandidates(request: RerankRequest): Promise<RerankResult[]> {
  const { candidates, query, top, command, timeoutMs } = request
  const parsed = parseRerankCommand(command)
  if (parsed === undefined) {
    return fallback(candidates, 'the configured command is empty or has invalid quoting')
  }

  const run = await runRerankCommand(
    parsed.executable,
    buildRerankArgv(parsed, query, top),
    buildRerankPayload(candidates),
    timeoutMs
  )
  if (!run.ok) {
    return fallback(candidates, run.reason)
  }

  const validated = validateRerankResponse(run.stdout)
  return validated.ok ? validated.results : fallback(candidates, validated.reason)
}
