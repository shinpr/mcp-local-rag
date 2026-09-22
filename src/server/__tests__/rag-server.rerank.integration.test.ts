// Handler-path behaviour of the rerank step, against a real spawned child.
//
// The child is a generated Node script rather than a mocked `spawn`: what this
// task has to prove -- the candidate count the search is asked for, the order
// the response ends up in, the trim, and attachments still following their own
// result -- is observable only in what the child receives and what the handler
// returns after a real run.
//
// `VectorStore.search` and the embedder are stubbed so the candidate set is
// fixed; the search stub honours the `limit` it is given, as the real one does,
// so candidate expansion and the trim are both visible in the response.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import { expectDefined, parseJson, privateMembers } from '../../__tests__/test-doubles.js'
import type { Embedder } from '../../embedder/index.js'
import { MAX_QUERY_LIMIT, RERANK_CANDIDATE_MULTIPLIER } from '../../utils/limits.js'
import type { SearchResult, VectorStore } from '../../vectordb/index.js'
import { RAGServer } from '../index.js'

const workDir = mkdtempSync(join(tmpdir(), 'rerank-handler-test-'))
const dbPath = resolve('./tmp/test-lancedb-rerank-handler')
const dataDir = resolve('./tmp/test-data-rerank-handler')
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

/** Child that would leave a marker behind; used to prove nothing was spawned. */
function markerReranker(markerPath: string): string {
  return `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(markerPath)}, 'spawned')
process.stdout.write('[]')
`
}

interface QueryResultShape {
  filePath: string
  chunkIndex: number
  text: string
  score: number
  fileTitle: string | null
}

interface AttachmentBlock {
  type: string
  result: { filePath: string; chunkIndex: number }
  imageIndex: number
  mimeType: string
}

function searchResult(index: number): SearchResult {
  return {
    id: `row-${index}`,
    filePath: join(dataDir, `doc-${index}.md`),
    chunkIndex: index,
    text: `body of chunk ${index}`,
    score: index / 100,
    metadata: { fileName: `doc-${index}.md`, fileSize: 100, fileType: 'md' },
    fileTitle: `Title ${index}`,
  }
}

const servers: RAGServer[] = []

function makeServer(rerank: { rerankCommand?: string; rerankTimeoutMs?: number } = {}): RAGServer {
  const server = new RAGServer(
    withTestDevice({
      dbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: testModelCacheDir(),
      baseDir: dataDir,
      maxFileSize: 100 * 1024 * 1024,
      ...rerank,
    })
  )
  servers.push(server)
  return server
}

function internals(server: RAGServer): { embedder: Embedder; vectorStore: VectorStore } {
  return privateMembers<{ embedder: Embedder; vectorStore: VectorStore }>(server)
}

type SearchSpy = MockInstance<VectorStore['search']>

/**
 * Stubs the search with a fixed candidate set, honouring the requested limit
 * the way `VectorStore.search` does, and returns the spy so the count the
 * handler asked for can be asserted.
 */
function stubSearch(server: RAGServer, candidates: SearchResult[]): SearchSpy {
  vi.spyOn(internals(server).embedder, 'embed').mockResolvedValue([0.1, 0.2, 0.3])
  return vi
    .spyOn(internals(server).vectorStore, 'search')
    .mockImplementation(async (_vector, options) => candidates.slice(0, options?.limit ?? 10))
}

function requestedLimit(spy: SearchSpy): number {
  const options = expectDefined(expectDefined(spy.mock.calls[0])[1])
  return expectDefined(options.limit)
}

/**
 * The stdin payload's contract is `docs/schema/query-output.schema.json`, so
 * the required property list is read from the schema itself and a property the
 * schema adds later fails here until it has a check. The type predicates are
 * transcribed from the schema's `properties`, independently of what the server
 * builds.
 */
const QUERY_RESULT_TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  filePath: (value) => typeof value === 'string',
  chunkIndex: (value) => Number.isInteger(value) && Number(value) >= 0,
  text: (value) => typeof value === 'string',
  score: (value) => typeof value === 'number',
  fileTitle: (value) => typeof value === 'string' || value === null,
  images: (value) => Array.isArray(value),
}

