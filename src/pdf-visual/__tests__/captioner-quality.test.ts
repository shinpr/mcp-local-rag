// `createCaptioner` (`quality` profile dispatch) unit test.
//
// Asserts the Qwen2.5-VL-3B-Instruct-ONNX surface contract owned by
// `src/pdf-visual/captioners/quality.ts`:
//
//   - Model loaded via the explicit `Qwen2_5_VLForConditionalGeneration`
//     class (not the architecture-agnostic `AutoModelForImageTextToText`).
//   - Processor invoked with a SINGLE image argument (not the array form
//     used by the IDEFICS3-based `fast` profile).
//   - Image is resized to 448x448 client-side before being handed to the
//     processor.
//   - `model.generate` is called with `max_new_tokens` ONLY — the
//     `repetition_penalty` / `no_repeat_ngram_size` options used by `fast`
//     MUST NOT be present (they produce forced variant generation on Qwen).
//   - `inputs.input_ids.dims.at(-1)` is the value used to slice prompt
//     tokens from the generated output.
//   - Load failure surfaces the resolved Qwen model identifier in the
//     wrapper message.
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

// ============================================
// Mocks (vi.hoisted — required for `@huggingface/transformers`)
// ============================================

const mocks = vi.hoisted(() => {
  const state: {
    decodedText: string
    fromPretrainedThrows: Error | null
    generateThrows: Error | null
    fromBlobThrows: Error | null
    resizeThrows: Error | null
  } = {
    decodedText: 'a valid quality caption',
    fromPretrainedThrows: null,
    generateThrows: null,
    fromBlobThrows: null,
    resizeThrows: null,
  }

  const mockProcessorFromPretrained = vi.fn(async (_modelName: string, _options: unknown) => {
    if (state.fromPretrainedThrows) throw state.fromPretrainedThrows
    return mockProcessorInstance
  })

  const mockModelFromPretrained = vi.fn(async (_modelName: string, _options: unknown) => {
    if (state.fromPretrainedThrows) throw state.fromPretrainedThrows
    return mockModelInstance
  })

  // The Qwen2.5-VL processor takes the image directly (not as an array). The
  // input_ids tensor's last dimension is the input length read via
  // `dims.at(-1)`. We model the dim list with a leading batch dim so the
  // selector hits the intended index.
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
    if (state.generateThrows) throw state.generateThrows
    return {
      slice: (_axis: null, _range: [number, number | null]) => ({ _isSlicedTokens: true }),
    }
  })

  const mockModelInstance = { generate: mockGenerate }

  // RawImage.fromBlob resolves to an object with a `.resize()` method; the
  // production code chains `.resize(448, 448)` and we assert on the args.
  const mockResize = vi.fn((_w: number, _h: number) => {
    if (state.resizeThrows) throw state.resizeThrows
    return { width: 448, height: 448, channels: 3, data: new Uint8ClampedArray(0) }
  })

  const mockFromBlob = vi.fn(async (_blob: Blob) => {
    if (state.fromBlobThrows) throw state.fromBlobThrows
    return { resize: mockResize }
  })

  const env = { cacheDir: '' as string }

  return {
    state,
    env,
    AutoProcessor: { from_pretrained: mockProcessorFromPretrained },
    // The captioner-fast spec also imports `AutoModelForImageTextToText` from
    // this module. We expose a no-op stub so dynamic imports of fast.ts during
    // module resolution do not crash — the `quality`-profile tests in this
    // file never construct a fast captioner.
    AutoModelForImageTextToText: { from_pretrained: vi.fn() },
    Qwen2_5_VLForConditionalGeneration: { from_pretrained: mockModelFromPretrained },
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
  Qwen2_5_VLForConditionalGeneration: mocks.Qwen2_5_VLForConditionalGeneration,
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
const QUALITY_MODEL_ID = 'onnx-community/Qwen2.5-VL-3B-Instruct-ONNX'

const BASE_CONFIG = {
  profile: 'quality' as const,
  cacheDir: '/tmp/cache-quality',
}

describe('createCaptioner — quality profile dispatch (Qwen2.5-VL-3B-Instruct-ONNX)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    ;({ createCaptioner } = await import('../captioner.js'))
    ;({ VlmError } = await import('../types.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    mocks.state.decodedText = 'a valid quality caption'
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

  it('forwards the quality-profile Qwen model identifier to both from_pretrained calls', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockProcessorFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockProcessorFromPretrained.mock.calls[0]?.[0]).toBe(QUALITY_MODEL_ID)
    expect(mocks.mockModelFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[0]).toBe(QUALITY_MODEL_ID)
  })

  it('loads via Qwen2_5_VLForConditionalGeneration (not the auto entry point)', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    // The auto entry point MUST NOT have been used — its stub is only kept
    // alive so a sibling-file dynamic import of fast.ts would not crash.
    expect(mocks.AutoModelForImageTextToText.from_pretrained).not.toHaveBeenCalled()
    // Whereas the explicit Qwen class WAS used.
    expect(mocks.mockModelFromPretrained).toHaveBeenCalledTimes(1)
  })

  it('resizes the decoded image to 448x448 before invoking the processor', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockFromBlob).toHaveBeenCalledTimes(1)
    expect(mocks.mockResize).toHaveBeenCalledTimes(1)
    expect(mocks.mockResize.mock.calls[0]).toEqual([448, 448])
  })

  it('invokes the processor with a SINGLE image (Qwen) — not an array (IDEFICS3)', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    // The processor instance itself is the callable that consumes
    // (prompt, image). It must have been invoked once with the image as the
    // second argument — and that second argument MUST NOT be an array.
    expect(mocks.mockProcessorInstance).toHaveBeenCalledTimes(1)
    const [promptArg, imageArg] = mocks.mockProcessorInstance.mock.calls[0] as unknown as [
      string,
      unknown,
    ]
    expect(promptArg).toBe('CHAT_PROMPT_QUALITY')
    expect(Array.isArray(imageArg)).toBe(false)
  })

  it('calls model.generate with max_new_tokens only — no repetition_penalty / no_repeat_ngram_size', async () => {
    const captioner = createCaptioner(BASE_CONFIG)
    await captioner.caption(PNG_BYTES, 1)

    expect(mocks.mockGenerate).toHaveBeenCalledTimes(1)
    const arg = mocks.mockGenerate.mock.calls[0]?.[0] as {
      max_new_tokens?: number
      repetition_penalty?: number
      no_repeat_ngram_size?: number
    }
    expect(arg?.max_new_tokens).toBe(128)
    // These two options exist on `fast` but are explicitly absent on `quality`
    // because they cause forced variant generation on Qwen2.5-VL.
    expect(arg?.repetition_penalty).toBeUndefined()
    expect(arg?.no_repeat_ngram_size).toBeUndefined()
  })

  it('returns the decoded caption verbatim when post-processing leaves it unchanged', async () => {
    mocks.state.decodedText = 'Summary: a figure.\n\nKeywords: alpha; beta'
    const captioner = createCaptioner(BASE_CONFIG)

    const result = await captioner.caption(PNG_BYTES, 1)

    expect(result).toBe('Summary: a figure.\n\nKeywords: alpha; beta')
  })

  it('returns null when decoded output is whitespace-only (shared postProcess applies)', async () => {
    mocks.state.decodedText = '   \n\t  '
    const captioner = createCaptioner(BASE_CONFIG)

    const result = await captioner.caption(PNG_BYTES, 1)

    expect(result).toBeNull()
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
    expect((captured as InstanceType<typeof VlmError>).pageNum).toBe(5)
    expect((captured as InstanceType<typeof VlmError>).message).toBe('Captioning failed for page 5')

    const cause = (captured as InstanceType<typeof VlmError>).cause as Error
    expect(cause.message).toContain('Captioner load failed')
    expect(cause.message).toContain(`modelName=${QUALITY_MODEL_ID}`)
    expect(cause.message).toContain('boom-quality-load')
    expect((cause as Error & { cause?: unknown }).cause).toBe(originalErr)
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
    expect((captured as InstanceType<typeof VlmError>).pageNum).toBe(9)
    expect((captured as InstanceType<typeof VlmError>).cause).toBe(originalErr)
  })
})
