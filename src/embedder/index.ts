// Embedder implementation with Transformers.js

import { type DeviceType, env, pipeline } from '@huggingface/transformers'

// ============================================
// Type Definitions
// ============================================

/**
 * Embedder configuration
 */
export interface EmbedderConfig {
  /** HuggingFace model path */
  modelPath: string
  /** Batch size */
  batchSize: number
  /** Model cache directory */
  cacheDir: string
  /** Device type */
  device?: string
}

// ============================================
// Error Classes
// ============================================

/**
 * Embedding generation error
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

// ============================================
// Embedder Class
// ============================================

/**
 * Embedding generation class using Transformers.js
 *
 * Responsibilities:
 * - Generate embedding vectors (dimension depends on model)
 * - Transformers.js wrapper
 * - Batch processing (size 8)
 */
export class Embedder {
  // Using unknown to avoid TS2590 (union type too complex with @types/jsdom)
  private model: unknown = null
  private initPromise: Promise<void> | null = null
  private readonly config: EmbedderConfig

  constructor(config: EmbedderConfig) {
    this.config = config
  }

  /**
   * Release resources held by the Embedder pipeline
   */
  async dispose(): Promise<void> {
    const model = this.model as { dispose?: () => Promise<void> } | null
    if (model && typeof model.dispose === 'function') {
      try {
        await model.dispose()
      } catch (error) {
        console.error('Error disposing embedder model:', error)
      }
    }
    this.model = null
    this.initPromise = null
  }

  /**
   * Initialize Transformers.js model
   */
  async initialize(): Promise<void> {
    // Skip if already initialized
    if (this.model) {
      return
    }

    // Set cache directory BEFORE creating pipeline
    env.cacheDir = this.config.cacheDir

    // No fallback — if the requested device fails, init throws.
    const device = this.config.device || 'cpu'

    console.error(`Embedder: Setting cache directory to "${this.config.cacheDir}"`)
    console.error(`Embedder: Loading model "${this.config.modelPath}" on device "${device}"...`)

    try {
      this.model = await pipeline('feature-extraction', this.config.modelPath, {
        dtype: 'fp32',
        device: device as DeviceType,
      })
      console.error(`Embedder: Model loaded successfully (device=${device})`)
    } catch (error) {
      // Don't prepend "device=X" — the prior stderr line already says which
      // device was attempted, and transformers.js' own errors typically
      // include the device name. Just re-type the error.
      throw new EmbeddingError((error as Error).message, error as Error)
    }
  }

  /**
   * Ensure model is initialized (lazy initialization)
   * This method is called automatically by embed() and embedBatch()
   */
  private async ensureInitialized(): Promise<void> {
    // Already initialized
    if (this.model) {
      return
    }

    // Initialization already in progress, wait for it
    if (this.initPromise) {
      await this.initPromise
      return
    }

    console.error(
      'Embedder: First use detected. Initializing model (downloading ~90MB, may take 1-2 minutes)...'
    )

    this.initPromise = this.initialize().catch((error) => {
      // Clear initPromise on failure to allow retry on the next call.
      this.initPromise = null
      throw error
    })

    await this.initPromise
  }

  /**
   * Convert single text to embedding vector
   *
   * @param text - Text
   * @returns Embedding vector (dimension depends on model)
   */
  async embed(text: string): Promise<number[]> {
    // Reject empty input before paying for model init.
    if (text.length === 0) {
      throw new EmbeddingError('Cannot generate embedding for empty text')
    }

    // Lazy initialization: initialize on first use if not already initialized
    await this.ensureInitialized()

    try {
      const options = { pooling: 'mean', normalize: true }
      const modelCall = this.model as (
        text: string,
        options: unknown
      ) => Promise<{ data: Float32Array }>
      const output = await modelCall(text, options)

      // Access raw data via .data property
      const embedding = Array.from(output.data)
      return embedding
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error
      }
      throw new EmbeddingError(
        `Failed to generate embedding: ${(error as Error).message}`,
        error as Error
      )
    }
  }

  /**
   * Convert multiple texts to embedding vectors with batch processing
   *
   * @param texts - Array of texts
   * @returns Array of embedding vectors (dimension depends on model)
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Nothing to embed → skip model init entirely.
    if (texts.length === 0) {
      return []
    }

    // Preserve embed()'s empty-text contract for batch elements (the previous
    // per-text implementation rejected empty strings via embed()).
    if (texts.some((text) => text.length === 0)) {
      throw new EmbeddingError('Cannot generate embedding for empty text')
    }

    // Lazy initialization: initialize on first use if not already initialized
    await this.ensureInitialized()

    try {
      const options = { pooling: 'mean', normalize: true }
      // True batched inference: the feature-extraction pipeline accepts an
      // array of texts and returns a single [batchLen, dim] tensor in one
      // forward pass. The previous implementation called the model once per
      // text via Promise.all, so `batchSize` had no real effect (onnxruntime
      // inference is not parallelized by Promise.all). Passing the whole batch
      // lets the runtime batch the matmuls. Mean-pooling honors the attention
      // mask, so per-row vectors match the single-text result.
      const modelCall = this.model as (
        input: string[],
        options: unknown
      ) => Promise<{ data: Float32Array; dims: number[] }>

      const embeddings: number[][] = []
      for (let i = 0; i < texts.length; i += this.config.batchSize) {
        const batch = texts.slice(i, i + this.config.batchSize)
        const output = await modelCall(batch, options)

        // Validate the output shape before slicing so a runtime/model contract
        // change surfaces as a clear error rather than silently wrong vectors.
        const dim = output?.dims?.[output.dims.length - 1]
        if (
          !output ||
          !(output.data instanceof Float32Array) ||
          typeof dim !== 'number' ||
          dim <= 0 ||
          output.data.length !== batch.length * dim
        ) {
          throw new EmbeddingError('Unexpected embedder batch output shape')
        }

        for (let row = 0; row < batch.length; row++) {
          embeddings.push(Array.from(output.data.subarray(row * dim, (row + 1) * dim)))
        }
      }

      return embeddings
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error
      }
      throw new EmbeddingError(
        `Failed to generate batch embeddings: ${(error as Error).message}`,
        error as Error
      )
    }
  }
}
