// Embedder dtype-wiring and init-retry unit tests
//
// These tests assert the dtype argument the Embedder hands to the transformers.js
// `pipeline` call, and that a failed lazy initialization can be retried on the
// same instance. The model load is external I/O (network/model download), so the
// `pipeline` boundary is mocked to control it without downloading a model.
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
import { asDouble } from '../test-doubles.js'

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
  env: asDouble<Record<string, string | undefined>>({}),
  AutoConfig: { from_pretrained: async () => ({}) },
  PretrainedConfig: class {},
  ModelRegistry: { is_pipeline_cached: async () => true, get_model_files: async () => [] },
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
    for (const p of MOCKED_PATHS) {
      vi.doUnmock(p)
    }
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

  it('retries initialization on the same instance after a failed lazy init', async () => {
    const tokenizer = Object.assign((texts: string[]) => ({ input_ids: texts.map(() => [1]) }), {
      model_max_length: 512,
    })
    const loadedPipeline = Object.assign(
      async (texts: string[]) => ({
        data: Float32Array.from([0.25, 0.5, 0.75]),
        dims: [texts.length, 3],
      }),
      { tokenizer }
    )
    mocks.pipeline
      .mockRejectedValueOnce(new Error('transient load failure'))
      .mockResolvedValueOnce(loadedPipeline)
    const embedder = makeEmbedder()

    await expect(embedder.embed('first')).rejects.toThrow('transient load failure')
    await expect(embedder.embed('second')).resolves.toEqual([0.25, 0.5, 0.75])
    expect(mocks.pipeline).toHaveBeenCalledTimes(2)
  })
})
