// `createCaptioner` (`quality` profile dispatch) unit test. Pins the
// Qwen3.5-2B surface contract owned by `src/pdf-visual/captioners/quality.ts`:
// model id and class, single-image processor call, long-edge input cap,
// generation options, prompt-token slicing, and load-failure wrapping.
//
// Cross-file mock isolation
// -------------------------
// `@huggingface/transformers` is also mocked by `captioner.test.ts`. Per the
// project-context skill rule for `isolate: false` + `pool: forks`, this file
// installs its factory via `vi.doMock` in `beforeAll` and removes it via
// `vi.doUnmock` + `vi.resetModules` in `afterAll`. The shared module
// registry is reset on both sides of the lifecycle so the two test files'
// mock surfaces do not leak across.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expectDefined,
  expectError,
  expectInstanceOf,
  expectRecord,
} from '../../__tests__/test-doubles.js'

// ============================================
// Mocks (vi.hoisted — required for `@huggingface/transformers`)
// ============================================

const mocks = vi.hoisted(() => {
  const state: {
    decodedWidth: number
    decodedHeight: number
    decodedText: string
    fromPretrainedThrows: Error | null
    generateThrows: Error | null
    fromBlobThrows: Error | null
    resizeThrows: Error | null
  } = {
    decodedWidth: 2000,
    decodedHeight: 1000,
    decodedText: 'a valid quality caption',
    fromPretrainedThrows: null,
    generateThrows: null,
    fromBlobThrows: null,
    resizeThrows: null,
  }

  const mockProcessorFromPretrained = vi.fn(async (_modelName: string, _options: unknown) => {
    if (state.fromPretrainedThrows) {
      throw state.fromPretrainedThrows
    }
    return mockProcessorInstance
  })

  const mockModelFromPretrained = vi.fn(async (_modelName: string, _options: unknown) => {
    if (state.fromPretrainedThrows) {
      throw state.fromPretrainedThrows
    }
    return mockModelInstance
  })

  // A leading batch dim so `dims.at(-1)` hits the intended index.
  const mockProcessorInstance = Object.assign(
    vi.fn(async (_chatPrompt: string, _image: unknown) => ({
      input_ids: { dims: [1, 7] },
      attention_mask: {},
      pixel_values: {},
    })),
    {
      apply_chat_template: vi.fn((_messages: unknown, _opts: unknown) => 'CHAT_PROMPT_QUALITY'),
      batch_decode: vi.fn((_tokens: unknown, _opts: unknown) => [state.decodedText]),
    }
  )

  const mockGenerate = vi.fn(async (_inputs: unknown) => {
    if (state.generateThrows) {
      throw state.generateThrows
    }
    return {
      slice: (_axis: null, _range: [number, number | null]) => ({ _isSlicedTokens: true }),
    }
  })

  const mockDispose = vi.fn(async () => {})
  const mockModelInstance = { dispose: mockDispose, generate: mockGenerate }

  const mockResize = vi.fn((w: number, h: number) => {
    if (state.resizeThrows) {
      throw state.resizeThrows
    }
    return { width: w, height: h, channels: 3, data: new Uint8ClampedArray(0) }
  })

  const mockFromBlob = vi.fn(async (_blob: Blob) => {
    if (state.fromBlobThrows) {
      throw state.fromBlobThrows
    }
    return { width: state.decodedWidth, height: state.decodedHeight, resize: mockResize }
  })

  const env: { cacheDir: string } = { cacheDir: '' }

  return {
    state,
    mockDispose,
    env,
    AutoProcessor: { from_pretrained: mockProcessorFromPretrained },
    // The captioner-fast spec also imports `AutoModelForImageTextToText` from
    // this module. We expose a no-op stub so dynamic imports of fast.ts during
    // module resolution do not crash — the `quality`-profile tests in this
    // file never construct a fast captioner.
    AutoModelForImageTextToText: { from_pretrained: vi.fn() },
    Qwen3_5ForConditionalGeneration: { from_pretrained: mockModelFromPretrained },
    RawImage: { fromBlob: mockFromBlob },
    mockGenerate,
    mockProcessorFromPretrained,
    mockModelFromPretrained,
    mockProcessorInstance,
    mockFromBlob,
    mockResize,
  }
})

const transformersFactory = () => ({
  AutoProcessor: mocks.AutoProcessor,
  AutoModelForImageTextToText: mocks.AutoModelForImageTextToText,
  Qwen3_5ForConditionalGeneration: mocks.Qwen3_5ForConditionalGeneration,
  RawImage: mocks.RawImage,
  env: mocks.env,
})

const MOCKED_PATHS = ['@huggingface/transformers'] as const

// ============================================
// Test suite
// ============================================

let createCaptioner: typeof import('../captioner.js').createCaptioner
let VlmError: typeof import('../types.js').VlmError

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const QUALITY_MODEL_ID = 'onnx-community/Qwen3.5-2B-ONNX'

const BASE_CONFIG = {
  profile: 'quality' as const,
  cacheDir: '/tmp/cache-quality',
}

