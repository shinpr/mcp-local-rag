// `createCaptioner` (`fast` profile dispatch) unit test.
//
// Phase 1 of the visual-quality-mode refactor routes the dispatcher's `fast`
// profile to `captioners/fast.ts`, which is a verbatim port of the v0.14.0
// captioner. The mock surface and assertions in this file were authored
// against that port and continue to apply: the model class is still
// `AutoModelForImageTextToText`, the processor is still called with an array-
// form image list, generation options are still
// `{max_new_tokens:128, repetition_penalty:1.15, no_repeat_ngram_size:3}`.
//
// What changed at the dispatcher boundary:
//   - `CaptionerConfig` no longer carries `modelName`. The model identifier
//     (`HuggingFaceTB/SmolVLM-256M-Instruct`) lives inside `captioners/fast.ts`.
//   - Construction is `createCaptioner({ profile: 'fast', cacheDir, device? })`.
//
// Verification points:
//   - `from_pretrained` receives the `fast`-profile model identifier and the
//     dispatcher-exposed `VLM_DTYPE`; model loading also receives the
//     resolved device.
//   - `model.generate` receives the `fast`-profile decoding options
//     (`max_new_tokens`, `repetition_penalty`, `no_repeat_ngram_size`).
//   - Post-decode boundary cases: 1000 chars passes through unchanged, 1001
//     chars truncated to 1000 + `…` (final length 1001), empty/whitespace-only/
//     control-char-only inputs return `null` without throwing.
//   - Load / decode / generate failures throw `VlmError` with `pageNum` + `cause`.
//
// `@huggingface/transformers` is mocked via `vi.hoisted` per the project-wide
// constraint (`vitest.config.mjs` sets `isolate: false`, so mocks must be
// hoisted to be visible inside `vi.mock` factories before the SUT imports the
// module).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mocks (vi.hoisted — required for `@huggingface/transformers`)
// ============================================

const mocks = vi.hoisted(() => {
  // Default behaviour: processor returns inputs with a 4-token prompt;
  // model.generate returns a 6-token output (4 prompt + 2 generated). The
  // mock processor.batch_decode returns whatever string the test has staged
  // in `mocks.decodedText` so each AC-011 boundary case can be exercised.
  const state: {
    decodedText: string
    fromPretrainedThrows: Error | null
    generateThrows: Error | null
    fromBlobThrows: Error | null
  } = {
    decodedText: 'a valid caption',
    fromPretrainedThrows: null,
    generateThrows: null,
    fromBlobThrows: null,
  }

  const mockProcessorFromPretrained = vi.fn(async (_modelName: string, _options: unknown) => {
    if (state.fromPretrainedThrows) throw state.fromPretrainedThrows
    return mockProcessorInstance
  })

  const mockModelFromPretrained = vi.fn(async (_modelName: string, _options: unknown) => {
    if (state.fromPretrainedThrows) throw state.fromPretrainedThrows
    return mockModelInstance
  })

  const mockGenerate = vi.fn(async (_inputs: unknown) => {
    if (state.generateThrows) throw state.generateThrows
    // Mock tensor that supports `.slice(null, [start, end])`.
    return {
      slice: (_axis: null, _range: [number, number]) => ({ _isSlicedTokens: true }),
    }
  })

  const mockBatchDecode = vi.fn((_tokens: unknown, _opts: unknown) => {
    return [state.decodedText]
  })

  const mockApplyChatTemplate = vi.fn((_messages: unknown, _opts: unknown) => 'CHAT_PROMPT')

  const mockProcessorInstance = Object.assign(
    // The processor itself is callable: `await processor(chatPrompt, [rawImage])`
    // returns an `inputs` object. We model it as a function with attached
    // methods.
    vi.fn(async (_chatPrompt: string, _images: unknown[]) => ({
      input_ids: { dims: [1, 4] },
      attention_mask: {},
      pixel_values: {},
    })),
    {
      apply_chat_template: mockApplyChatTemplate,
      batch_decode: mockBatchDecode,
    }
  )

  const mockModelInstance = {
    generate: mockGenerate,
  }

  const mockFromBlob = vi.fn((_blob: Blob) => {
    if (state.fromBlobThrows) throw state.fromBlobThrows
    return { width: 100, height: 100, channels: 3, data: new Uint8ClampedArray(0) }
  })

  const env = { cacheDir: '' as string }

  return {
    state,
    env,
    AutoProcessor: { from_pretrained: mockProcessorFromPretrained },
    AutoModelForImageTextToText: { from_pretrained: mockModelFromPretrained },
    RawImage: { fromBlob: mockFromBlob },
    mockGenerate,
    mockBatchDecode,
    mockProcessorFromPretrained,
    mockModelFromPretrained,
    mockProcessorInstance,
  }
})

