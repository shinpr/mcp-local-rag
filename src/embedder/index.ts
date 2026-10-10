// Embedder implementation with Transformers.js

import { createHash } from 'node:crypto'
import { type BigIntStats, createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { serialize } from 'node:v8'
import {
  AutoConfig,
  type DataType,
  type DeviceType,
  env,
  ModelRegistry,
  type PretrainedConfig,
  pipeline,
} from '@huggingface/transformers'
import { AppError, toError } from '../utils/errors.js'
import { isObjectLike } from '../utils/type-guards.js'
import {
  loadSentenceTransformersConfig,
  type ModelPrompts,
  resolveModelSettings,
} from './sentence-transformers-config.js'

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
  /**
   * Embed document chunks behind a `Title:` line naming their document
   * (default: false). Read by ingestion, which builds the embedding input.
   */
  titlePrefix?: boolean
  /** Add section paths to chunk embeddings when they fit (default: false). */
  headingPrefix?: boolean
}

/** Selects the model's prompt; omitted means its default prompt. */
export type EmbeddingRole = 'query' | 'document'

interface IndexedEmbeddingInput {
  text: string
  originalIndex: number
  tokenLength: number
}

interface TokenizerOptions {
  padding?: boolean
  truncation?: boolean
  return_tensor?: boolean
  max_length?: number
}

export interface PipelineTokenizer {
  (input: string[], options: TokenizerOptions): { input_ids?: unknown } | null | undefined
  /** `unknown` because a model may omit it or report a sentinel; see {@link usableTokenLimit}. */
  model_max_length?: unknown
}

interface PipelineModelConfig {
  max_position_embeddings?: unknown
  hidden_size?: unknown
}

export interface EmbeddingComputationIdentity {
  fingerprint: string
  dimension: number
}

interface HashedModelAsset {
  name: string
  sha256: string
}

interface ModelAssetSnapshotEntry {
  name: string
  path: string
  statSignature: string
}

interface ModelAssetSnapshot {
  config: PretrainedConfig
  files: ModelAssetSnapshotEntry[]
}

interface ComputationIdentityInput {
  loadedModel: unknown
  device: DeviceType
  dtype: DataType
  tokenLimit: number | null
  assetSnapshot: ModelAssetSnapshot | null
  sentenceTransformersConfig: unknown
}

const EMBEDDING_IMPLEMENTATION_VERSION = 1
const require = createRequire(import.meta.url)
const transformersRequire = createRequire(require.resolve('@huggingface/transformers'))
let runtimeVersionsPromise: Promise<Record<string, string> | null> | null = null

/**
 * The transformers.js pipeline as this module calls it.
 *
 * Every result field is typed as loosely as the runtime admits — `dims`
 * included, since {@link isEmbeddingPipeline} establishes only that the value
 * is callable and carries a `tokenizer`. That keeps each call site's own shape
 * check load-bearing rather than dead under an optimistic declaration.
 */
interface EmbeddingPipeline {
  (
    input: string[],
    options: unknown
  ): Promise<{ data?: unknown; dims?: unknown } | null | undefined>
  tokenizer: PipelineTokenizer
  /** Optional: a model reporting no position window takes the tokenizer-only branch. */
  model?: { config?: PipelineModelConfig }
}

/** True when the loaded pipeline exposes the call and tokenizer surface used here. */
function isEmbeddingPipeline(value: unknown): value is EmbeddingPipeline {
  return (
    typeof value === 'function' && 'tokenizer' in value && typeof value.tokenizer === 'function'
  )
}

function isPretrainedConfig(value: unknown): value is PretrainedConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'model_type' in value &&
    (typeof value.model_type === 'string' || value.model_type === null) &&
    'is_encoder_decoder' in value &&
    typeof value.is_encoder_decoder === 'boolean' &&
    'transformers.js_config' in value &&
    (value['transformers.js_config'] === undefined ||
      (typeof value['transformers.js_config'] === 'object' &&
        value['transformers.js_config'] !== null)) &&
    'normalized_config' in value
  )
}

