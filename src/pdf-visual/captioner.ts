// Captioner dispatcher for the visual ingest path.
//
// `createCaptioner(config)` selects the underlying VLM family based on the
// `QualityProfile` and returns a `Captioner`. Each profile is implemented as a
// self-contained module under `./captioners/` so that prompt, chat template,
// processor signature, generation options, and model class stay coherent per
// profile.
//
// Profiles:
//   - `fast`    → `captioners/fast.ts`    (SmolVLM-256M-Instruct, IDEFICS3).
//                 Lightweight default; ~250 MB cache.
//   - `quality` → `captioners/quality.ts` (Qwen2.5-VL-3B-Instruct-ONNX).
//                 Higher fidelity on figures with in-image text; ~2.9 GB cache,
//                 ~2× per-page inference relative to `fast`.
//
// `env.cacheDir` is set once here (not inside the per-profile modules) so the
// shared global is configured before either profile's `from_pretrained` runs
// and the per-profile modules stay free of the global side effect.
//
// `VLM_DTYPE` is exported for legacy test compatibility — it reflects the
// quantization variant currently used by both profiles.

import { env } from '@huggingface/transformers'

import { createFastCaptioner } from './captioners/fast.js'
import { createQualityCaptioner } from './captioners/quality.js'
import type { Captioner, CaptionerConfig } from './types.js'

/**
 * ONNX quantization variant. Pinned to the smallest viable variant for both
 * profiles. Exposed for tests only — production has no user-facing knob.
 */
export const VLM_DTYPE = 'q4'

/**
 * Create a captioner for the requested visual-quality profile. Sets
 * `env.cacheDir` immediately so the global is correct even if the captioner
 * is constructed before any embedder initializes.
 *
 * Concurrency assumption: `env.cacheDir` is a process-global from
 * `@huggingface/transformers`. Setting it here at construction time is safe
 * for the current single-instance usage (one captioner per ingest run). If
 * the codebase ever constructs multiple captioners with DIFFERENT `cacheDir`
 * values in parallel, the last writer wins and the first captioner's
 * `from_pretrained` may resolve against the wrong cache. Avoid concurrent
 * construction with differing cacheDirs.
 */
export function createCaptioner(config: CaptionerConfig): Captioner {
  // Defensive ordering: set the global cacheDir at construction so the very
  // first `from_pretrained` call sees the right value. Setting the same
  // global twice with the same value is idempotent (shared with the
  // embedder).
  env.cacheDir = config.cacheDir

  const resolvedDevice = config.device || 'cpu'

  switch (config.profile) {
    case 'fast':
      return createFastCaptioner(resolvedDevice)
    case 'quality':
      // Load failures from the heavier Qwen2.5-VL model propagate as the
      // wrapped Error (later re-thrown per-page as `VlmError`) — there is
      // deliberately no silent fallback to `fast` so a misconfigured
      // `quality` install surfaces immediately.
      return createQualityCaptioner(resolvedDevice)
  }
}
