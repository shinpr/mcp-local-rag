// T3.3 — `createCaptioner` unit test (AC-009 env override + AC-011 length /
// emptiness handling).
//
// Asserts the captioner's public contract documented in
// docs/design/vlm-pdf-enrichment-design.md §Component → pdf-visual/captioner.ts:
//
//   createCaptioner(config: CaptionerConfig): Captioner
//   Captioner.caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null>
//
// Verification points (DD §Testing matrix, AC-009 + AC-011 rows):
//   - `from_pretrained` receives `config.modelName` and `{ dtype: resolvedDtype }`
//     where `resolvedDtype = config.dtype || DEFAULT_VLM_DTYPE`.
//   - `model.generate` receives `max_new_tokens: 128`.
//   - Post-decode boundary cases: 1000 chars passes through unchanged, 1001
//     chars truncated to 1000 + `…` (final length 1001), empty/whitespace-only/
//     control-char-only inputs return `null` without throwing.
//   - Load / decode / generate failures throw `VlmError` with `pageNum` + `cause`.
//
// `@huggingface/transformers` is mocked via `vi.hoisted` per the project-wide
// constraint (`vitest.config.mjs` sets `isolate: false`, so mocks must be
// hoisted to be visible inside `vi.mock` factories before the SUT imports the
// module).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@huggingface/transformers', () => ({
  AutoProcessor: mocks.AutoProcessor,
  AutoModelForImageTextToText: mocks.AutoModelForImageTextToText,
  RawImage: mocks.RawImage,
  env: mocks.env,
}))

// ============================================
// Test suite
// ============================================

import { createCaptioner, DEFAULT_VLM_DTYPE } from '../captioner'
import { VlmError } from '../types'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const BASE_CONFIG = {
  modelName: 'sentinel-default-model',
  cacheDir: '/tmp/cache',
  dtype: 'sentinel-dtype',
}

describe('createCaptioner (AC-009 env override + AC-011 length / emptiness)', () => {
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

  afterEach(() => {
    delete process.env['VLM_MODEL_NAME']
  })

  // ----- AC-009: VLM_MODEL_NAME flow -----

  it('forwards config.modelName as the first argument to from_pretrained', async () => {
    // Arrange
    const captioner = createCaptioner({ ...BASE_CONFIG, modelName: 'sentinel-model-name' })

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert: both AutoProcessor and AutoModel from_pretrained get the model name.
    expect(mocks.mockProcessorFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockProcessorFromPretrained.mock.calls[0]?.[0]).toBe('sentinel-model-name')
    expect(mocks.mockModelFromPretrained).toHaveBeenCalledTimes(1)
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[0]).toBe('sentinel-model-name')
  })

  // ----- AC-009: VLM_DTYPE pass-through -----

  it('passes config.dtype through to from_pretrained when non-empty', async () => {
    // Arrange
    const captioner = createCaptioner({ ...BASE_CONFIG, dtype: 'sentinel-dtype' })

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[1]).toEqual({ dtype: 'sentinel-dtype' })
  })

  // ----- AC-009: VLM_DTYPE empty-normalization -----

  it('normalizes empty config.dtype to DEFAULT_VLM_DTYPE before from_pretrained', async () => {
    // Arrange
    const captioner = createCaptioner({ ...BASE_CONFIG, dtype: '' })

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert: literal DEFAULT_VLM_DTYPE (exported for introspection).
    expect(mocks.mockModelFromPretrained.mock.calls[0]?.[1]).toEqual({ dtype: DEFAULT_VLM_DTYPE })
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

  // ----- max_new_tokens: 128 -----

  it('calls model.generate with max_new_tokens: 128', async () => {
    // Arrange
    const captioner = createCaptioner(BASE_CONFIG)

    // Act
    await captioner.caption(PNG_BYTES, 1)

    // Assert
    expect(mocks.mockGenerate).toHaveBeenCalledTimes(1)
    const arg = mocks.mockGenerate.mock.calls[0]?.[0] as { max_new_tokens?: number }
    expect(arg?.max_new_tokens).toBe(128)
  })

  // ----- Failure: model load -----

  it('wraps model-load failure in VlmError with pageNum + cause', async () => {
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

    expect(captured).toBeInstanceOf(VlmError)
    expect((captured as VlmError).pageNum).toBe(1)
    expect((captured as VlmError).message).toBe('Captioning failed for page 1')
    expect((captured as VlmError).cause).toBe(originalErr)
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
