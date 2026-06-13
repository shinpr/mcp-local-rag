// AC-009 (PRIMARY REGRESSION) — the original dtype×PDF masking symptom.
//
// Symptom (pre-fix): ingesting a PDF while the embedder failed to load with an
// explicit-but-unavailable `RAG_DTYPE` surfaced the misleading client message
// `Failed to ingest file: Failed to parse PDF: <path>` — the real embedder
// dtype problem was masked as a PDF parse failure.
//
// Fix (Tasks 01-04): the embedder's enriched `EmbeddingError` (an `AppError`)
// keeps its identity through `parsePdf` and the gutted handler, and the central
// dispatcher mapper renders it to the client as `InternalError` with the
// embedder's enriched dtype message — NOT a PDF parse failure.
//
// This test is MOCK-BASED by design (AC-009): it must NOT depend on a real
// model / Hub / cache.
//   - `@huggingface/transformers` is mocked so the REAL `Embedder.initialize()`
//     hits a load failure (`pipeline` throws) and the REAL
//     `enrichDtypeFailureMessage` runs against a mocked `ModelRegistry` whose
//     available dtypes EXCLUDE the requested one — producing the genuine
//     enriched message rather than a hand-fabricated string.
//   - `mupdf` is mocked so the PDF "parses" (yielding page text) without any
//     real document engine, so the embedder — invoked during page-1 title
//     chunking — is the first and only failure point.
//
// Test-env constraint (project-context: vitest `isolate:false`, `pool:'forks'`,
// `maxWorkers:1` → a SHARED module registry). The embedder is a widely-imported
// shared module, so a top-level `vi.mock` would leak its mocked
// `@huggingface/transformers` into sibling suites and break them. Per the
// documented repo pattern (see `parser.test.ts` / `parsePdf-foreign-error.test.ts`)
// this uses `vi.hoisted` factories + `beforeAll` `vi.resetModules()`+`vi.doMock`
// + dynamic `import()`, torn down with `afterAll` `vi.doUnmock`+`vi.resetModules()`.
// `RAGServer`, `EmbeddingError`, and the SDK error types are imported from the
// SAME post-`resetModules` graph so `instanceof`/`isAppError` identity holds.
// Validate with the FULL `pnpm test` suite, not single-file, to confirm no leak.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'

// ============================================
// Mocks (hoisted so the doMock factories can reference them)
// ============================================

const { mockPipeline, mockGetAvailableDtypes, mockOpenDocument } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  mockGetAvailableDtypes: vi.fn(),
  mockOpenDocument: vi.fn(),
}))

// Minimal `@huggingface/transformers` surface used by `src/embedder/index.ts`:
// `pipeline`, `env` (cacheDir setter), and `ModelRegistry.get_available_dtypes`.
const transformersFactory = () => ({
  pipeline: mockPipeline,
  env: { cacheDir: '' },
  ModelRegistry: { get_available_dtypes: mockGetAvailableDtypes },
})

// Minimal single-page mupdf document. A single page means
// `filterPageBoundarySentences` returns early WITHOUT touching the embedder,
// so the embedder's first invocation is the page-1 title chunking inside
// `parsePdf` — exactly the original symptom's failure point.
const mupdfFactory = () => ({
  Document: { openDocument: mockOpenDocument },
})

const MOCKED_PATHS = ['@huggingface/transformers', 'mupdf'] as const

let RAGServer: typeof import('../index.js').RAGServer
let EmbeddingError: typeof import('../../embedder/index.js').EmbeddingError
let McpError: typeof import('@modelcontextprotocol/sdk/types.js').McpError
let ErrorCode: typeof import('@modelcontextprotocol/sdk/types.js').ErrorCode

type DispatchResult = { content: { type: string; text: string }[] }
type RegisteredHandler = (
  request: { method: string; params: { name: string; arguments?: unknown } },
  extra: { signal: AbortSignal }
) => Promise<DispatchResult>

// Invoke the registered CallTool dispatcher closure directly (the boundary that
// owns the central try/catch + `toMcpError`). Mirrors the accessor pattern used
// in `rag-server.dispatcher-mapping.test.ts`.
function dispatch(
  server: InstanceType<typeof RAGServer>,
  name: string,
  args: unknown
): Promise<DispatchResult> {
  const internals = server as unknown as {
    server: { _requestHandlers: Map<string, RegisteredHandler> }
  }
  const handler = internals.server._requestHandlers.get('tools/call')
  if (handler === undefined) throw new Error('tools/call handler not registered')
  return handler(
    { method: 'tools/call', params: { name, arguments: args } },
    { signal: new AbortController().signal }
  )
}