// Factory installed via `vi.doMock` in `beforeAll`; removed in `afterAll`.
// See `.claude/skills/project-context/SKILL.md` for the cross-file mock leak
// rule under `isolate: false`.
const transformersFactory = () => ({
  AutoProcessor: mocks.AutoProcessor,
  AutoModelForImageTextToText: mocks.AutoModelForImageTextToText,
  RawImage: mocks.RawImage,
  env: mocks.env,
})

const MOCKED_PATHS = ['@huggingface/transformers'] as const

// ============================================
// Test suite
// ============================================

let createCaptioner: typeof import('../captioner').createCaptioner
let VLM_DTYPE: typeof import('../captioner').VLM_DTYPE
let VlmError: typeof import('../types').VlmError

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const FAST_MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct'

const BASE_CONFIG = {
  profile: 'fast' as const,
  cacheDir: '/tmp/cache',
}

describe('createCaptioner — fast profile dispatch (CaptionerConfig flow + AC-011 length / emptiness)', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@huggingface/transformers', transformersFactory)
    ;({ createCaptioner, VLM_DTYPE } = await import('../captioner'))
    ;({ VlmError } = await import('../types'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    // Reset mock state between tests.
    mocks.state.decodedText = 'a valid caption'
    mocks.state.fromPretrainedThrows = null
    mocks.state.generateThrows = null
    mocks.state.fromBlobThrows = null
    mocks.mockGenerate.mockClear()
    mocks.mockBatchDecode.mockClear()
    mocks.mockProcessorFromPretrained.mockClear()
    mocks.mockModelFromPretrained.mockClear()
    mocks.env.cacheDir = ''
  })

  // ----- fast profile resolves its own model identifier -----

  it('forwards the fast-profile model identifier as the first argument to from_pretrained', async () => {
    // Arrange: model identifier is owned by `captioners/fast.ts`, not the
    // caller. Pinning it here makes accidental changes loud.
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert: both AutoProcessor and AutoModel from_pretrained receive the
    // fast-profile literal.
    expect(mocks.mockProcessorFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockProcessorFromPretrained.mock.calls[0]?.[0]).toBe(FAST_MODEL_ID)
    expect(mocks.mockModelFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[0]).toBe(FAST_MODEL_ID)
  })

  // ----- VLM_DTYPE pinned -----

  it('forwards the pinned VLM_DTYPE to both processor and model from_pretrained', async () => {
    // Arrange
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert: same dtype on both calls; device defaults to 'cpu' on model load.
    expect(mocks.mockProcessorFromPretrained.mock.calls[0]?.[1]).toEqual({ dtype: VLM_DTYPE })
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[1]).toEqual({
      dtype: VLM_DTYPE,
      device: 'cpu',
    })
  })

  it('passes config.device through to model from_pretrained when provided', async () => {
    // Arrange
    const captioner = createCaptioner({ ...BASE_CONFIG, device: 'webgpu' })

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert: only the model load receives device; the processor keeps dtype-only options.
    expect(mocks.mockProcessorFromPretrained.mock.calls[0]?.[1]).toEqual({ dtype: VLM_DTYPE })
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[1]).toEqual({
      dtype: VLM_DTYPE,
      device: 'webgpu',
    })
  })

  // ----- env.cacheDir defensive ordering -----

  it('sets env.cacheDir to config.cacheDir at construction (before first from_pretrained)', async () => {
    // Arrange + Act
    createCaptioner({ ...BASE_CONFIG, cacheDir: '/tmp/captioner-cache' })

    // Assert: set synchronously at construction, independent of any caption() call.
    expect(mocks.env.cacheDir).toBe('/tmp/captioner-cache')
    expect(mocks.mockProcessorFromPretrained).not.toHaveBeenCalled()
    expect(mocks.mockModelFromPretrained).not.toHaveBeenCalled()
  })

  // ----- AC-011: 1000 chars -----

  it('returns the caption unchanged when decoded length is exactly 1000', async () => {
    // Arrange
    const text = 'a'.repeat(1000)
    mocks.state.decodedText = text
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    const result = await captioner.caption(PNG_BYTES, 1)

    // Assert
    expect(result).toBe(text)
    expect(result?.length).toBe(1000)
  })

  // ----- AC-011: 1001 chars (truncated) -----

  it('truncates to 1000 chars + … when decoded length is 1001', async () => {
    // Arrange
    const text = 'b'.repeat(1001)
    mocks.state.decodedText = text
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    const result = await captioner.caption(PNG_BYTES, 1)

    // Assert: 1000 chars of 'b' + '…' = length 1001 ending in '…'.
    expect(result?.length).toBe(1001)
    expect(result?.endsWith('…')).toBe(true)
    expect(result?.slice(0, 1000)).toBe('b'.repeat(1000))
  })

  // ----- AC-011: empty -----

  it('returns null when decoded output is the empty string', async () => {
    // Arrange
    mocks.state.decodedText = ''
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    const result = await captioner.caption(PNG_BYTES, 1)

    // Assert
    expect(result).toBeNull()
  })

  // ----- AC-011: whitespace-only -----

  it('returns null when decoded output is whitespace-only', async () => {
    // Arrange
    mocks.state.decodedText = '   \n\t  '
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    const result = await captioner.caption(PNG_BYTES, 1)

    // Assert
    expect(result).toBeNull()
  })

  // ----- AC-011: control-char-only -----

  it('returns null when decoded output contains only control chars (except \\n, \\t)', async () => {
    // Arrange: C0 control chars 0x00..0x08, 0x0b, 0x0c, 0x0e..0x1f and a C1 (0x80).
    mocks.state.decodedText = ' '
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    const result = await captioner.caption(PNG_BYTES, 1)

    // Assert
    expect(result).toBeNull()
  })

  // ----- generate options -----

  it('calls model.generate with the documented decoding options', async () => {
    // Arrange
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert: the captioner pins decoding options that affect retrieval
    // quality. Pinning them in a test makes accidental changes loud.
    expect(mocks.mockGenerate).toHaveBeenCalledTimes(1)
    const arg = mocks.mockGenerate.mock.calls[0]?.[0] as {
      max_new_tokens?: number
      repetition_penalty?: number
      no_repeat_ngram_size?: number
    }
    expect(arg?.max_new_tokens).toBe(128)
    expect(arg?.repetition_penalty).toBe(1.15)
    expect(arg?.no_repeat_ngram_size).toBe(3)
  })

  // ----- Failure: model load -----

  it('wraps model-load failure in VlmError with pageNum and a load-aware cause message', async () => {
    // Arrange
    const originalErr = new Error('boom-load')
    mocks.state.fromPretrainedThrows = originalErr
    const captioner = createCaptioner(BASE_CONFIG)

    // Act + Assert
    let captured: unknown
    try {
      await captioner.caption(PNG_BYTES, 1)
    } catch (err) {
      captured = err
    }

    // Per-page wrap: VlmError with pageNum + user-facing message.
    expect(captured).toBeInstanceOf(VlmError)
    expect((captured as VlmError).pageNum).toBe(1)
    expect((captured as VlmError).message).toBe('Captioning failed for page 1')

    // The immediate cause is the wrapper produced by ensureLoaded(); its
    // message names the resolved modelName and device so operators can
    // identify the source.
    const cause = (captured as VlmError).cause as Error
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toContain('Captioner load failed')
    expect(cause.message).toContain(`modelName=${FAST_MODEL_ID}`)
    expect(cause.message).toContain('device=cpu')
    expect(cause.message).toContain('boom-load')

    // The original `from_pretrained` error is preserved via the Error.cause
    // chain so debugging is not lossy.
    expect((cause as Error & { cause?: unknown }).cause).toBe(originalErr)
  })

  // ----- F1: load-failure caching -----

  it('caches load failure: from_pretrained is invoked at most once across multiple caption() calls (F1)', async () => {
    // Arrange: from_pretrained throws on every call. Without the cache, each
    // candidate page would trigger an additional from_pretrained attempt.
    const originalErr = new Error('boom-load-once')
    mocks.state.fromPretrainedThrows = originalErr
    const captioner = createCaptioner(BASE_CONFIG)

    // Act: call caption() on 3 different page numbers, each must throw.
    const thrownErrors: unknown[] = []
    for (const pageNum of [1, 2, 3]) {
      try {
        await captioner.caption(PNG_BYTES, pageNum)
      } catch (err) {
        thrownErrors.push(err)
      }
    }

    // Assert: all 3 page calls threw.
    expect(thrownErrors).toHaveLength(3)

    // Assert: from_pretrained was invoked at most ONCE in total across all
    // caption() calls. The processor load is the first attempt and it throws;
    // the model load on the same call may or may not run depending on the
    // sequence-vs-parallel semantics of the implementation. Either way the
    // total combined call count across processor+model must NOT scale with
    // page count.
    const totalLoadCalls =
      mocks.mockProcessorFromPretrained.mock.calls.length +
      mocks.mockModelFromPretrained.mock.calls.length
    // With caching: at most 2 (one processor + one model load on first call).
    // Without caching: would be 6 (2 loads × 3 pages).
    expect(totalLoadCalls).toBeLessThanOrEqual(2)

    // Assert: every thrown error wraps the same original cause via the
    // load-aware wrapper.
    for (const captured of thrownErrors) {
      expect(captured).toBeInstanceOf(VlmError)
      const cause = (captured as VlmError).cause as Error & { cause?: unknown }
      expect(cause.cause).toBe(originalErr)
    }
  })

  // ----- Failure: generate -----

  it('wraps generation failure in VlmError with pageNum + cause', async () => {
    // Arrange
    const originalErr = new Error('boom-generate')
    mocks.state.generateThrows = originalErr
    const captioner = createCaptioner(BASE_CONFIG)

    // Act + Assert
    let captured: unknown
    try {
      await captioner.caption(PNG_BYTES, 7)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(VlmError)
    expect((captured as VlmError).pageNum).toBe(7)
    expect((captured as VlmError).message).toBe('Captioning failed for page 7')
    expect((captured as VlmError).cause).toBe(originalErr)
  })

  // ----- Failure: image decode -----

  it('wraps image-decode failure in VlmError with pageNum + cause', async () => {
    // Arrange
    const originalErr = new Error('boom-decode')
    mocks.state.fromBlobThrows = originalErr
    const captioner = createCaptioner(BASE_CONFIG)

    // Act + Assert
    let captured: unknown
    try {
      await captioner.caption(PNG_BYTES, 3)
    } catch (err) {
      captured = err
    }

    expect(captured).toBeInstanceOf(VlmError)
    expect((captured as VlmError).pageNum).toBe(3)
    expect((captured as VlmError).message).toBe('Captioning failed for page 3')
    expect((captured as VlmError).cause).toBe(originalErr)
  })
})
