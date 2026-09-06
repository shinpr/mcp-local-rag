// Captioner dispatcher for the visual ingest path. Each profile is a
// self-contained module under `./captioners/`, so prompt, chat template,
// processor signature, generation options and model class stay coherent per
// profile.
//
// `env.cacheDir` is set once here rather than in the per-profile modules, so
// the shared global is configured before either `from_pretrained` runs and the
// profiles stay free of the side effect.

import { env } from '@huggingface/transformers'

import { createFastCaptioner } from './captioners/fast.js'
import { createQualityCaptioner } from './captioners/quality.js'
import type { Captioner, CaptionerConfig } from './types.js'

/**
 * Create a captioner for the requested profile, setting `env.cacheDir`
 * immediately so the global is right even if no embedder has initialized.
 *
 * `env.cacheDir` is a transformers.js process global, so constructing two
 * captioners with DIFFERENT cacheDirs in parallel would let the last writer
 * win. Safe for the current one-captioner-per-run usage.
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
      // No silent fallback to `fast`. A load failure surfaces as a `VlmError`
      // per page and the file still ingests text-only, so a misconfigured
      // install degrades visibly instead of being masked by a quieter model.
      return createQualityCaptioner(resolvedDevice)
    default: {
      // Exhaustiveness guard. `QualityProfile` is statically narrow at the
      // call sites (CLI + MCP both validate before reaching here) so this
      // branch is unreachable today; the throw is defensive for future
      // ProfileType additions that forget to extend this switch.
      const _exhaustive: never = config.profile
      throw new Error(`Unknown QualityProfile: ${String(_exhaustive)}`)
    }
  }
}