describe('AC-009: dtype×PDF protocol regression (mock-based, no real model/Hub/cache)', () => {
  const testDbPath = resolve('./tmp/test-lancedb-dtype-pdf-regression')
  const testDataDir = resolve('./tmp/test-data-dtype-pdf-regression')
  const modelPath = 'Xenova/all-MiniLM-L6-v2'
  const requestedDtype = 'q4'
  const availableDtypes = ['fp32', 'fp16', 'q8']
  // The exact enriched text the REAL `enrichDtypeFailureMessage` builds when the
  // requested dtype is absent from the model's available dtypes.
  const expectedEnriched = `Model "${modelPath}" provides dtypes [${availableDtypes.join(', ')}]; requested dtype "${requestedDtype}" is unavailable. Set RAG_DTYPE to one of the available dtypes, or leave it unset for the fp32 default.`

  let server: InstanceType<typeof RAGServer>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    vi.doMock('mupdf', mupdfFactory)
    ;({ RAGServer } = await import('../index.js'))
    ;({ EmbeddingError } = await import('../../embedder/index.js'))
    ;({ McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js'))

    // Embedder model load fails (e.g. unavailable dtype), and the model's
    // available-dtype enumeration EXCLUDES the requested dtype → the real
    // enrichment produces `expectedEnriched`.
    mockPipeline.mockRejectedValue(new Error('Could not load model with dtype q4'))
    mockGetAvailableDtypes.mockResolvedValue(availableDtypes)

    // Single-page PDF doc: yields page text so parsing succeeds up to the point
    // where the embedder is invoked for page-1 title chunking.
    const mockPage = {
      getBounds: vi.fn().mockReturnValue([0, 0, 612, 792]),
      toStructuredText: vi.fn().mockReturnValue({
        asJSON: vi.fn().mockReturnValue(
          JSON.stringify({
            blocks: [
              {
                type: 'text',
                lines: [
                  {
                    text: 'This document has enough body text to produce a chunk for embedding.',
                    x: 72,
                    y: 100,
                    font: { size: 12 },
                  },
                ],
              },
            ],
          })
        ),
      }),
    }
    mockOpenDocument.mockReturnValue({
      countPages: vi.fn().mockReturnValue(1),
      loadPage: vi.fn().mockReturnValue(mockPage),
      getMetaData: vi.fn().mockReturnValue(''),
      destroy: vi.fn(),
    })

    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })

    server = new RAGServer(
      withTestDevice({
        dbPath: testDbPath,
        modelName: modelPath,
        cacheDir: testModelCacheDir(),
        baseDir: testDataDir,
        maxFileSize: 100 * 1024 * 1024,
        // Explicit dtype gates the enrichment path (TD-5): only an explicitly-set
        // dtype triggers `enrichDtypeFailureMessage`.
        dtype: requestedDtype,
      })
    )
    // `initialize()` only touches the vector store; the embedder is lazily
    // initialized on first use (during ingest), which is where it fails.
    await server.initialize()
  })

  afterAll(async () => {
    await server.close()
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('surfaces the enriched embedder dtype message as InternalError, NOT a masked "Failed to parse PDF"', async () => {
    const pdfPath = resolve(testDataDir, 'dtype-regression.pdf')
    writeFileSync(pdfPath, 'dummy-pdf-bytes')

    let thrown: unknown
    try {
      await dispatch(server, 'ingest_file', { filePath: pdfPath })
      throw new Error('expected ingest_file to reject')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(McpError)
    const err = thrown as InstanceType<typeof McpError>
    // Code is InternalError (EmbeddingError kind 'internal').
    expect(err.code).toBe(ErrorCode.InternalError)
    // The client message carries the REAL enriched dtype text.
    expect(err.message).toContain(expectedEnriched)
    // The original masking symptom is gone: no "Failed to parse PDF" relabel,
    // and no "Failed to ingest file" prefix (an AppError stays prefix-less).
    expect(err.message).not.toContain('Failed to parse PDF')
    expect(err.message).not.toContain('Failed to ingest file')
  })

  it('the underlying embedder failure is a genuine enriched EmbeddingError (identity preserved through the PDF path)', async () => {
    const pdfPath = resolve(testDataDir, 'dtype-regression-identity.pdf')
    writeFileSync(pdfPath, 'dummy-pdf-bytes')

    // Call the handler directly (no dispatcher mapping) to prove the embedder's
    // enriched EmbeddingError reaches the boundary with its ORIGINAL identity,
    // rather than being relabeled as a FileOperationError("Failed to parse PDF").
    let thrown: unknown
    try {
      await server.handleIngestFile({ filePath: pdfPath })
      throw new Error('expected handleIngestFile to reject')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(EmbeddingError)
    expect((thrown as InstanceType<typeof EmbeddingError>).message).toBe(expectedEnriched)
  })
})
