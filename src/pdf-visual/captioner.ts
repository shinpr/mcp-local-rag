// Thin VLM wrapper for the visual ingest path.
//
// Wraps `@huggingface/transformers` direct model instantiation
// (`AutoProcessor.from_pretrained` + `AutoModelForImageTextToText.from_pretrained`)
// behind a small `Captioner` interface. Lazy-loads the processor and model
// on the first `caption()` call to keep the default (`visual: false`) path
// zero-overhead.
//
// Implementation contract (DD § Component → pdf-visual/captioner.ts):
//   1. Set `env.cacheDir = config.cacheDir` BEFORE any `from_pretrained` call
//      (defensive ordering — does not depend on `Embedder.initialize()`).
//   2. Lazy-load processor + model on first `caption()` call. Normalize the
//      incoming dtype via `config.dtype || DEFAULT_VLM_DTYPE` and pass
//      `{ dtype: resolvedDtype }` to `from_pretrained`.
//   3. Decode PNG bytes via `RawImage.fromBlob(new Blob([pngBytes], { type: 'image/png' }))`.
//   4. Build chat-style input via `processor.apply_chat_template(messages,
//      { add_generation_prompt: true })` with the IDEFICS3 conversation shape
//      (probe-verified Phase 1).
//   5. Call `model.generate({ ...inputs, max_new_tokens: 128 })`.
//   6. Decode via `processor.batch_decode(newTokens, { skip_special_tokens: true })`
//      where `newTokens = outputs.slice(null, [inputs.input_ids.dims[1], null])`.
//   7. Post-processing (single source of truth, in this order):
//        - Strip C0 / C1 control chars except `\n` and `\t`.
//        - Trim surrounding whitespace.
//        - Empty → return `null`.
//        - length > 1000 → truncate to 1000 + `…` (final length 1001).
//   8. On model load / image decode / generation failure throw `VlmError`
//      with `pageNum` + `cause`. The empty-caption `null` return is NOT a
//      failure.
//
// `DEFAULT_VLM_DTYPE = 'q4'` is probe-verified (Phase 1,
// `tmp/probe/probe-results/probe-vlm-dtype.json`) as the smallest viable
// variant of `onnx-community/granite-docling-258M-ONNX`. Exported solely so
// tests can assert against the literal without re-declaring it.

import {
  AutoModelForImageTextToText,
  AutoProcessor,
  env,
  RawImage,
} from '@huggingface/transformers'

import type { Captioner, CaptionerConfig } from './types.js'
import { VlmError } from './types.js'

/**
 * Probe-verified smallest viable ONNX quantization variant for
 * `onnx-community/granite-docling-258M-ONNX`. The captioner replaces an empty
 * `CaptionerConfig.dtype` with this value immediately before `from_pretrained`.
 */
export const DEFAULT_VLM_DTYPE = 'q4'

/**
 * Static prompt — tuned for "describe for search retrieval" not "describe for
 * a blind reader". Embedded as a module constant per DD § Captioner.
 */
const PROMPT =
  'Describe the visual content for search retrieval. List the chart type, axes, ' +
  'labels, and any prominent visual elements. Use keywords and structural terms.'

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
    if (code <= 0x1f) continue
    if (code >= 0x7f && code <= 0x9f) continue
    out += input[i]
  }
  return out
}

/**
 * Apply the post-generation processing rules (DD § Captioner contract step 6).
 * Returns the final caption or `null` when the result is empty after stripping.
 */
function postProcess(decoded: string): string | null {
  const stripped = stripControlChars(decoded).trim()
  if (stripped.length === 0) return null
  if (stripped.length > 1000) return `${stripped.slice(0, 1000)}…`
  return stripped
}

/**
 * Create a captioner backed by the configured VLM. Sets `env.cacheDir`
 * immediately so the global is correct even if the captioner is constructed
 * before any embedder initializes.
 */
export function createCaptioner(config: CaptionerConfig): Captioner {
  // Defensive ordering: set the global cacheDir at construction so the very
  // first `from_pretrained` call sees the right value. Setting the same
  // global twice with the same value is idempotent (shared with the
  // embedder).
  env.cacheDir = config.cacheDir

  // The captioner is the single normalization site for dtype.
  const resolvedDtype = config.dtype || DEFAULT_VLM_DTYPE

  // Lazy-loaded singletons. `unknown` is used to keep the surface small and
  // avoid pulling private types from `@huggingface/transformers`.
  let processor: unknown = null
  let model: unknown = null

  async function ensureLoaded(): Promise<void> {
    if (processor !== null && model !== null) return
    // Both classes accept `{ dtype }` (probe-verified Phase 1). They are
    // loaded in sequence because the second resolves the runtime class
    // (`Idefics3ForConditionalGeneration` for the default model) via the
    // architecture-agnostic `AutoModelForImageTextToText` entry point.
    // The transformers.js declared `dtype` is a literal union; the env
    // resolution layer's regex (`/^[a-zA-Z0-9_]*$/`) already constrains the
    // string set, so cast through `unknown` here to widen-to-string-then-back.
    const dtypeOpt = { dtype: resolvedDtype } as unknown as { dtype: 'q4' }
    processor = await AutoProcessor.from_pretrained(config.modelName, dtypeOpt)
    model = await AutoModelForImageTextToText.from_pretrained(config.modelName, dtypeOpt)
  }

  return {
    async caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null> {
      try {
        await ensureLoaded()

        // Decode PNG → RawImage. `Blob` accepts `Uint8Array` directly (the
        // renderer returns `Uint8Array` from `Pixmap.asPNG()`, not `Buffer`).
        // The `BlobPart` type does not include `Uint8Array<ArrayBufferLike>`
        // due to SharedArrayBuffer subtyping; cast through unknown.
        const blob = new Blob([pngBytes as unknown as ArrayBuffer], { type: 'image/png' })
        const rawImage = await RawImage.fromBlob(blob)

        // Build chat-style input. The IDEFICS3 conversation shape is
        // probe-verified for `Idefics3Processor.apply_chat_template`.
        const messages = [
          {
            role: 'user',
            content: [{ type: 'image' }, { type: 'text', text: PROMPT }],
          },
        ]
        // The processor and model are dynamic in type at the boundary;
        // narrow to a minimal callable / generate-able shape here.
        const proc = processor as {
          apply_chat_template: (m: unknown, o: { add_generation_prompt: boolean }) => string
          batch_decode: (t: unknown, o: { skip_special_tokens: boolean }) => string[]
        } & ((prompt: string, images: unknown[]) => Promise<{ input_ids: { dims: number[] } }>)
        const mdl = model as {
          generate: (inputs: unknown) => Promise<{
            slice: (axis: null, range: [number, number | null]) => unknown
          }>
        }

        const chatPrompt = proc.apply_chat_template(messages, { add_generation_prompt: true })
        const inputs = await proc(chatPrompt, [rawImage])

        const outputs = await mdl.generate({ ...inputs, max_new_tokens: 128 })

        // `outputs.slice(null, [inputLen, null])` strips the prompt tokens.
        const inputLen = inputs.input_ids.dims[1] as number
        const newTokens = outputs.slice(null, [inputLen, null])

        const decoded = proc.batch_decode(newTokens, { skip_special_tokens: true })
        const text = decoded[0] ?? ''

        return postProcess(text)
      } catch (err) {
        if (err instanceof VlmError) throw err
        const cause = err instanceof Error ? err : new Error(String(err))
        throw new VlmError(`Captioning failed for page ${pageNum}`, { cause, pageNum })
      }
    },
  }
}
