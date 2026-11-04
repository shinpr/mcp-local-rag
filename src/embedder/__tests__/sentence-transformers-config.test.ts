import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRegistry, PretrainedConfig } from '@huggingface/transformers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadSentenceTransformersConfig,
  resolveModelSettings,
} from '../sentence-transformers-config.js'

const MODEL = 'org/model'
const PIPELINE_OPTIONS = {
  config: new PretrainedConfig({}),
  dtype: 'fp32',
  device: 'cpu',
} as const
const CONFIG = { prompts: { query: 'Q: ' } }

describe('loadSentenceTransformersConfig', () => {
  let cacheDir: string
  let savedPath: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'st-config-'))
    savedPath = join(cacheDir, MODEL, 'config_sentence_transformers.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(cacheDir, { recursive: true, force: true })
  })

  function stubModelCached(cached: boolean): void {
    vi.spyOn(ModelRegistry, 'is_pipeline_cached').mockResolvedValue(cached)
  }

  it('reads the saved file without fetching when the model is cached', async () => {
    stubModelCached(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await mkdir(join(cacheDir, MODEL), { recursive: true })
    await writeFile(savedPath, JSON.stringify(CONFIG))

    const config = await loadSentenceTransformersConfig(MODEL, cacheDir, PIPELINE_OPTIONS)

    expect(config).toEqual(CONFIG)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null without fetching when the model is cached with no saved file', async () => {
    stubModelCached(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const config = await loadSentenceTransformersConfig(MODEL, cacheDir, PIPELINE_OPTIONS)

    expect(config).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null and logs when the saved file is not JSON', async () => {
    stubModelCached(true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mkdir(join(cacheDir, MODEL), { recursive: true })
    await writeFile(savedPath, '{')

    const config = await loadSentenceTransformersConfig(MODEL, cacheDir, PIPELINE_OPTIONS)

    expect(config).toBeNull()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('fetches and saves the file while the model is not cached', async () => {
    stubModelCached(false)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(CONFIG), { status: 200 }))

    const config = await loadSentenceTransformersConfig(MODEL, cacheDir, PIPELINE_OPTIONS)

    expect(config).toEqual(CONFIG)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://huggingface.co/org/model/resolve/main/config_sentence_transformers.json'
    )
    expect(JSON.parse(await readFile(savedPath, 'utf8'))).toEqual(CONFIG)
  })

  it('returns null and saves nothing when the model has no file', async () => {
    stubModelCached(false)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))

    const config = await loadSentenceTransformersConfig(MODEL, cacheDir, PIPELINE_OPTIONS)

    expect(config).toBeNull()
    await expect(readFile(savedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns null and logs once when the fetch fails', async () => {
    stubModelCached(false)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const config = await loadSentenceTransformersConfig(MODEL, cacheDir, PIPELINE_OPTIONS)

    expect(config).toBeNull()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('fetch failed')
  })
})

describe('resolveModelSettings', () => {
  it('resolves each role the way sentence-transformers selects prompts', () => {
    const settings = resolveModelSettings(MODEL, {
      prompts: { query: 'Q: ', corpus: 'C: ', passage: 'P: ', Clustering: 'CL: ' },
      default_prompt_name: 'Clustering',
    })

    expect(settings.prompts).toEqual({ query: 'Q: ', document: 'P: ', default: 'CL: ' })
  })

  it('takes the document prompt before passage and corpus', () => {
    const settings = resolveModelSettings(MODEL, {
      prompts: { corpus: 'C: ', passage: 'P: ', document: 'D: ' },
    })

    expect(settings.prompts.document).toBe('D: ')
  })

  it('uses no prompts when the config is absent, null-named, or mistyped', () => {
    const empty = { query: '', document: '', default: '' }

    expect(resolveModelSettings(MODEL, null).prompts).toEqual(empty)
    expect(
      resolveModelSettings(MODEL, { prompts: { query: 'Q: ' }, default_prompt_name: null }).prompts
        .default
    ).toBe('')
    expect(resolveModelSettings(MODEL, { prompts: { query: 1, document: ['D'] } }).prompts).toEqual(
      empty
    )
  })

  it.each([{ similarity_fn_name: 'manhattan' }, { model_type: 'SparseEncoder' }])(
    'warns about unsupported setting %o',
    (config) => {
      const { warnings } = resolveModelSettings(MODEL, config)

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(MODEL)
    }
  )

  it.each([
    {},
    { similarity_fn_name: 'cosine' },
    { similarity_fn_name: 'dot' },
    { similarity_fn_name: 'euclidean' },
    { model_type: 'SentenceTransformer' },
  ])('does not warn about supported setting %o', (config) => {
    expect(resolveModelSettings(MODEL, config).warnings).toEqual([])
  })
})