function itemViolations(item: unknown, required: readonly string[]): string[] {
  if (typeof item !== 'object' || item === null) {
    return ['is not an object']
  }
  const record: Record<string, unknown> = { ...item }
  return required.flatMap((property) => {
    const check = QUERY_RESULT_TYPE_CHECKS[property]
    if (check === undefined) {
      return [`no type check for required property ${property}`]
    }
    if (!Object.hasOwn(record, property)) {
      return [`missing ${property}`]
    }
    return check(record[property]) ? [] : [`${property} has the wrong type`]
  })
}

function schemaViolations(payload: unknown): string[] {
  const schema = parseJson<{ $defs: { queryResult: { required: string[] } } }>(
    readFileSync(resolve('docs/schema/query-output.schema.json'), 'utf8')
  )
  if (!Array.isArray(payload)) {
    return ['payload is not an array']
  }
  return payload.flatMap((item, index) =>
    itemViolations(item, schema.$defs.queryResult.required).map(
      (violation) => `item ${index}: ${violation}`
    )
  )
}

function resultsOf(content: readonly { type: string; text?: string }[]): QueryResultShape[] {
  const first = expectDefined(content[0])
  return parseJson<QueryResultShape[]>(expectDefined(first.text))
}

function identities(results: { filePath: string; chunkIndex: number }[]): string[] {
  return results.map((result) => `${result.filePath} ${result.chunkIndex}`)
}

let stderrSpy: MockInstance<typeof console.error>

function rerankStderrLines(): string[] {
  return stderrSpy.mock.calls
    .map((call) => call.join(' '))
    .filter((line) => line.startsWith('Rerank:'))
}

