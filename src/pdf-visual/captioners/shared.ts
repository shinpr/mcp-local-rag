// Profile-agnostic helpers shared by every `captioners/*` profile.
//
// `stripControlChars` + `postProcess` are the post-generation pipeline
// documented in the captioner contract: control-char stripping, whitespace
// trim, empty → `null`, length cap with ellipsis. Both `fast` and `quality`
// profiles run the captioner output through the same pipeline so caption
// chunk shape is independent of profile.
//
// `VLM_DTYPE`, `buildModelLoadOptions`, `createModelLoader`, and
// `decodePngToRawImage` are the profile-agnostic load/decode mechanics. The
// model-class choice, prompt, processor call shape, and generation options
// stay per-profile (that is where `fast` and `quality` genuinely diverge).

import { type DeviceType, RawImage } from '@huggingface/transformers'

import { isObjectLike } from '../../utils/type-guards.js'

/**
 * ONNX quantization variant shared by both captioner profiles. Pinned to the
 * smallest viable variant; production has no user-facing knob.
 */
const VLM_DTYPE = 'q4' as const

/** Lazy-load lifecycle state for a captioner's processor + model. */
type CaptionerLoadState = { kind: 'pending' } | { kind: 'ok' } | { kind: 'failed'; cause: Error }

/**
 * Build the `from_pretrained` option objects (processor + model) with the
 * pinned dtype and resolved device.
 *
 * `RAG_DEVICE` is passed through with no allowlist (see `resolveDevice`) so a
 * device transformers.js adds later works without a code change, while the
 * library types the parameter as a closed literal union. That gap is the one
 * thing here the type system cannot state, so it is suppressed at the single
 * line that crosses it.
 */
export function buildModelLoadOptions(resolvedDevice: string): {
  dtypeOpt: { dtype: 'q4' }
  modelOpt: { dtype: 'q4'; device: DeviceType }
} {
  const dtypeOpt = { dtype: VLM_DTYPE }
  const modelOpt = {
    dtype: VLM_DTYPE,
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: RAG_DEVICE is a deliberate un-allowlisted passthrough to a closed literal union
    device: resolvedDevice as DeviceType,
  }
  return { dtypeOpt, modelOpt }
}

/**
 * The VLM processor as both captioner profiles call it: a callable that
 * tokenizes prompt + image, plus the two template/decode helpers.
 * transformers.js supplies no type for this surface, so it is checked once at
 * the boundary instead of asserted at each use.
 */
export type VlmProcessor = {
  apply_chat_template: (messages: unknown, options: { add_generation_prompt: boolean }) => string
  batch_decode: (tokens: unknown, options: { skip_special_tokens: boolean }) => string[]
} & ((prompt: string, images: unknown) => Promise<{ input_ids: { dims: number[] } }>)

/** The VLM itself, reduced to the generate call both profiles make. */
export interface VlmModel {
  generate: (inputs: unknown) => Promise<{
    slice: (axis: null, range: [number, number | null]) => unknown
  }>
}

export function isVlmProcessor(value: unknown): value is VlmProcessor {
  return (
    typeof value === 'function' &&
    'apply_chat_template' in value &&
    typeof value.apply_chat_template === 'function' &&
    'batch_decode' in value &&
    typeof value.batch_decode === 'function'
  )
}

export function isVlmModel(value: unknown): value is VlmModel {
  return isObjectLike(value) && typeof value['generate'] === 'function'
}

/** The processor + model pair produced by a profile's load callback. */
export interface LoadedModel {
  processor: unknown
  model: unknown
}

/**
 * Lazy model loader shared by both profiles. Encapsulates the
 * pending→ok/failed state machine and the identical load-failure wrapping
 * (`Captioner load failed (modelName=..., device=...)`). The per-profile
 * `load` callback owns the model-class choice and receives the shared option
 * objects. On first `ensureLoaded()` the model loads; subsequent calls return
 * the cached pair; a prior failure re-throws the same wrapped error.
 */
export function createModelLoader(
  modelName: string,
  resolvedDevice: string,
  load: (opts: ReturnType<typeof buildModelLoadOptions>) => Promise<LoadedModel>
): { ensureLoaded: () => Promise<LoadedModel>; dispose: () => Promise<void> } {
  let loaded: LoadedModel | null = null
  let state: CaptionerLoadState = { kind: 'pending' }

  return {
    async dispose(): Promise<void> {
      const model: unknown = loaded?.model
      loaded = null
      const dispose = isObjectLike(model) ? model['dispose'] : undefined
      if (typeof dispose === 'function') {
        try {
          await dispose.call(model)
        } catch (error) {
          console.error('Error disposing captioner model:', error)
        }
      }
    },
    async ensureLoaded(): Promise<LoadedModel> {
      if (state.kind === 'ok' && loaded) {
        return loaded
      }
      if (state.kind === 'failed') {
        throw state.cause
      }
      try {
        loaded = await load(buildModelLoadOptions(resolvedDevice))
        state = { kind: 'ok' }
        return loaded
      } catch (err) {
        const original = err instanceof Error ? err : new Error(String(err))
        const wrapped = new Error(
          `Captioner load failed (modelName=${modelName}, device=${resolvedDevice}): ${original.message}`,
          { cause: original }
        )
        state = { kind: 'failed', cause: wrapped }
        throw wrapped
      }
    },
  }
}

/**
 * Decode PNG bytes to a `RawImage`. `BlobPart` omits `Uint8Array<ArrayBufferLike>`
 * (SharedArrayBuffer subtyping), so the bytes are copied into a view that is
 * definitely backed by a plain `ArrayBuffer`. Profiles needing a fixed input
 * size resize the result.
 */
export async function decodePngToRawImage(pngBytes: Uint8Array): Promise<RawImage> {
  const bytes = new Uint8Array(pngBytes)
  const blob = new Blob([bytes], { type: 'image/png' })
  return RawImage.fromBlob(blob)
}

/** Maximum caption length in characters; longer captions are truncated with an ellipsis. */
const MAX_CAPTION_LENGTH = 1000

/**
 * Strip C0 (U+0000–U+001F) and C1 (U+007F–U+009F) control characters from the
 * input, except `\n` (U+000A) and `\t` (U+0009) which are kept verbatim.
 */
function stripControlChars(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code === 0x09 || code === 0x0a) {
      out += input[i]
      continue
    }
    if (code <= 0x1f) {
      continue
    }
    if (code >= 0x7f && code <= 0x9f) {
      continue
    }
    out += input[i]
  }
  return out
}

/**
 * Apply the post-generation processing rules. Returns the final caption or
 * `null` when the result is empty after stripping.
 */
export function postProcess(decoded: string): string | null {
  const stripped = stripControlChars(decoded).trim()
  if (stripped.length === 0) {
    return null
  }
  if (stripped.length > MAX_CAPTION_LENGTH) {
    return `${stripped.slice(0, MAX_CAPTION_LENGTH)}…`
  }
  return stripped
}
