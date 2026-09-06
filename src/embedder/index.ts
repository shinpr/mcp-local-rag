// Embedder implementation with Transformers.js

import {
  type DataType,
  type DeviceType,
  env,
  ModelRegistry,
  pipeline,
} from '@huggingface/transformers'
import { AppError, toError } from '../utils/errors.js'
import { isObjectLike } from '../utils/type-guards.js'

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
   * Quantization dtype, passed through to transformers.js with no allowlist.
   * `undefined` means unset, which `initialize()` resolves to fp32 — the
   * distinction gates failure-path error enrichment, so keep it.
   */
  dtype?: string
}

interface IndexedEmbeddingInput {
  text: string
  originalIndex: number
  tokenLength: number
}

/**
 * The transformers.js pipeline as this module calls it.
 *
 * Every result field is typed as loosely as the runtime admits — `dims`
 * included, since {@link isEmbeddingPipeline} establishes only that the value
 * is callable and carries a `tokenizer`. That keeps each call site's own shape
 * check load-bearing rather than dead under an optimistic declaration.
 */
interface EmbeddingPipeline {
  (input: string, options: unknown): Promise<{ data?: unknown; dims?: unknown } | null | undefined>
  (
    input: string[],
    options: unknown
  ): Promise<{ data?: unknown; dims?: unknown } | null | undefined>
  tokenizer: (
    input: string[],
    options: {
      padding: boolean
      truncation: boolean
      return_tensor: boolean
    }
  ) => { input_ids?: unknown } | null | undefined
}

/** True when the loaded pipeline exposes the call and tokenizer surface used here. */
function isEmbeddingPipeline(value: unknown): value is EmbeddingPipeline {
  return (
    typeof value === 'function' && 'tokenizer' in value && typeof value.tokenizer === 'function'
  )
}

/** True when every entry exposes the numeric `length` the batching math reads. */
function isTokenLengthArray(value: unknown): value is { length: number }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'length' in entry &&
        typeof entry.length === 'number'
    )
  )
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
    let longestTokens = batch[0]?.tokenLength ?? 0
    for (let index = 1; index < batch.length; index++) {
      const tokenLength = batch[index]?.tokenLength ?? 0
      if (tokenLength > longestTokens) {
        longestIndex = index
        longestTokens = tokenLength
      }
    }

    const longest = batch[longestIndex]
    if (longest === undefined) {
      break
    }
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
  constructor(message: string, options?: { cause?: Error }) {
    super(message, 'embedder', 'internal', options)
    this.name = 'EmbeddingError'
  }
}

// ============================================
// Embedder Class
// ============================================

