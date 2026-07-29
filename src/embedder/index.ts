// Embedder implementation with Transformers.js

import {
  type DataType,
  type DeviceType,
  env,
  ModelRegistry,
  pipeline,
} from '@huggingface/transformers'
import { AppError } from '../utils/errors.js'

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
  /**
   * Embedding quantization dtype (fp32, fp16, q8, int8, ...). Passed through to
   * transformers.js — no allowlist. Undefined means "unset": initialize() then
   * applies the fp32 default. The unset-vs-explicit-fp32 distinction is
   * preserved on purpose (it gates failure-path error enrichment).
   */
  dtype?: string
}

interface IndexedEmbeddingInput {
  text: string
  originalIndex: number
  tokenLength: number
}

interface BatchEmbeddingPipeline {
  (input: string[], options: unknown): Promise<{ data: Float32Array; dims: number[] }>
  tokenizer: (
    input: string[],
    options: {
      padding: boolean
      truncation: boolean
      return_tensor: boolean
    }
  ) => { input_ids: { length: number }[] }
}

// Keep estimated padding waste below one-third of dense self-attention work.
const MAX_PADDING_AMPLIFICATION = 1.5

function estimatePaddingAmplification(inputs: IndexedEmbeddingInput[]): number {
  let maxTokenLength = 0
  let individualWork = 0
  for (const input of inputs) {
    maxTokenLength = Math.max(maxTokenLength, input.tokenLength)
    individualWork += input.tokenLength ** 2
  }
  return (inputs.length * maxTokenLength ** 2) / individualWork
}

function deferBatchOutliers(inputs: IndexedEmbeddingInput[]): {
  batch: IndexedEmbeddingInput[]
  deferred: IndexedEmbeddingInput[]
} {
  const batch = [...inputs]
  const deferred: IndexedEmbeddingInput[] = []

  while (batch.length > 1) {
    if (estimatePaddingAmplification(batch) <= MAX_PADDING_AMPLIFICATION) {
      break
    }

    let longestIndex = 0
    for (let index = 1; index < batch.length; index++) {
      if (batch[index]!.tokenLength > batch[longestIndex]!.tokenLength) {
        longestIndex = index
      }
    }

    const longest = batch[longestIndex]!
    deferred.push(longest)
    batch.splice(longestIndex, 1)
  }

  return { batch, deferred }
}

// ============================================
// Error Classes
// ============================================

/**
 * Embedding generation error
 */
export class EmbeddingError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'embedder', 'internal', cause)
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
        // The sole fp32 default literal: unset dtype loads fp32, unchanged from
        // before this knob existed. `as DataType` mirrors the `as DeviceType`
        // cast below — a single typed pipeline boundary, no allowlist.
        dtype: (this.config.dtype ?? 'fp32') as DataType,
        device: device as DeviceType,
      })
      console.error(`Embedder: Model loaded successfully (device=${device})`)
    } catch (error) {
      const nativeError = error as Error

      // Only enrich when RAG_DTYPE was explicitly set (unset is `undefined` per
      // TD-5). Enrichment never runs on the happy path and never on the unset
      // path, so normal operation adds zero network. Always re-throw — an
      // unavailable dtype fails loud, never silently downgrades (TD-2).
      const message = await this.enrichDtypeFailureMessage(nativeError.message)
      throw new EmbeddingError(message, nativeError)
    }
  }

  /**
   * Best-effort failure-path enrichment for an explicit `RAG_DTYPE`.
   *
   * When the load failed and a dtype was explicitly requested, consult the
   * model's available dtypes and, if the requested one is absent, return a
   * message that names what the model provides. The enumeration is a Hub
   * network call wrapped in its own try/catch: if it fails (e.g. air-gapped
   * after caching) it degrades to a generic clear, dtype-aware message rather
   * than surfacing a confusing secondary error (TD-3). This method never throws
   * and never converts the load failure into a fallback — the caller always
   * re-throws.
   *
   * @param nativeMessage - The underlying load-failure message.
   * @returns The message to wrap in the thrown `EmbeddingError`.
   */
  private async enrichDtypeFailureMessage(nativeMessage: string): Promise<string> {
    const requestedDtype = this.config.dtype
    if (requestedDtype === undefined) {
      return nativeMessage
    }

    try {
      const availableDtypes = await ModelRegistry.get_available_dtypes(this.config.modelPath)
      if (availableDtypes.includes(requestedDtype)) {
        // The requested dtype exists for this model, so the load failed for some
        // other reason — keep the native message, don't misattribute it to dtype.
        return nativeMessage
      }
      return `Model "${this.config.modelPath}" provides dtypes [${availableDtypes.join(', ')}]; requested dtype "${requestedDtype}" is unavailable. Set RAG_DTYPE to one of the available dtypes, or leave it unset for the fp32 default.`
    } catch {
      // Enumeration unavailable (e.g. offline). Degrade to a generic clear,
      // dtype-aware message — no secondary error, still re-thrown by the caller.
      return `Failed to load model "${this.config.modelPath}" with requested dtype "${requestedDtype}". The model may not provide this dtype, and the available-dtype list could not be retrieved. Set RAG_DTYPE to a dtype the model provides, or leave it unset for the fp32 default. (${nativeMessage})`
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
      const modelCall = this.model as BatchEmbeddingPipeline
      const embeddings: (number[] | undefined)[] = Array.from({ length: texts.length })
      const deferred: IndexedEmbeddingInput[] = []

      const embedInputs = async (inputs: IndexedEmbeddingInput[]): Promise<void> => {
        const output = await modelCall(
          inputs.map((input) => input.text),
          options
        )

        // Validate the output shape before slicing so a runtime/model contract
        // change surfaces as a clear error rather than silently wrong vectors.
        const dim = output?.dims?.[output.dims.length - 1]
        if (
          !output ||
          !(output.data instanceof Float32Array) ||
          typeof dim !== 'number' ||
          dim <= 0 ||
          output.data.length !== inputs.length * dim
        ) {
          throw new EmbeddingError('Unexpected embedder batch output shape')
        }

        for (let row = 0; row < inputs.length; row++) {
          const input = inputs[row]!
          embeddings[input.originalIndex] = Array.from(
            output.data.subarray(row * dim, (row + 1) * dim)
          )
        }
      }

      for (let i = 0; i < texts.length; i += this.config.batchSize) {
        const batchTexts = texts.slice(i, i + this.config.batchSize)
        const tokenized = modelCall.tokenizer(batchTexts, {
          padding: false,
          truncation: true,
          return_tensor: false,
        })
        if (
          !tokenized ||
          !Array.isArray(tokenized.input_ids) ||
          tokenized.input_ids.length !== batchTexts.length
        ) {
          throw new EmbeddingError('Unexpected embedder tokenizer output shape')
        }

        const indexedInputs = batchTexts.map((text, batchIndex) => ({
          text,
          originalIndex: i + batchIndex,
          tokenLength: tokenized.input_ids[batchIndex]!.length,
        }))
        const selected = deferBatchOutliers(indexedInputs)
        deferred.push(...selected.deferred)
        await embedInputs(selected.batch)
      }

      for (const input of deferred) {
        await embedInputs([input])
      }

      if (embeddings.some((embedding) => embedding === undefined)) {
        throw new EmbeddingError('Missing embedder batch output row')
      }

      return embeddings as number[][]
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
