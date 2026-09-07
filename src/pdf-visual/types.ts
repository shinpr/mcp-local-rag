// Shared types for the `pdf-visual` package: `VlmError` (the package-wide
// named error, which also carries the offending page number) plus the
// captioner's public interface.

import { AppError } from '../utils/errors.js'
import type { QualityProfile } from '../utils/visual-profile.js'

/**
 * Error raised by any module on the visual ingest path. Carries the offending
 * 1-based page number so callers can correlate it with the page list.
 */
export class VlmError extends AppError {
  public readonly pageNum: number

  constructor(message: string, options: { cause?: Error; pageNum: number }) {
    super(message, 'pdf-visual', 'internal', options)
    this.name = 'VlmError'
    this.pageNum = options.pageNum
  }
}

/**
 * Captioner configuration. The model id is not caller-tunable: the selected
 * `profile` resolves it, so prompt, chat template, processor signature,
 * generation options and model class stay coherent together.
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
 * Returns the caption, or `null` when the model produced nothing after
 * stripping and trimming — which tells the orchestrator to skip the page
 * without raising. Only load, decode and generation failures throw.
 */
export interface Captioner {
  caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null>
  dispose(): Promise<void>
}

export type VisualBBox = [number, number, number, number]

export type VisualEvidence = 'raster' | 'vector'

export interface DetectedVisualRegion {
  pageNum: number
  detectionIndex: number
  bbox: VisualBBox
  evidence: VisualEvidence
}

export type VisualImageMimeType = 'image/png' | 'image/jpeg'

export interface ImageRendition {
  bytes: Uint8Array
  mimeType: VisualImageMimeType
}

export interface ProcessedVisualRegion extends DetectedVisualRegion {
  caption: string | null
  rendition?: ImageRendition
}
