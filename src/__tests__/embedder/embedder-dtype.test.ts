// Embedder dtype-wiring unit tests
// Test Type: Unit Test (mocks the @huggingface/transformers `pipeline` boundary)
//
// These tests assert the dtype argument the Embedder hands to the transformers.js
// `pipeline` call. The model load is external I/O (network/model download), so the
// `pipeline` boundary is mocked to capture the dtype without downloading a model.
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
    // The model returned by `pipeline`. Not exercised here (we only assert the
    // construction call), but must be a callable so any accidental `embed()` in
    // a future test does not explode obscurely.
    model: vi.fn(),
    pipeline: vi.fn(),
  }
})

const transformersFactory = () => ({
  pipeline: mocks.pipeline,
  // `env` is mutated by `initialize()` (sets cacheDir); a plain object suffices.
  env: {} as { cacheDir?: string },
})

const MOCKED_PATHS = ['@huggingface/transformers'] as const

let Embedder: typeof import('../../embedder/index.js').Embedder

const MODEL_PATH = 'Xenova/all-MiniLM-L6-v2'

function makeEmbedder(dtype?: string) {
  return new Embedder({
    modelPath: MODEL_PATH,
    batchSize: 16,
    cacheDir: testModelCacheDir(),
    ...(dtype !== undefined ? { dtype } : {}),
  })
}

describe('Embedder dtype wiring', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    ;({ Embedder } = await import('../../embedder/index.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  afterEach(() => {
    mocks.pipeline.mockReset()
  })

  it('defaults the pipeline dtype to fp32 when config.dtype is unset', async () => {
    mocks.pipeline.mockResolvedValue(mocks.model)
    const embedder = makeEmbedder()

    await embedder.initialize()

    expect(mocks.pipeline).toHaveBeenCalledOnce()
    const [task, modelPath, options] = mocks.pipeline.mock.calls[0] ?? []
    expect(task).toBe('feature-extraction')
    expect(modelPath).toBe(MODEL_PATH)
    expect(options).toEqual(expect.objectContaining({ dtype: 'fp32' }))
  })

  it('passes an explicit dtype through to the pipeline call', async () => {
    mocks.pipeline.mockResolvedValue(mocks.model)
    const embedder = makeEmbedder('q8')

    await embedder.initialize()

    expect(mocks.pipeline).toHaveBeenCalledOnce()
    const [, , options] = mocks.pipeline.mock.calls[0] ?? []
    expect(options).toEqual(expect.objectContaining({ dtype: 'q8' }))
  })

  it('passes an explicit fp32 through (not dropped) so the unset signal is distinct', async () => {
    mocks.pipeline.mockResolvedValue(mocks.model)
    const embedder = makeEmbedder('fp32')

    await embedder.initialize()

    const [, , options] = mocks.pipeline.mock.calls[0] ?? []
    expect(options).toEqual(expect.objectContaining({ dtype: 'fp32' }))
  })
})
