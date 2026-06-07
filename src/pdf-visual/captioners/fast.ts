// `fast` visual-quality profile — SmolVLM-256M-Instruct / IDEFICS3.
//
// Shares the profile-agnostic load/decode mechanics with `quality` via
// `shared.ts` (`createModelLoader`, `decodePngToRawImage`, `VLM_DTYPE`,
// post-processing). The profile-specific parts — model class, prompt,
// processor call shape, and generation options — stay here so `fast` and
// `quality` can diverge on exactly the parts that genuinely differ.
//
// Implementation contract (matches HEAD captioner contract steps 2–8):
//   1. Lazy-load processor + model on first `caption()` call with the pinned
//      `VLM_DTYPE` and the resolved device. `env.cacheDir` is set by the
//      dispatcher (`captioner.ts`) before this profile is constructed.
//   2. Decode PNG bytes via `RawImage.fromBlob(new Blob([pngBytes], { type:
//      'image/png' }))`. SmolVLM-256M is NOT resized client-side — IDEFICS3's
//      processor handles its own preprocessing.
//   3. Build chat-style input via `processor.apply_chat_template(messages,
//      { add_generation_prompt: true })` with the IDEFICS3 conversation shape
//      `[{role:'user', content:[{type:'image'},{type:'text',text:...}]}]`.
//      Probe-verified.
//   4. Call `model.generate({ ...inputs, max_new_tokens: 128,
//      repetition_penalty: 1.15, no_repeat_ngram_size: 3 })` — these
//      generation options are tuned for SmolVLM-256M and MUST stay on the
//      `fast` profile (they cause forced variant generation on Qwen2.5-VL,
//      which is why the `quality` profile drops them).
//   5. Decode via `processor.batch_decode(newTokens, { skip_special_tokens: true })`
//      where `newTokens = outputs.slice(null, [inputs.input_ids.dims[1], null])`.
//   6. Post-processing via `shared.postProcess` (control-char strip, trim,
//      empty → `null`, length > 1000 → truncate + `…`).
//   7. On model load / image decode / generation failure throw `VlmError`
//      with `pageNum` + `cause`.

import { AutoModelForImageTextToText, AutoProcessor } from '@huggingface/transformers'

import type { Captioner } from '../types.js'
import { VlmError } from '../types.js'
import { createModelLoader, decodePngToRawImage, postProcess } from './shared.js'

const MODEL_NAME = 'HuggingFaceTB/SmolVLM-256M-Instruct'

/**
 * Static prompt — tuned for "describe for search retrieval" not "describe for
 * a blind reader". It asks for retrieval-relevant detail rather than a short
 * summary, while keeping claims grounded in visible evidence.
 */
const PROMPT =
  'Write search text for this PDF page image. Include visible section names, visual titles, ' +
  'headings, labels, legends, axes, row or column names, UI text, metric names, identifiers, ' +
  'proper nouns, and flow or diagram step names. Prefer exact readable words from the image. ' +
  'Cover the main visual regions across the page. Use short searchable phrases separated by ' +
  'commas or semicolons. Use only readable or visually evident details. Use each phrase once.'

/**
 * Create a `fast` profile captioner. The dispatcher has already configured
 * `env.cacheDir`; this profile only owns lazy model loading and inference.
 */
export function createFastCaptioner(resolvedDevice: string): Captioner {
  // Both classes accept `{ dtype }` (probe-verified). They load in sequence
  // because the second resolves the runtime class
  // (`Idefics3ForConditionalGeneration` for the default model) via the
  // architecture-agnostic `AutoModelForImageTextToText` entry point.
  const loader = createModelLoader(MODEL_NAME, resolvedDevice, async ({ dtypeOpt, modelOpt }) => {
    const processor = await AutoProcessor.from_pretrained(MODEL_NAME, dtypeOpt)
    const model = await AutoModelForImageTextToText.from_pretrained(MODEL_NAME, modelOpt)
    return { processor, model }
  })

  return {
    async caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null> {
      try {
        const { processor, model } = await loader.ensureLoaded()

        // Decode PNG → RawImage. SmolVLM-256M is NOT resized client-side —
        // IDEFICS3's processor handles its own preprocessing.
        const rawImage = await decodePngToRawImage(pngBytes)

        // Build chat-style input. The IDEFICS3 conversation shape is
        // probe-verified for `Idefics3Processor.apply_chat_template`.
        const messages = [
          {
            role: 'user',
            content: [{ type: 'image' }, { type: 'text', text: PROMPT }],
          },
        ]
        // The processor and model are dynamic in type at the boundary;
        // narrow to a minimal callable / generate-able shape here. IDEFICS3
        // processor takes an array of images.
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

        const outputs = await mdl.generate({
          ...inputs,
          max_new_tokens: 128,
          repetition_penalty: 1.15,
          no_repeat_ngram_size: 3,
        })

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