describe('createCaptioner — quality profile dispatch (Qwen3.5-2B-ONNX)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    ;({ createCaptioner } = await import('../captioner.js'))
    ;({ VlmError } = await import('../types.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) {
      vi.doUnmock(p)
    }
    vi.resetModules()
  })

  beforeEach(() => {
    mocks.mockDispose.mockClear()
    mocks.state.decodedText = 'a valid quality caption'
    mocks.state.decodedWidth = 2000
    mocks.state.decodedHeight = 1000
    mocks.state.fromPretrainedThrows = null
    mocks.state.generateThrows = null
    mocks.state.fromBlobThrows = null
    mocks.state.resizeThrows = null
    mocks.mockGenerate.mockClear()
    mocks.mockProcessorFromPretrained.mockClear()
    mocks.mockModelFromPretrained.mockClear()
    mocks.mockFromBlob.mockClear()
    mocks.mockResize.mockClear()
    mocks.mockProcessorInstance.mockClear()
    mocks.env.cacheDir = ''
  })

  it.each([false, true])(
    'releases the acquired model after generation failure=%s',
    async (fail) => {
      const captioner = createCaptioner({
        profile: 'quality',
        cacheDir: './tmp/models',
        device: 'cpu',
      })
      if (fail) {
        mocks.state.generateThrows = new Error('Generation failed')
      }
      if (fail) {
        await expect(captioner.caption(new Uint8Array([1]), 1)).rejects.toThrow()
      } else {
        await captioner.caption(new Uint8Array([1]), 1)
      }
      await captioner.dispose()
      await captioner.dispose()
      expect(mocks.mockDispose).toHaveBeenCalledTimes(1)
    }
  )

  it('does not load a model when disposed before captioning', async () => {
    const captioner = createCaptioner({
      profile: 'quality',
      cacheDir: './tmp/models',
      device: 'cpu',
    })
    await captioner.dispose()
    expect(mocks.mockDispose).not.toHaveBeenCalled()
  })

  it('forwards the quality-profile Qwen model identifier to both from_pretrained calls', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockProcessorFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockProcessorFromPretrained.mock.calls[0]?.[0]).toBe(QUALITY_MODEL_ID)
    expect(mocks.mockModelFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[0]).toBe(QUALITY_MODEL_ID)
  })

  it('loads via Qwen3_5ForConditionalGeneration (not the auto entry point)', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    // The auto entry point MUST NOT have been used — its stub is only kept
    // alive so a sibling-file dynamic import of fast.ts would not crash.
    expect(mocks.AutoModelForImageTextToText.from_pretrained).not.toHaveBeenCalled()
    // Whereas the explicit Qwen class WAS used.
    expect(mocks.mockModelFromPretrained).toHaveBeenCalledTimes(1)
  })

  it('caps the decoded image long edge at 1024', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockFromBlob).toHaveBeenCalledTimes(1)
    expect(mocks.mockResize).toHaveBeenCalledTimes(1)
    expect(mocks.mockResize.mock.calls[0]).toEqual([1024, 512])
  })

  it('leaves an image already within the cap unresized', async () => {
    mocks.state.decodedWidth = 800
    mocks.state.decodedHeight = 600
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockResize).not.toHaveBeenCalled()
  })

  it('invokes the processor with a SINGLE image — not an array (IDEFICS3)', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockProcessorInstance).toHaveBeenCalledTimes(1)
    const call = expectDefined(mocks.mockProcessorInstance.mock.calls[0])
    const promptArg = call[0]
    const imageArg = call[1]
    expect(promptArg).toBe('CHAT_PROMPT_QUALITY')
    expect(Array.isArray(imageArg)).toBe(false)
  })

  it('calls model.generate with the measured decoding options', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockGenerate).toHaveBeenCalledTimes(1)
    const arg = expectRecord(mocks.mockGenerate.mock.calls[0]?.[0])
    expect(arg['max_new_tokens']).toBe(160)
    expect(arg['no_repeat_ngram_size']).toBe(6)
    expect(arg['repetition_penalty']).toBe(1.05)
    // The model's own generation_config would sample.
    expect(arg['do_sample']).toBe(false)
  })

  it('returns the decoded caption verbatim when post-processing leaves it unchanged', async () => {
    mocks.state.decodedText = 'Summary: a figure.\n\nKeywords: alpha; beta'
    const captioner = createCaptioner(BASE_CONFIG)

    const result = await captioner.caption(PNG_BYTES, 1)

    expect(result).toBe('Summary: a figure.\n\nKeywords: alpha; beta')
  })

  it('wraps model-load failure in VlmError with pageNum + Qwen model identifier in the cause', async () => {
    const originalErr = new Error('boom-quality-load')
    mocks.state.fromPretrainedThrows = originalErr
    const captioner = createCaptioner(BASE_CONFIG)

    let captured: unknown
    try {
      await captioner.caption(PNG_BYTES, 5)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(VlmError)
    expect(expectInstanceOf(captured, VlmError).pageNum).toBe(5)
    expect(expectInstanceOf(captured, VlmError).message).toBe('Captioning failed for page 5')

    const cause = expectError(expectInstanceOf(captured, VlmError).cause)
    expect(cause.message).toContain('Captioner load failed')
    expect(cause.message).toContain(`modelName=${QUALITY_MODEL_ID}`)
    expect(cause.message).toContain('boom-quality-load')
    expect(expectRecord(cause)['cause']).toBe(originalErr)
  })

  it('wraps generation failure in VlmError with pageNum + cause', async () => {
    const originalErr = new Error('boom-quality-generate')
    mocks.state.generateThrows = originalErr
    const captioner = createCaptioner(BASE_CONFIG)

    let captured: unknown
    try {
      await captioner.caption(PNG_BYTES, 9)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(VlmError)
    expect(expectInstanceOf(captured, VlmError).pageNum).toBe(9)
    expect(expectInstanceOf(captured, VlmError).cause).toBe(originalErr)
  })
})
