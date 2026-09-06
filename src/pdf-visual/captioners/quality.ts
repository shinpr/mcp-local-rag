// `quality` visual-quality profile — Qwen2.5-VL-3B-Instruct-ONNX.
//
// Higher fidelity than `fast` on figures with in-image text (axis labels,
// panel sub-labels), at ~10x the model cache and ~2x per-page inference on
// CPU. Shares the load/decode mechanics with `fast` via `shared.ts`, and keeps
// its own model class, prompt, resize, processor call shape and generation
// options.
//
// Three details are not inferable from the code:
//   - The image is resized to a fixed 448x448 matching the onnx-community
//     reference example, though Qwen2.5-VL supports dynamic resolution.
//   - `repetition_penalty` / `no_repeat_ngram_size`, which `fast` uses, are
//     deliberately absent: on Qwen2.5-VL they force variant generation
//     whenever a figure repeats a phrase ("Cycles per cycle" becomes "Cpu
//     cycles/cycle", then "Cnt cyles/clk").
//   - The conversation shape is hard-coded against the Qwen2.5-VL family, so a
//     non-Qwen-VL model needs a new profile.

import { AutoProcessor, Qwen2_5_VLForConditionalGeneration } from '@huggingface/transformers'

import type { Captioner } from '../types.js'
import { VlmError } from '../types.js'
import {
  createModelLoader,
  decodePngToRawImage,
  isVlmModel,
  isVlmProcessor,
  postProcess,
} from './shared.js'

const MODEL_NAME = 'onnx-community/Qwen2.5-VL-3B-Instruct-ONNX'

/**
 * Fixed input resolution (px) for the Qwen2.5-VL reference resize. Matches the
 * onnx-community Qwen2-VL example's stable-behavior fixed resize.
 */
const QWEN_INPUT_SIZE = 448

/**
 * Static prompt, tuned for retrieval indexing: scan the whole image before
 * composing, then answer as Summary + Keywords. No length specifier — length
 * is `max_new_tokens`'s job, because a spec in the prompt narrows coverage.
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
  // The explicit `Qwen2_5_VLForConditionalGeneration` class matches the
  // onnx-community reference example (rather than the architecture-agnostic
  // AutoModelForImageTextToText entry point used by `fast`).
  const loader = createModelLoader(MODEL_NAME, resolvedDevice, async ({ dtypeOpt, modelOpt }) => {
    const processor = await AutoProcessor.from_pretrained(MODEL_NAME, dtypeOpt)
    const model = await Qwen2_5_VLForConditionalGeneration.from_pretrained(MODEL_NAME, modelOpt)
    return { processor, model }
  })

  return {
    dispose: loader.dispose,
    async caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null> {
      try {
        const { processor, model } = await loader.ensureLoaded()

        // Decode PNG → RawImage, then resize to 448x448 to match the
        // onnx-community Qwen2-VL reference example. Qwen2.5-VL supports dynamic
        // resolution natively, but the reference example uses a fixed resize for
        // stable behavior; revisit if small in-figure text is lost.
        const rawImage = await (await decodePngToRawImage(pngBytes)).resize(
          QWEN_INPUT_SIZE,
          QWEN_INPUT_SIZE
        )

        // Build chat-style input. The Qwen2.5-VL conversation shape mirrors
        // the onnx-community Qwen2-VL reference: a single user turn with an
        // image placeholder followed by the text prompt.
        const messages = [
          {
            role: 'user',
            content: [{ type: 'image' }, { type: 'text', text: PROMPT }],
          },
        ]
        // The processor and model are untyped at the transformers.js boundary;
        // check the surface this profile uses. Qwen2.5-VL takes a single image
        // (not an array), per the onnx-community reference `processor(text, image)`.
        if (!isVlmProcessor(processor) || !isVlmModel(model)) {
          throw new VlmError('Loaded captioner does not expose the expected VLM surface', {
            pageNum,
          })
        }
        const proc = processor
        const mdl = model

        const chatPrompt = proc.apply_chat_template(messages, { add_generation_prompt: true })
        const inputs = await proc(chatPrompt, rawImage)

        const outputs = await mdl.generate({
          ...inputs,
          max_new_tokens: 128,
        })

        // `outputs.slice(null, [inputLen, null])` strips the prompt tokens.
        // `dims.at(-1)` reads the last dimension defensively — matches the
        // onnx-community reference example.
        const inputLen = inputs.input_ids.dims.at(-1)
        if (inputLen === undefined) {
          throw new VlmError('Captioner returned an input tensor without a token dimension', {
            pageNum,
          })
        }
        const newTokens = outputs.slice(null, [inputLen, null])

        const decoded = proc.batch_decode(newTokens, { skip_special_tokens: true })
        const text = decoded[0] ?? ''

        return postProcess(text)
      } catch (err) {
        if (err instanceof VlmError) {
          throw err
        }
        const cause = err instanceof Error ? err : new Error(String(err))
        throw new VlmError(`Captioning failed for page ${pageNum}`, { cause, pageNum })
      }
    },
  }
}