function embeddingDimension(loadedModel: EmbeddingPipeline): number | null {
  const dimension = loadedModel.model?.config?.hidden_size
  return typeof dimension === 'number' && Number.isInteger(dimension) && dimension > 0
    ? dimension
    : null
}

async function statOrNull(filePath: string): Promise<BigIntStats | null> {
  try {
    return await stat(filePath, { bigint: true })
  } catch {
    return null
  }
}

function statSignature(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

// ============================================
// Token Limit Clamp
// ============================================

/** Above this a reported length is a sentinel, such as `bge-large-zh-v1.5`'s `1e30`. */
const MAX_PLAUSIBLE_TOKENS = 1e6

/**
 * Withheld on the window-only branch, where no tokenizer limit is trustworthy:
 * the RoBERTa family's padding-index offset makes the usable window
 * `max_position_embeddings - 2`.
 */
const RESERVED_POSITIONS = 2

export interface TokenLimitClamp {
  /** The effective token cap, or `null` for degraded mode (no cap, no clamp). */
  tokenLimit: number | null
  /** The pre-clamp tokenizer, for measuring true lengths. */
  measurementTokenizer: PipelineTokenizer | null
}

/** A reported length usable as a limit, or `null` when it is absent or a sentinel. */
function usableTokenLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return value >= 1 && value <= MAX_PLAUSIBLE_TOKENS ? Math.floor(value) : null
}

function readPositionWindow(candidate: EmbeddingPipeline): number | null {
  return usableTokenLimit(candidate.model?.config?.max_position_embeddings)
}

function resolveEffectiveCap(
  positionWindow: number | null,
  tokenizerLimit: number | null
): number | null {
  if (positionWindow === null) {
    return tokenizerLimit
  }
  if (tokenizerLimit !== null) {
    return Math.min(positionWindow, tokenizerLimit)
  }
  // A window narrower than the reserve cannot yield a positive cap.
  return Math.max(1, positionWindow - RESERVED_POSITIONS)
}

/**
 * Bound the pipeline's tokenization length to the model's position window, by
 * installing a proxy on `candidate`'s tokenizer.
 *
 * The pipeline tokenizes with no `max_length`, which resolves to
 * `model_max_length ?? Infinity` and then to the batch's longest sequence, so a
 * model whose `tokenizer_config.json` omits a real limit sends more positions
 * than it has position embeddings and onnxruntime fails in the
 * position-embedding `Add` node (#202).
 *
 * The measurement tokenizer is captured before the proxy, so measurement
 * reports true lengths. A `Proxy` is used because `model_max_length` is a getter
 * with no setter. An unrecognized shape, or no usable limit, leaves `candidate`
 * untouched.
 */
