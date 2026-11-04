// Embedder text-only model config tests
//
// Text embedding never runs a model's vision or audio encoder. These tests
// assert which model config the Embedder hands to the model load and to the
// cache check, using the real transformers.js config and file listing. Only
// the network/disk boundaries (config download, model load, cache lookup) are
// mocked.
//
// Mock isolation: `@huggingface/transformers` is imported by the real-pipeline
// tests, so the factory is installed with `vi.doMock` in `beforeAll` and removed
// with `vi.doUnmock` + `vi.resetModules` in `afterAll` (project-context rule).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../utils/type-guards.js'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  pipeline: vi.fn(),
  isPipelineCached: vi.fn(),
}))

const transformersFactory = async (
  importOriginal: () => Promise<typeof import('@huggingface/transformers')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    AutoConfig: { from_pretrained: mocks.loadConfig },
    pipeline: mocks.pipeline,
    ModelRegistry: {
      get_model_files: actual.ModelRegistry.get_model_files,
      is_pipeline_cached: mocks.isPipelineCached,
    },
  }
}

const MOCKED_PATHS = ['@huggingface/transformers'] as const
const MODEL_PATH = 'org/text-only-config-model'

// Transformers.js loads this model's encoders only while their configs exist.
const OPTIONAL_ENCODER_CONFIG = {
  model_type: 'embedding_gemma2',
  architectures: ['EmbeddingGemma2Model'],
  text_config: { hidden_size: 8, max_position_embeddings: 2048 },
  vision_config: { hidden_size: 4 },
  audio_config: { hidden_size: 4 },
}

// This model reads `vision_config` while embedding text.
const REQUIRED_VISION_CONFIG = {
  model_type: 'jina_clip',
  architectures: ['JinaCLIPModel'],
  vision_config: { image_size: 224 },
}

let Embedder: typeof import('../../embedder/index.js').Embedder
let transformers: typeof import('@huggingface/transformers')

function loadedConfigArgument(call: unknown[] | undefined): Record<string, unknown> {
  const options = call?.[2]
  if (!isRecord(options) || !isRecord(options['config'])) {
    throw new Error('Expected options carrying a model config')
  }
  return options['config']
}

describe('Embedder text-only model config', () => {
  let cacheDir: string
  let previousCacheDir: string | null

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    ;({ Embedder } = await import('../../embedder/index.js'))
    transformers = await import('@huggingface/transformers')
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) {
      vi.doUnmock(p)
    }
    vi.resetModules()
  })

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'text-only-config-'))
    previousCacheDir = transformers.env.cacheDir
    mocks.pipeline.mockResolvedValue(vi.fn())
    mocks.isPipelineCached.mockResolvedValue(true)
  })

  afterEach(async () => {
    mocks.loadConfig.mockReset()
    mocks.pipeline.mockReset()
    mocks.isPipelineCached.mockReset()
    // `initialize()` points the shared transformers.js cache at this test's directory.
    transformers.env.cacheDir = previousCacheDir
    await rm(cacheDir, { recursive: true, force: true })
  })

  async function initializeWith(configJson: Record<string, unknown>): Promise<void> {
    mocks.loadConfig.mockResolvedValue(new transformers.PretrainedConfig(configJson))
    const embedder = new Embedder({ modelPath: MODEL_PATH, batchSize: 4, cacheDir })
    await embedder.initialize()
  }

  it('loads the model and checks its cache without encoders transformers.js can skip', async () => {
    await initializeWith(OPTIONAL_ENCODER_CONFIG)

    const loaded = loadedConfigArgument(mocks.pipeline.mock.calls[0])
    expect(loaded['vision_config']).toBeNull()
    expect(loaded['audio_config']).toBeNull()
    expect(loaded['text_config']).toEqual(OPTIONAL_ENCODER_CONFIG.text_config)
    expect(loadedConfigArgument(mocks.isPipelineCached.mock.calls[0])).toBe(loaded)
  })

  it('keeps encoder configs a model needs for text embedding', async () => {
    await initializeWith(REQUIRED_VISION_CONFIG)

    const loaded = loadedConfigArgument(mocks.pipeline.mock.calls[0])
    expect(loaded['vision_config']).toEqual(REQUIRED_VISION_CONFIG.vision_config)
    expect(loadedConfigArgument(mocks.isPipelineCached.mock.calls[0])).toBe(loaded)
  })
})
