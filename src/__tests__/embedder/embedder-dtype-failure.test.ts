// Embedder dtype failure-path enrichment unit tests
// Test Type: Unit Test (mocks the @huggingface/transformers `pipeline` and
// `ModelRegistry.get_available_dtypes` boundaries)
//
// These tests exercise `Embedder.initialize()`'s catch path when the model load
// fails. The model load (`pipeline`) is external I/O, and the dtype enumeration
// (`ModelRegistry.get_available_dtypes`) is a Hub network call — both are mocked
// at the external boundary. The tests assert the thrown `EmbeddingError` message
// per branch (TD-3) and that enumeration is skipped when dtype is unset (the
// `config.dtype !== undefined` gate), and that the call ALWAYS throws (TD-2).
//
// Mock isolation: `@huggingface/transformers` is imported by the real-pipeline
// integration tests in `embedder.test.ts`. Under the shared module registry
// (vitest `isolate:false`, `pool:'forks'`, `maxWorkers:1`), a top-level
// `vi.mock` would leak into those tests. Per the project-context mock-isolation
// rule, the factory is installed with `vi.doMock` in `beforeAll` and removed
// with `vi.doUnmock` + `vi.resetModules` in `afterAll`, with `Embedder`
// imported dynamically afterwards.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { testModelCacheDir } from '../test-device.js'

const mocks = vi.hoisted(() => {
  return {
    pipeline: vi.fn(),
    getAvailableDtypes: vi.fn(),
  }
})

const transformersFactory = () => ({
  pipeline: mocks.pipeline,
  // `env` is mutated by `initialize()` (sets cacheDir); a plain object suffices.
  env: {} as { cacheDir?: string },
  ModelRegistry: {
    get_available_dtypes: mocks.getAvailableDtypes,
  },
})

const MOCKED_PATHS = ['@huggingface/transformers'] as const

let Embedder: typeof import('../../embedder/index.js').Embedder
let EmbeddingError: typeof import('../../embedder/index.js').EmbeddingError

const MODEL_PATH = 'Xenova/all-MiniLM-L6-v2'
const LOAD_FAILURE_MESSAGE = 'Could not locate file: onnx/model_fp16.onnx'

function makeEmbedder(dtype?: string) {
  return new Embedder({
    modelPath: MODEL_PATH,
    batchSize: 16,
    cacheDir: testModelCacheDir(),
    ...(dtype !== undefined ? { dtype } : {}),
  })
}

function asError(value: unknown): Error {
  if (!(value instanceof Error)) {
    throw new Error(`expected a thrown Error, but the call resolved with: ${String(value)}`)
  }
  return value
}

describe('Embedder dtype failure-path enrichment', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    ;({ Embedder, EmbeddingError } = await import('../../embedder/index.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  afterEach(() => {
    mocks.pipeline.mockReset()
    mocks.getAvailableDtypes.mockReset()
  })

  it('names the available dtypes when an explicit dtype is unavailable and enumeration succeeds', async () => {
    mocks.pipeline.mockRejectedValue(new Error(LOAD_FAILURE_MESSAGE))
    mocks.getAvailableDtypes.mockResolvedValue(['fp32', 'q8', 'int8'])
    const embedder = makeEmbedder('fp16')

    const err = asError(await embedder.initialize().catch((e) => e))

    expect(err).toBeInstanceOf(EmbeddingError)
    // Enumeration was consulted with the model path.
    expect(mocks.getAvailableDtypes).toHaveBeenCalledWith(MODEL_PATH)
    // Message identifies the requested dtype and lists what the model provides.
    expect(err.message).toMatch(/fp16/)
    expect(err.message).toMatch(/fp32/)
    expect(err.message).toMatch(/q8/)
    expect(err.message).toMatch(/int8/)
    expect(err.message).toMatch(/unavailable/i)
  })

  it('throws a generic clear dtype-aware message when enumeration fails (offline)', async () => {
    mocks.pipeline.mockRejectedValue(new Error(LOAD_FAILURE_MESSAGE))
    mocks.getAvailableDtypes.mockRejectedValue(new Error('getaddrinfo ENOTFOUND huggingface.co'))
    const embedder = makeEmbedder('fp16')

    const err = asError(await embedder.initialize().catch((e) => e))

    expect(err).toBeInstanceOf(EmbeddingError)
    expect(mocks.getAvailableDtypes).toHaveBeenCalledWith(MODEL_PATH)
    // The message references the requested dtype so it is dtype-aware, but does
    // NOT leak the enumeration's own failure as a confusing secondary error.
    expect(err.message).toMatch(/fp16/)
    expect(err.message).not.toMatch(/ENOTFOUND/)
  })

  it('does not enumerate dtypes when the requested dtype IS available (still throws the load error)', async () => {
    mocks.pipeline.mockRejectedValue(new Error(LOAD_FAILURE_MESSAGE))
    mocks.getAvailableDtypes.mockResolvedValue(['fp32', 'fp16', 'q8'])
    const embedder = makeEmbedder('fp16')

    const err = asError(await embedder.initialize().catch((e) => e))

    expect(err).toBeInstanceOf(EmbeddingError)
    // The requested dtype is in the list → no enriched "unavailable" claim; the
    // native load error message is preserved (no false attribution to dtype).
    expect(err.message).toContain(LOAD_FAILURE_MESSAGE)
    expect(err.message).not.toMatch(/unavailable/i)
  })

  it('does not enumerate dtypes when dtype is unset and re-throws the load error verbatim', async () => {
    mocks.pipeline.mockRejectedValue(new Error(LOAD_FAILURE_MESSAGE))
    const embedder = makeEmbedder()

    const err = asError(await embedder.initialize().catch((e) => e))

    expect(err).toBeInstanceOf(EmbeddingError)
    // The unset gate (`config.dtype !== undefined`) must skip enumeration so a
    // non-dtype failure adds zero network on the normal-operation path.
    expect(mocks.getAvailableDtypes).not.toHaveBeenCalled()
    expect(err.message).toBe(LOAD_FAILURE_MESSAGE)
  })
})
