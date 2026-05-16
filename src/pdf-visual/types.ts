// Shared types for the `pdf-visual` package.
//
// `VlmError` is the package-wide named error for the visual ingest path. It
// was originally staged in `renderer.ts` (T3.1) and promoted here at T3.3 so
// that `renderer.ts`, `captioner.ts`, and the orchestrator (`index.ts`) can
// all import from a single source. Shape mirrors
// `src/parser/index.ts:54-62`'s `ValidationError` pattern: a named class
// extending `Error`, with `name` assignment and a public override `cause`.
//
// `CaptionerConfig` / `Captioner` are the captioner's public interface,
// declared per DD § Component → pdf-visual/captioner.ts.

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
 * Captioner configuration.
 *
 * The captioner is the single normalization site for `dtype`: an empty string
 * passed here is replaced with the module-internal `DEFAULT_VLM_DTYPE` before
 * being forwarded to `from_pretrained`. The env-resolution layer therefore
 * does NOT default an empty string — it passes through what it observes.
 */
export interface CaptionerConfig {
  /** HuggingFace model identifier (resolved from `VLM_MODEL_NAME` env or default). */
  modelName: string
  /** Model cache directory (shared with the embedder via `env.cacheDir`). */
  cacheDir: string
  /**
   * ONNX quantization variant. May be the empty string; the captioner
   * normalizes empty to `DEFAULT_VLM_DTYPE` before `from_pretrained`.
   */
  dtype: string
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