/** Transformers.js wrapper: lazily loaded model, batched embedding. */
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
    const model: unknown = this.model
    const dispose = isObjectLike(model) ? model['dispose'] : undefined
    if (typeof dispose === 'function') {
      try {
        await dispose.call(model)
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
        // The sole fp32 default literal. Both values pass through
        // un-allowlisted (see `resolveDevice`) into a closed literal union.
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: un-allowlisted passthrough to a closed literal union
        dtype: (this.config.dtype ?? 'fp32') as DataType,
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: un-allowlisted passthrough to a closed literal union
        device: device as DeviceType,
      })
      console.error(`Embedder: Model loaded successfully (device=${device})`)
    } catch (error) {
      const nativeError = toError(error)

      // Only enrich when RAG_DTYPE was explicitly set (unset is `undefined` per
      // TD-5). Enrichment never runs on the happy path and never on the unset
      // path, so normal operation adds zero network. Always re-throw — an
      // unavailable dtype fails loud, never silently downgrades (TD-2).
      const message = await this.enrichDtypeFailureMessage(nativeError.message)
      throw new EmbeddingError(message, { cause: nativeError })
    }
  }

  /**
   * Best-effort failure-path enrichment for an explicit `RAG_DTYPE`: name the
   * dtypes the model does provide when the requested one is absent.
   *
   * The enumeration is a Hub network call in its own try/catch, so an
   * air-gapped run degrades to a generic dtype-aware message instead of
   * surfacing a confusing secondary error. Never throws, and never converts
   * the load failure into a fallback — the caller always re-throws.
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
    if (this.initPromise !== null) {
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

  /** Single-text embedding; the vector dimension depends on the model. */
  async embed(text: string): Promise<number[]> {
    // Reject empty input before paying for model init.
    if (text.length === 0) {
      throw new EmbeddingError('Cannot generate embedding for empty text')
    }

    // Lazy initialization: initialize on first use if not already initialized
    await this.ensureInitialized()

    try {
      const options = { pooling: 'mean', normalize: true }
      if (!isEmbeddingPipeline(this.model)) {
        throw new EmbeddingError('Embedder pipeline is not callable')
      }
      const output = await this.model(text, options)
      const data = output?.data
      if (!(data instanceof Float32Array)) {
        throw new EmbeddingError('Unexpected embedder output shape')
      }
      return Array.from(data)
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error
      }
      throw new EmbeddingError(`Failed to generate embedding: ${toError(error).message}`, {
        cause: toError(error),
      })
    }
  }

  /** Batched embedding; the vector dimension depends on the model. */
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
      // True batched inference: the pipeline takes an array and returns one
      // [batchLen, dim] tensor per forward pass. Calling it once per text via
      // Promise.all made `batchSize` meaningless, since onnxruntime inference
      // is not parallelized that way. Mean-pooling honors the attention mask,
      // so per-row vectors match the single-text result.
      if (!isEmbeddingPipeline(this.model)) {
        throw new EmbeddingError('Embedder pipeline is not callable')
      }
      const modelCall = this.model
      const embeddings: (number[] | undefined)[] = Array.from({ length: texts.length })
      const deferred: IndexedEmbeddingInput[] = []

      const embedInputs = async (inputs: IndexedEmbeddingInput[]): Promise<void> => {
        const output = await modelCall(
          inputs.map((input) => input.text),
          options
        )

        // Validate the output shape before slicing so a runtime/model contract
        // change surfaces as a clear error rather than silently wrong vectors.
        const dims = output?.dims
        const dim = Array.isArray(dims) ? dims[dims.length - 1] : undefined
        const data = output?.data
        if (
          !(data instanceof Float32Array) ||
          typeof dim !== 'number' ||
          dim <= 0 ||
          data.length !== inputs.length * dim
        ) {
          throw new EmbeddingError('Unexpected embedder batch output shape')
        }

        for (const [row, input] of inputs.entries()) {
          embeddings[input.originalIndex] = Array.from(data.subarray(row * dim, (row + 1) * dim))
        }
      }

      for (let i = 0; i < texts.length; i += this.config.batchSize) {
        const batchTexts = texts.slice(i, i + this.config.batchSize)
        const tokenized = modelCall.tokenizer(batchTexts, {
          padding: false,
          truncation: true,
          return_tensor: false,
        })
        const inputIds = tokenized?.input_ids
        if (!isTokenLengthArray(inputIds) || inputIds.length !== batchTexts.length) {
          throw new EmbeddingError('Unexpected embedder tokenizer output shape')
        }

        const indexedInputs = batchTexts.map((text, batchIndex) => {
          const ids = inputIds[batchIndex]
          if (ids === undefined) {
            throw new EmbeddingError('Unexpected embedder tokenizer output shape')
          }
          return { text, originalIndex: i + batchIndex, tokenLength: ids.length }
        })
        const selected = deferBatchOutliers(indexedInputs)
        deferred.push(...selected.deferred)
        await embedInputs(selected.batch)
      }

      for (const input of deferred) {
        await embedInputs([input])
      }

      const complete = embeddings.filter(
        (embedding): embedding is number[] => embedding !== undefined
      )
      if (complete.length !== embeddings.length) {
        throw new EmbeddingError('Missing embedder batch output row')
      }
      return complete
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error
      }
      throw new EmbeddingError(`Failed to generate batch embeddings: ${toError(error).message}`, {
        cause: toError(error),
      })
    }
  }
}
