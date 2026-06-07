// Shared types for the `pdf-visual` package.
//
// `VlmError` is the package-wide named error for the visual ingest path.
// `renderer.ts`, `captioner.ts`, and the orchestrator (`index.ts`) import it
// from this single source. Shape mirrors `ValidationError`: a named class
// extending `Error`, with `name` assignment and a public override `cause`.
//
// `CaptionerConfig` / `Captioner` are the captioner's public interface,
// shared across the visual ingest modules.

/**
 * Error raised by any module on the visual ingest path. Carries the offending
 * 1-based page number so callers can correlate it with the page list.
 */
export class VlmError extends Error {
  public override readonly cause?: Error
  public readonly pageNum: number

  constructor(message: string, options: { cause?: Error; pageNum: number }) {
    super(message)
    this.name = 'VlmError'
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
    this.pageNum = options.pageNum
  }
}

/**
 * Visual-quality profile selector. Each profile resolves to a self-contained
 * captioner implementation under `captioners/`. `fast` ports the original
 * SmolVLM-256M / IDEFICS3 captioner (lightweight default, ~250 MB cache);
 * `quality` ports the Qwen2.5-VL-3B-Instruct-ONNX captioner (~2.9 GB cache,
 * ~2× per-page inference, higher fidelity on figures with in-image text).
 */
export type QualityProfile = 'fast' | 'quality'

/**
 * Captioner configuration. The model identifier is no longer caller-tunable;
 * it is resolved inside the selected `profile` so that prompt, chat template,
 * processor signature, generation options, and model class stay coherent per
 * profile.
 */
export interface CaptionerConfig {
  /** Visual-quality profile — selects the underlying VLM family. */
  profile: QualityProfile
  /** Model cache directory (shared with the embedder via `env.cacheDir`). */
  cacheDir: string
  /** Execution device passed through to Transformers.js model loading. */
  device?: string | undefined
}

/**
 * Captioner public surface. Returns the caption string or `null` when the
 * model produced an empty result (after control-char stripping + whitespace
 * trim). A `null` return signals the orchestrator to skip this page without
 * raising — only model load / image decode / generation failures throw.
 */
export interface Captioner {
  caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null>
}