beforeEach(() => {
  mkdirSync(dbPath, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close()
  }
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(dbPath, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('handleQueryDocuments with no reranker configured', () => {
  // The regression guard for every existing user: an unset command has to leave
  // the search call, the ordering and the response exactly as they were.
  it('returns the search ordering unchanged, asks for no extra candidates, and runs no rerank', async () => {
    const server = makeServer()
    const candidates = [0, 1, 2, 3, 4, 5].map(searchResult)
    const searchSpy = stubSearch(server, candidates)

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 4 })

    expect(requestedLimit(searchSpy)).toBe(4)
    expect(identities(resultsOf(response.content))).toEqual(identities(candidates.slice(0, 4)))
    expect(rerankStderrLines()).toEqual([])
  })
})

describe('handleQueryDocuments with a reranker configured', () => {
  it('returns the candidates in the order the child gave, trimmed to limit', async () => {
    const server = makeServer({
      rerankCommand: fixtureCommand(recordingReranker(artifactPath('argv'), artifactPath('stdin'))),
    })
    const candidates = [0, 1, 2, 3, 4, 5].map(searchResult)
    stubSearch(server, candidates)

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 2 })

    expect(identities(resultsOf(response.content))).toEqual(
      identities([expectDefined(candidates[5]), expectDefined(candidates[4])])
    )
    expect(rerankStderrLines()).toEqual([])
  })

  it('runs the command on a single candidate, which filtering still acts on', async () => {
    const markerPath = join(workDir, 'single-candidate-marker.txt')
    const server = makeServer({ rerankCommand: fixtureCommand(markerReranker(markerPath)) })
    const candidates = [searchResult(0)]
    stubSearch(server, candidates)

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 5 })

    // The fixture answers with an empty set, which is the command's decision.
    expect(resultsOf(response.content)).toEqual([])
    expect(existsSync(markerPath)).toBe(true)
    expect(rerankStderrLines()).toEqual([])
  })

  it('takes an empty result set from the command as its answer', async () => {
    const server = makeServer({
      rerankCommand: fixtureCommand(`process.stdout.write('[]')`),
    })
    stubSearch(server, [0, 1, 2].map(searchResult))

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 5 })

    expect(resultsOf(response.content)).toEqual([])
    expect(rerankStderrLines()).toEqual([])
  })

  it('keeps a property the command added and text it rewrote', async () => {
    const server = makeServer({
      rerankCommand: fixtureCommand(`
import { readFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify([{ ...items[0], text: 'rewritten', rerankScore: 0.91 }]))
`),
    })
    stubSearch(server, [0, 1].map(searchResult))

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 5 })
    const results = resultsOf(response.content)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ text: 'rewritten', rerankScore: 0.91 })
  })

  it.each([
    { limit: 4, expected: 4 * RERANK_CANDIDATE_MULTIPLIER },
    { limit: MAX_QUERY_LIMIT, expected: MAX_QUERY_LIMIT },
  ])('asks the search for min(limit * 3, cap) candidates at limit $limit', async (testCase) => {
    const server = makeServer({
      rerankCommand: fixtureCommand(recordingReranker(artifactPath('argv'), artifactPath('stdin'))),
    })
    const searchSpy = stubSearch(
      server,
      Array.from({ length: MAX_QUERY_LIMIT }, (_unused, index) => searchResult(index))
    )

    await server.handleQueryDocuments({ query: 'chunks', limit: testCase.limit })

    expect(requestedLimit(searchSpy)).toBe(testCase.expected)
  })

  it('writes a stdin payload valid against the published query output schema', async () => {
    const stdinPath = artifactPath('stdin')
    const server = makeServer({
      rerankCommand: fixtureCommand(recordingReranker(artifactPath('argv'), stdinPath)),
    })
    stubSearch(server, [0, 1, 2].map(searchResult))

    await server.handleQueryDocuments({ query: 'chunks', limit: 2 })

    expect(schemaViolations(parseJson<unknown>(readFileSync(stdinPath, 'utf8')))).toEqual([])
  })

  it('renders custom flags and passes shell metacharacters as one argv element', async () => {
    const argvPath = artifactPath('argv')
    const server = makeServer({
      rerankCommand: fixtureCommand(
        recordingReranker(argvPath, artifactPath('stdin')),
        '--label "two words" --prompt {query} --limit {top}'
      ),
    })
    stubSearch(server, [0, 1, 2].map(searchResult))
    const query = 'chunks; rm -rf / && echo "$(whoami)" | tee /tmp/pwned'

    await server.handleQueryDocuments({ query, limit: 2 })

    expect(parseJson<string[]>(readFileSync(argvPath, 'utf8'))).toEqual([
      '--label',
      'two words',
      '--prompt',
      query,
      '--limit',
      '2',
    ])
  })

  // The failure this file exists to catch: reordering the serialized results
  // without reordering the SearchResults they are index-aligned with leaves
  // every text assertion passing while each image follows the wrong result.
  it('keeps each visual attachment with its own result after reranking', async () => {
    const server = makeServer({
      rerankCommand: fixtureCommand(recordingReranker(artifactPath('argv'), artifactPath('stdin'))),
    })
    const candidates = [0, 1, 2, 3].map(searchResult)
    stubSearch(server, candidates)
    const hydrationSpy = vi
      .spyOn(internals(server).vectorStore, 'hydrateVisualAttachments')
      .mockImplementation(async (rows) => ({
        rows: rows.map((row) => ({
          id: row.id,
          attachments: [
            {
              imageIndex: 0,
              mimeType: 'image/png' as const,
              data: Buffer.from(row.id).toString('base64'),
            },
          ],
        })),
        omittedCount: 0,
      }))

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 3 })

    const results = resultsOf(response.content)
    expect(identities(results)).toEqual(
      identities([
        expectDefined(candidates[3]),
        expectDefined(candidates[2]),
        expectDefined(candidates[1]),
      ])
    )
    // Hydration runs before the command, so every candidate is hydrated: the
    // command is handed complete results and decides what to keep.
    expect(expectDefined(hydrationSpy.mock.calls[0])[0].map((row) => row.id)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
    ])
    // Blocks after the results text: one attachment description and one image
    // per result, in result order.
    const describedIdentities: string[] = []
    const attachedRowIds: string[] = []
    for (const [index, block] of response.content.entries()) {
      if (index === 0 || block.type !== 'text') {
        continue
      }
      const described = parseJson<AttachmentBlock>(block.text)
      describedIdentities.push(`${described.result.filePath} ${described.result.chunkIndex}`)
      const image = expectDefined(response.content[index + 1])
      if (image.type !== 'image') {
        throw new Error('Expected an image block to follow its description')
      }
      attachedRowIds.push(Buffer.from(image.data, 'base64').toString('utf8'))
    }
    expect(describedIdentities).toEqual(identities(results))
    expect(attachedRowIds).toEqual(['row-3', 'row-2', 'row-1'])
  })
})

