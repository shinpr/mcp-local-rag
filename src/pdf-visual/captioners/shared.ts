// Profile-agnostic helpers shared by every `captioners/*` profile: the
// post-generation pipeline (control-char strip, trim, empty → `null`, length
// cap) so caption shape is independent of profile, plus the load/decode
// mechanics. The model class, prompt, processor call shape and generation
// options stay per-profile — that is where `fast` and `quality` diverge.

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
 * pinned dtype and resolved device. `RAG_DEVICE` passes through with no
 * allowlist (see `resolveDevice`) into a closed literal union.
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
 * `apply_chat_template` is declared to return TOKENIZED output by default, not
 * the string the profiles pass on.
 */
export type VlmProcessor = {
  apply_chat_template: (messages: unknown, options: { add_generation_prompt: boolean }) => string
  batch_decode: (tokens: unknown, options: { skip_special_tokens: boolean }) => string[]
} & ((prompt: string, images: unknown) => Promise<{ input_ids: { dims: unknown[] } }>)

/** Picks the tensor side of `generate`'s declared model-output-or-tensor union. */
export interface VlmModel {
  generate: (inputs: unknown) => Promise<{
    slice: (axis: null, range: [number, number | null]) => unknown
  }>
}

/**
 * Not a guard: member existence says nothing about return values. The captioner
 * tests replace the library, so they prove these call sites are right GIVEN
 * this contract, not that the library still honors it — only `fast` runs
 * against the real one, in `visual-ingest-e2e.test.ts`.
 */
export function asVlmProcessor(processor: unknown): VlmProcessor {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: narrows the library's `Processor`, see above
  return processor as VlmProcessor
}

/** Present a loaded model as {@link VlmModel}. See {@link asVlmProcessor}. */
export function asVlmModel(model: unknown): VlmModel {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: picks `generate`'s tensor branch, see VlmModel
  return model as VlmModel
}

/** The processor + model pair produced by a profile's load callback. */
export interface LoadedModel {
  processor: unknown
  model: unknown
}

/**
 * Lazy model loader shared by both profiles: owns the pending→ok/failed state
 * machine and the identical load-failure wrapping. A prior failure re-throws
 * the same wrapped error rather than retrying. The per-profile `load` callback
 * owns the model-class choice.
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

/** Aspect ratio the Qwen image processors reject above. */
const MAX_ASPECT_RATIO = 200

/**
 * Downscale so the long edge is at most `longEdge`, preserving the aspect
 * ratio, and widen a hairline crop until the processor accepts it. Alignment to
 * the model's patch grid is left to the image processor. Returns the image
 * untouched when it already satisfies both.
 */
export async function capLongEdge(image: RawImage, longEdge: number): Promise<RawImage> {
  const scale = Math.min(1, longEdge / Math.max(image.width, image.height))
  const scaled = (size: number): number => Math.max(1, Math.floor(size * scale))
  // Stretching the thin side rather than padding it: at this ratio the crop
  // holds no legible text either way, and a caption beats a thrown page.
  const shortest = Math.ceil(Math.max(scaled(image.width), scaled(image.height)) / MAX_ASPECT_RATIO)
  const width = Math.max(scaled(image.width), shortest)
  const height = Math.max(scaled(image.height), shortest)
  if (width === image.width && height === image.height) {
    return image
  }
  return image.resize(width, height)
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
