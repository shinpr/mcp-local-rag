// The visual-quality profile vocabulary, shared by ingestion, storage-facing
// planning, CLI and MCP. It lives in `utils/` so a consumer that only needs the
// domain value never takes a runtime dependency on the VLM modules.

import { isMemberOf } from './type-guards.js'

/**
 * Visual-quality profile. `fast` is SmolVLM-256M / IDEFICS3 (~250 MB cache);
 * `quality` is Qwen2.5-VL-3B-Instruct-ONNX (~2.9 GB, ~2x per-page inference,
 * better on figures with in-image text).
 */
export const QUALITY_PROFILES = ['fast', 'quality'] as const
export type QualityProfile = (typeof QUALITY_PROFILES)[number]

/** True for one of the supported profiles; anything else, including a stored legacy value, is not. */
export function isQualityProfile(value: unknown): value is QualityProfile {
  return typeof value === 'string' && isMemberOf(QUALITY_PROFILES, value)
}