describe('handleQueryDocuments when the rerank child breaks its contract', () => {
  const rejectionCases: { name: string; command: () => string }[] = [
    {
      name: 'the command does not exist',
      command: () => join(workDir, 'no-such-reranker'),
    },
    {
      name: 'the command exits non-zero',
      command: () => fixtureCommand(`process.stdout.write('[]')\nprocess.exit(3)`),
    },
    {
      name: 'stdout is not JSON',
      command: () => fixtureCommand(`process.stdout.write('not json at all')`),
    },
    {
      name: 'stdout is JSON but not an array',
      command: () => fixtureCommand(`process.stdout.write('{"ranked":[]}')`),
    },
    {
      name: 'an item is missing a property the schema requires',
      command: () =>
        fixtureCommand(`
import { readFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(0, 'utf8'))
const { text, ...rest } = items[0]
process.stdout.write(JSON.stringify([rest]))
`),
    },
    {
      name: 'an item has a property of the wrong type',
      command: () =>
        fixtureCommand(`
import { readFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify([{ ...items[0], chunkIndex: 'first' }]))
`),
    },
    {
      name: 'an attachment declares an unsupported mimeType',
      command: () =>
        fixtureCommand(`
import { readFileSync } from 'node:fs'
const items = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify([{ ...items[0], images: [{ imageIndex: 0, mimeType: 'image/gif', data: 'x' }] }]))
`),
    },
  ]

  it.each(rejectionCases)(
    'returns the pre-rerank ordering and succeeds when $name',
    async (rejectionCase) => {
      const server = makeServer({ rerankCommand: rejectionCase.command() })
      const candidates = [0, 1, 2, 3].map(searchResult)
      stubSearch(server, candidates)

      const response = await server.handleQueryDocuments({ query: 'chunks', limit: 2 })

      expect(identities(resultsOf(response.content))).toEqual(
        identities([expectDefined(candidates[0]), expectDefined(candidates[1])])
      )
      expect(rerankStderrLines()).toHaveLength(1)
    }
  )

  // A shim is what an npm-installed reranker leaves on PATH, and Node refuses
  // to spawn one without a shell, so the operator needs the line to say so.
  it.skipIf(process.platform === 'win32')(
    'says the command must be directly executable when it names a .cmd shim',
    async () => {
      const shimPath = join(workDir, 'reranker-shim.cmd')
      writeFileSync(shimPath, '@echo off\r\n', { mode: 0o644 })
      const server = makeServer({ rerankCommand: shimPath })
      const candidates = [0, 1, 2].map(searchResult)
      stubSearch(server, candidates)

      const response = await server.handleQueryDocuments({ query: 'chunks', limit: 2 })

      expect(identities(resultsOf(response.content))).toEqual(
        identities([expectDefined(candidates[0]), expectDefined(candidates[1])])
      )
      expect(expectDefined(rerankStderrLines()[0])).toMatch(/directly executable/)
    }
  )

  it('kills the timed-out child, so no process outlives the request', async () => {
    const markerPath = join(workDir, 'outlived-the-kill.txt')
    const server = makeServer({
      rerankCommand: fixtureCommand(`
import { writeFileSync } from 'node:fs'
setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'still running')
  process.stdout.write('[]')
}, 1500)
`),
      rerankTimeoutMs: 200,
    })
    const candidates = [0, 1, 2].map(searchResult)
    stubSearch(server, candidates)

    const response = await server.handleQueryDocuments({ query: 'chunks', limit: 2 })

    expect(identities(resultsOf(response.content))).toEqual(
      identities([expectDefined(candidates[0]), expectDefined(candidates[1])])
    )
    expect(expectDefined(rerankStderrLines()[0])).toMatch(/timed out/)

    await new Promise((settle) => setTimeout(settle, 2000))
    expect(existsSync(markerPath)).toBe(false)
  })
})
