// `quality` visual-quality profile — Qwen2.5-VL-3B-Instruct-ONNX.
//
// Verbatim port of the working-tree captioner validated during the visual-
// quality design discussion. Higher fidelity than `fast` on figures with
// in-image text (axis labels, panel sub-labels, annotations), at the cost of
// a materially larger model cache (~10× `fast`) and ~2× per-page inference
// time on CPU. Self-contained so `fast.ts` can stay frozen at v0.14.0.
//
// Implementation contract:
//   1. Lazy-load processor + model on first `caption()` call with the pinned
//      DTYPE and the resolved device. `env.cacheDir` is set by the dispatcher
//      (`captioner.ts`) before this profile is constructed.
//   2. Decode PNG bytes via `RawImage.fromBlob(...)` and resize to 448x448 —
//      matches the onnx-community Qwen2-VL reference example. Qwen2.5-VL
//      supports dynamic resolution natively, but the reference example uses
//      a fixed resize for stable behavior.
//   3. Build chat-style input via `processor.apply_chat_template(messages,
//      { add_generation_prompt: true })` with the Qwen2.5-VL conversation
//      shape `[{role:'user', content:[{type:'image'},{type:'text',text:...}]}]`.
//      The shape is hard-coded against the Qwen2.5-VL family; swapping in a
//      non-Qwen-VL model requires a new profile.
//   4. Call `model.generate({ ...inputs, max_new_tokens: 128 })`. The
//      `repetition_penalty` / `no_repeat_ngram_size` options used by `fast`
//      are intentionally absent — on Qwen2.5-VL they cause forced variant
//      generation (e.g. "Cycles per cycle" → "Cpu cycles/cycle" → "Cnt
//      cyles/clk") whenever a figure naturally repeats a phrase.
//   5. Decode via `processor.batch_decode(newTokens, { skip_special_tokens: true })`
//      where `newTokens = outputs.slice(null, [inputs.input_ids.dims.at(-1), null])`.
//      `dims.at(-1)` reads the last dimension defensively — matches the
//      onnx-community reference example.
//   6. Post-processing via `shared.postProcess` (same pipeline as `fast`).
//   7. On model load / image decode / generation failure throw `VlmError`
//      with `pageNum` + `cause`. No silent fallback to `fast`.

import {
  AutoProcessor,
  type DeviceType,
  Qwen2_5_VLForConditionalGeneration,
  RawImage,
} from '@huggingface/transformers'

import type { Captioner } from '../types.js'
import { VlmError } from '../types.js'
import { postProcess } from './shared.js'

const MODEL_NAME = 'onnx-community/Qwen2.5-VL-3B-Instruct-ONNX'

/**
 * ONNX quantization variant. Pinned to `q4` for the same disk-footprint /
 * accuracy trade-off applied to `fast`. Local to this profile so it can be
 * tuned independently if the `quality` model gains a smaller viable variant.
 */
const DTYPE = 'q4'

/**
 * Static prompt — tuned for retrieval search indexing. Asks the VLM to scan
 * the whole image before composing output so coverage spans every region,
 * then produces a two-part response (Summary + Keywords) suitable for
 * embedding + downstream semantic / lexical search. No length specifiers —
 * output length is controlled by `max_new_tokens` because length specs
 * narrow coverage.
 */
const PROMPT = `Describe this PDF page image for retrieval search indexing.

Procedure:
1. Scan the whole image and identify every distinct region.
2. Compose the output from across all regions identified.

Output exactly two parts:

Summary: Describe the page's content, including its type and subject when identifiable.

Keywords: Phrases separated by semicolons. Capture readable text and visible labels from across the page — including section titles, sub-labels inside figures, tables, panels, or annotations. Use exact wording from the image when readable. Cover the visible regions of the page. List each phrase once.

Use only details visible in the image. If a region is unreadable, skip it.`

/**
 * Create a `quality` profile captioner. The dispatcher has already configured
 * `env.cacheDir`; this profile only owns lazy model loading and inference.
 */
export function createQualityCaptioner(resolvedDevice: string): Captioner {
  let processor: unknown = null
  let model: unknown = null

  type LoadState = { kind: 'pending' } | { kind: 'ok' } | { kind: 'failed'; cause: Error }
  let loadState: LoadState = { kind: 'pending' }

  async function ensureLoaded(): Promise<void> {
    if (loadState.kind === 'ok') return
    if (loadState.kind === 'failed') throw loadState.cause
    try {
      // Both classes accept `{ dtype }`. They load in sequence because the
      // second resolves the runtime class — using the explicit
      // `Qwen2_5_VLForConditionalGeneration` class matches the onnx-community
      // reference example. The transformers.js declared `dtype` is a literal
      // union; cast through `unknown` to widen-to-string-then-back.
      const dtypeOpt = { dtype: DTYPE } as unknown as { dtype: 'q4' }
      const modelOpt = { dtype: DTYPE, device: resolvedDevice } as unknown as {
        dtype: 'q4'
        device: DeviceType
      }
      processor = await AutoProcessor.from_pretrained(MODEL_NAME, dtypeOpt)
      model = await Qwen2_5_VLForConditionalGeneration.from_pretrained(MODEL_NAME, modelOpt)
      loadState = { kind: 'ok' }
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err))
      const wrapped = new Error(
        `Captioner load failed (modelName=${MODEL_NAME}, device=${resolvedDevice}): ${original.message}`,
        { cause: original }
      )
      loadState = { kind: 'failed', cause: wrapped }
      throw wrapped
    }
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
        // Resize to 448x448 to match the onnx-community Qwen2-VL reference
        // example. Qwen2.5-VL supports dynamic resolution natively, but the
        // reference example uses a fixed resize for stable behavior; revisit
        // if empirical results show small in-figure text being lost.
        const rawImage = await (await RawImage.fromBlob(blob)).resize(448, 448)

        // Build chat-style input. The Qwen2.5-VL conversation shape mirrors
        // the onnx-community Qwen2-VL reference: a single user turn with an
        // image placeholder followed by the text prompt.
        const messages = [
          {
            role: 'user',
            content: [{ type: 'image' }, { type: 'text', text: PROMPT }],
          },
        ]
        // The processor and model are dynamic in type at the boundary;
        // narrow to a minimal callable / generate-able shape here. Qwen2.5-VL
        // processor takes a single image (not an array), per the
        // onnx-community reference example signature `processor(text, image)`.
        const proc = processor as {
          apply_chat_template: (m: unknown, o: { add_generation_prompt: boolean }) => string
          batch_decode: (t: unknown, o: { skip_special_tokens: boolean }) => string[]
        } & ((prompt: string, image: unknown) => Promise<{ input_ids: { dims: number[] } }>)
        const mdl = model as {
          generate: (inputs: unknown) => Promise<{
            slice: (axis: null, range: [number, number | null]) => unknown
          }>
        }

        const chatPrompt = proc.apply_chat_template(messages, { add_generation_prompt: true })
        const inputs = await proc(chatPrompt, rawImage)

        const outputs = await mdl.generate({
          ...inputs,
          max_new_tokens: 128,
        })

        // `outputs.slice(null, [inputLen, null])` strips the prompt tokens.
        // `dims.at(-1)` reads the last dimension defensively — matches the
        // onnx-community reference example.
        const inputLen = inputs.input_ids.dims.at(-1) as number
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