export function installTokenLimitClamp(candidate: unknown): TokenLimitClamp {
  if (!isEmbeddingPipeline(candidate)) {
    return { tokenLimit: null, measurementTokenizer: null }
  }

  const measurementTokenizer = candidate.tokenizer
  const tokenizerLimit = usableTokenLimit(measurementTokenizer.model_max_length)
  const tokenLimit = resolveEffectiveCap(readPositionWindow(candidate), tokenizerLimit)
  if (tokenLimit === null) {
    return { tokenLimit: null, measurementTokenizer }
  }

  candidate.tokenizer = new Proxy(measurementTokenizer, {
    apply(target, thisArg, args: unknown[]) {
      const [input, options] = args
      const clamped = {
        ...(isObjectLike(options) ? options : {}),
        max_length: tokenLimit,
        truncation: true,
      }
      return Reflect.apply(target, thisArg, [input, clamped])
    },
  })

  return { tokenLimit, measurementTokenizer }
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
  /** The resolved cap, or `null` before initialization and in degraded mode. */
  private tokenLimit: number | null = null
  /** The pre-clamp tokenizer, so measurement never reports clamped lengths. */
  private measurementTokenizer: PipelineTokenizer | null = null
  /**
   * One-shot flags, per instance: each state belongs to this embedder's model.
   * They survive `dispose()`; re-initialization is not new information.
   */
  private truncationWarned: boolean = false
  private degradedModeWarned: boolean = false
  private prompts: ModelPrompts = { query: '', document: '', default: '' }
  private warnings: string[] = []
  private readonly config: EmbedderConfig
  private computationIdentityPromise: Promise<EmbeddingComputationIdentity | null> | null = null

  constructor(config: EmbedderConfig) {
    this.config = config
  }

  get headingPrefix(): boolean {
    return this.config.headingPrefix ?? false
  }

  get titlePrefix(): boolean {
    return this.config.titlePrefix ?? false
  }

  /** Model settings this tool cannot honor; empty until the model loads. */
  get modelWarnings(): readonly string[] {
    return this.warnings
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
    this.tokenLimit = null
    this.measurementTokenizer = null
    this.computationIdentityPromise = null
  }

  /**
   * Initialize Transformers.js model
   */
  async initialize(): Promise<void> {
    // Skip if already initialized
    if (this.model) {
      return
    }
    this.computationIdentityPromise = null

    // Set cache directory BEFORE creating pipeline
    env.cacheDir = this.config.cacheDir
    if (process.env['HF_ENDPOINT']) {
      env.remoteHost = process.env['HF_ENDPOINT']
    }

    // No fallback — if the requested device fails, init throws.
    // The sole fp32 default literal. Both values pass through un-allowlisted
    // (see `resolveDevice`) into a closed literal union.
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: un-allowlisted passthrough to a closed literal union
    const device = (this.config.device || 'cpu') as DeviceType
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: un-allowlisted passthrough to a closed literal union
    const dtype = (this.config.dtype ?? 'fp32') as DataType

    console.error(`Embedder: Setting cache directory to "${this.config.cacheDir}"`)

    // Resolved before the pipeline: once `this.model` is set, `ensureInitialized`
    // lets callers through, so no await may follow that assignment.
    const sentenceTransformersConfig = await loadSentenceTransformersConfig(
      this.config.modelPath,
      this.config.cacheDir,
      { dtype, device }
    )
    const settings = resolveModelSettings(this.config.modelPath, sentenceTransformersConfig)
    for (const warning of settings.warnings) {
      console.error(`Embedder: ${warning}`)
    }
    this.prompts = settings.prompts
    this.warnings = settings.warnings

    console.error(`Embedder: Loading model "${this.config.modelPath}" on device "${device}"...`)

    try {
      // Capture local asset names and file signatures before the pipeline can
      // load them. Later content hashes are trusted only while these exact
      // files remain unchanged, so a disk update during model loading cannot
      // assign the new asset identity to an older in-memory pipeline.
      const assetSnapshot = await this.captureModelAssetSnapshot(dtype, device)
      this.model = await pipeline('feature-extraction', this.config.modelPath, { dtype, device })
      const loadedModel = this.model
      const clamp = installTokenLimitClamp(loadedModel)
      this.tokenLimit = clamp.tokenLimit
      this.measurementTokenizer = clamp.measurementTokenizer
      // Start asset hashing against the initialized pipeline while parsing and
      // token measurement proceed. The promise is retained with this model and
      // is cleared only when the pipeline is disposed.
      this.computationIdentityPromise = this.createComputationIdentity({
        loadedModel,
        device,
        dtype,
        tokenLimit: clamp.tokenLimit,
        assetSnapshot,
        sentenceTransformersConfig,
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

  /** Identity of the loaded embedding function, or `null` when local assets cannot be proven. */
  async getComputationIdentity(): Promise<EmbeddingComputationIdentity | null> {
    await this.ensureInitialized()
    if (this.computationIdentityPromise === null) {
      return null
    }
    return await this.computationIdentityPromise
  }

  private async createComputationIdentity({
    loadedModel,
    device,
    dtype,
    tokenLimit,
    assetSnapshot,
    sentenceTransformersConfig,
  }: ComputationIdentityInput): Promise<EmbeddingComputationIdentity | null> {
    try {
      if (!isEmbeddingPipeline(loadedModel)) {
        return null
      }
      const dimensionValue = embeddingDimension(loadedModel)
      if (dimensionValue === null) {
        return null
      }

      const loadedConfig = loadedModel.model?.config
      if (
        !assetSnapshot ||
        !isPretrainedConfig(loadedConfig) ||
        JSON.stringify(assetSnapshot.config) !== JSON.stringify(loadedConfig)
      ) {
        return null
      }

      const assets = await this.hashModelAssets(assetSnapshot)
      if (!assets) {
        return null
      }
      assets.push({
        name: 'config_sentence_transformers.json',
        sha256: createHash('sha256').update(serialize(sentenceTransformersConfig)).digest('hex'),
      })

      const runtimeVersions = await getRuntimeVersions()
      if (runtimeVersions === null) {
        return null
      }
      const fingerprintInput = {
        implementationVersion: EMBEDDING_IMPLEMENTATION_VERSION,
        assets,
        runtimeVersions,
        nodeVersion: process.versions.node,
        transformersVersion: env.version,
        modelPath: this.config.modelPath,
        device,
        dtype,
        prompts: this.prompts,
        tokenLimit,
        pooling: 'mean',
        normalize: true,
        titlePrefix: this.titlePrefix,
        headingPrefix: this.headingPrefix,
        dimension: dimensionValue,
      }
      const fingerprint = createHash('sha256').update(serialize(fingerprintInput)).digest('hex')
      return { fingerprint, dimension: dimensionValue }
    } catch {
      // Identity is optional acceleration metadata. A failure to enumerate or
      // hash local assets must never prevent normal embedding inference.
      return null
    }
  }

  private async hashModelAssets(snapshot: ModelAssetSnapshot): Promise<HashedModelAsset[] | null> {
    const assets: HashedModelAsset[] = []
    for (const file of snapshot.files) {
      const beforeHash = await statOrNull(file.path)
      if (!beforeHash?.isFile() || statSignature(beforeHash) !== file.statSignature) {
        return null
      }
      const sha256 = await hashFile(file.path)
      const afterHash = await statOrNull(file.path)
      if (!afterHash?.isFile() || statSignature(afterHash) !== file.statSignature) {
        return null
      }
      assets.push({ name: file.name, sha256 })
    }
    return assets
  }

  private async captureModelAssetSnapshot(
    dtype: DataType,
    device: DeviceType
  ): Promise<ModelAssetSnapshot | null> {
    try {
      const tokenizerConfigPath = this.resolveAssetPath('tokenizer_config.json')
      if (
        !tokenizerConfigPath ||
        !existsSync(tokenizerConfigPath) ||
        env.cacheDir === null ||
        resolve(env.cacheDir) !== resolve(this.config.cacheDir)
      ) {
        // Transformers.js 4.3.1 probes tokenizer_config.json while listing
        // pipeline assets. Require it locally before enumeration so identity
        // discovery cannot cause a separate Hub metadata lookup.
        return null
      }

      const config = await AutoConfig.from_pretrained(this.config.modelPath, {
        cache_dir: this.config.cacheDir,
        local_files_only: true,
      })
      if (!isPretrainedConfig(config)) {
        return null
      }
      const fileNames = await ModelRegistry.get_pipeline_files(
        'feature-extraction',
        this.config.modelPath,
        { config, dtype, device }
      )
      const files: ModelAssetSnapshotEntry[] = []
      for (const name of [...new Set(fileNames)].sort()) {
        const path = this.resolveAssetPath(name)
        const info = path ? await statOrNull(path) : null
        if (!path || !info?.isFile()) {
          return null
        }
        files.push({ name, path, statSignature: statSignature(info) })
      }
      return files.length === 0 ? null : { config, files }
    } catch {
      // Local identity is optional; a missing cached asset or config mismatch
      // disables reuse without changing normal pipeline initialization.
      return null
    }
  }

  private resolveAssetPath(name: string): string | null {
    const normalizedName = name.replaceAll('\\', '/')
    if (
      isAbsolute(name) ||
      normalizedName.startsWith('/') ||
      normalizedName.split('/').some((part) => part === '..')
    ) {
      return null
    }
    const modelPath = this.config.modelPath
    const cachePath = join(this.config.cacheDir, modelPath, name)
    const directModelPath = resolve(modelPath, name)
    const localModelPath = join(env.localModelPath, modelPath, name)
    const modelId = /^[^./:\\]+\/[^./\\]+$/.test(modelPath)
    let candidates: string[]
    if (isAbsolute(modelPath)) {
      candidates = [directModelPath]
    } else if (modelId) {
      candidates = [localModelPath, cachePath]
    } else {
      candidates = [directModelPath, cachePath]
    }
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  /**
   * The effective token cap, or `null` when none could be resolved.
   *
   * Self-initializing: the value exists only after the model loads, and a
   * caller may need it before the first embedding.
   */
  async getTokenLimit(): Promise<number | null> {
    await this.ensureInitialized()
    if (this.tokenLimit === null) {
      this.warnDegradedMode()
    }
    return this.tokenLimit
  }

  /**
   * Report once that no cap was resolved. Warning here rather than in
   * `initialize()` covers every consumer, which all read the cap through
   * {@link getTokenLimit}.
   */
  private warnDegradedMode(): void {
    if (this.degradedModeWarned) {
      return
    }
    this.degradedModeWarned = true
    console.error(
      `Embedder: no position-window token limit could be resolved for model "${this.config.modelPath}". Inputs are not length-guarded and oversized input may fail at inference.`
    )
  }

  /**
   * The lengths batch planning runs on: `min(trueLength, cap)`, the length the
   * clamped pipeline actually feeds the model. Warns once when a true length
   * exceeds the cap.
   */
  private async planTokenLengths(texts: string[]): Promise<number[]> {
    const tokenLimit = await this.getTokenLimit()
    const trueLengths = await this.measureTokens(texts)
    if (tokenLimit === null) {
      return trueLengths
    }

    let longestObserved = 0
    for (const length of trueLengths) {
      longestObserved = Math.max(longestObserved, length)
    }
    if (longestObserved > tokenLimit && !this.truncationWarned) {
      this.truncationWarned = true
      console.error(
        `Embedder: input exceeds the model token limit of ${tokenLimit} tokens (longest input measured ${longestObserved} tokens). Text past the limit is truncated before embedding.`
      )
    }
    return trueLengths.map((length) => Math.min(length, tokenLimit))
  }

  /**
   * The true token length of each text as embedded for `role`, prompt
   * included, in input order. Tokenization only, no inference.
   *
   * Measured with `truncation: false` through the pre-clamp tokenizer, so a
   * length above {@link getTokenLimit} means inference will truncate. Throws
   * when no such tokenizer was captured, rather than returning a length
   * measured through an unknown surface.
   */
  async countTokens(texts: string[], role?: EmbeddingRole): Promise<number[]> {
    await this.ensureInitialized()
    return this.measureTokens(this.withPrompt(texts, role))
  }

  /** The prompt this model's config sets for documents, or `''`. */
  async getDocumentPrompt(): Promise<string> {
    await this.ensureInitialized()
    return this.prompts.document
  }

  private withPrompt(texts: string[], role: EmbeddingRole | undefined): string[] {
    const prompt = this.prompts[role ?? 'default']
    return prompt === '' ? texts : texts.map((text) => prompt + text)
  }

  /** Measures `texts` as given; each caller applies the prompt exactly once. */
  private async measureTokens(texts: string[]): Promise<number[]> {
    if (texts.length === 0) {
      return []
    }

    await this.ensureInitialized()

    const tokenizer = this.measurementTokenizer
    if (tokenizer === null) {
      throw new EmbeddingError('Embedder tokenizer is unavailable for measurement')
    }

    const tokenized = tokenizer(texts, { padding: false, truncation: false, return_tensor: false })
    const inputIds = tokenized?.input_ids
    if (!isTokenLengthArray(inputIds) || inputIds.length !== texts.length) {
      throw new EmbeddingError('Unexpected embedder tokenizer output shape')
    }
    return inputIds.map((ids) => ids.length)
  }

  /**
   * Single-text embedding; the vector dimension depends on the model.
   *
   * Delegates to {@link embedBatch} so this path shares its clamp, measurement
   * and warning rather than reaching the pipeline unguarded.
   */
  async embed(text: string, role?: EmbeddingRole): Promise<number[]> {
    const embeddings = await this.embedBatch([text], role)
    const embedding = embeddings[0]
    if (embedding === undefined) {
      throw new EmbeddingError('Missing embedder batch output row')
    }
    return embedding
  }

  /** Batched embedding; the vector dimension depends on the model. */
  async embedBatch(texts: string[], role?: EmbeddingRole): Promise<number[][]> {
    // Nothing to embed → skip model init entirely.
    if (texts.length === 0) {
      return []
    }

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
      const promptedTexts = this.withPrompt(texts, role)
      // One measurement per call, so planning and truncation reporting cannot
      // disagree about a length.
      const plannedLengths = await this.planTokenLengths(promptedTexts)
      const embeddings: (number[] | undefined)[] = Array.from({ length: promptedTexts.length })
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

      for (let i = 0; i < promptedTexts.length; i += this.config.batchSize) {
        const batchTexts = promptedTexts.slice(i, i + this.config.batchSize)
        const indexedInputs = batchTexts.map((text, batchIndex) => {
          const originalIndex = i + batchIndex
          const tokenLength = plannedLengths[originalIndex]
          if (tokenLength === undefined) {
            throw new EmbeddingError('Unexpected embedder tokenizer output shape')
          }
          return { text, originalIndex, tokenLength }
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

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function getRuntimeVersions(): Promise<Record<string, string> | null> {
  if (runtimeVersionsPromise === null) {
    runtimeVersionsPromise = Promise.all(
      [
        '@huggingface/transformers',
        '@huggingface/tokenizers',
        'onnxruntime-node',
        'onnxruntime-web',
      ].map(
        async (packageName) =>
          [packageName, await readInstalledPackageVersion(packageName)] as const
      )
    ).then((entries) => {
      const versions: Record<string, string> = {}
      for (const [name, version] of entries) {
        if (version === null) {
          return null
        }
        versions[name] = version
      }
      return versions
    })
  }
  return await runtimeVersionsPromise
}

async function readInstalledPackageVersion(packageName: string): Promise<string | null> {
  try {
    let packageEntry: string
    try {
      packageEntry = require.resolve(packageName)
    } catch {
      // pnpm keeps some dependencies private to the Transformers.js package.
      packageEntry = transformersRequire.resolve(packageName)
    }
    for (
      let directory = dirname(packageEntry);
      directory !== dirname(directory);
      directory = dirname(directory)
    ) {
      try {
        const metadata: unknown = JSON.parse(
          await readFile(join(directory, 'package.json'), 'utf8')
        )
        if (
          typeof metadata === 'object' &&
          metadata !== null &&
          'name' in metadata &&
          metadata.name === packageName &&
          'version' in metadata &&
          typeof metadata.version === 'string'
        ) {
          return metadata.version
        }
      } catch {
        // Continue toward the package root.
      }
    }
    return null
  } catch {
    return null
  }
}
