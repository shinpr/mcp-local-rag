// transformers.js does not read config_sentence_transformers.json and does not
// export its hub file helpers, so the embedder loads the file itself.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type DataType,
  type DeviceType,
  env,
  ModelRegistry,
  type PretrainedConfig,
} from '@huggingface/transformers'
import { toError } from '../utils/errors.js'
import { errorCode, isObjectLike } from '../utils/type-guards.js'

const CONFIG_FILE_NAME = 'config_sentence_transformers.json'

/** sentence-transformers' `encode_document` takes the first of these that exists. */
const DOCUMENT_PROMPT_NAMES = ['document', 'passage', 'corpus'] as const

export interface ModelPrompts {
  query: string
  document: string
  default: string
}

export interface ModelSettings {
  prompts: ModelPrompts
  warnings: string[]
}

/**
 * The model's config_sentence_transformers.json, or `null` when it has none.
 *
 * The file is fetched only while the model itself is not cached yet, so later
 * runs never touch the network for it; a model cached before this file was
 * read stays without one. A fetch or parse failure also yields `null`, logged.
 */
export async function loadSentenceTransformersConfig(
  modelPath: string,
  cacheDir: string,
  pipelineOptions: { config: PretrainedConfig; dtype: DataType; device: DeviceType }
): Promise<unknown> {
  const cachePath = join(cacheDir, modelPath, CONFIG_FILE_NAME)
  if (await ModelRegistry.is_pipeline_cached('feature-extraction', modelPath, pipelineOptions)) {
    return readCachedConfig(cachePath)
  }
  return fetchConfig(modelPath, cachePath)
}

async function readCachedConfig(cachePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'))
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      warnUnreadable(cachePath, error)
    }
    return null
  }
}

async function fetchConfig(modelPath: string, cachePath: string): Promise<unknown> {
  const path = env.remotePathTemplate
    .replaceAll('{model}', modelPath)
    .replaceAll('{revision}', 'main')
  const url = `${env.remoteHost.replace(/\/+$/, '')}/${path}${CONFIG_FILE_NAME}`
  try {
    const response = await fetch(url)
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      warnUnreadable(url, `HTTP ${response.status}`)
      return null
    }
    const text = await response.text()
    const config: unknown = JSON.parse(text)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, text)
    return config
  } catch (error) {
    warnUnreadable(url, error)
    return null
  }
}

function warnUnreadable(source: string, error: unknown): void {
  console.error(`Embedder: ignoring ${CONFIG_FILE_NAME} from ${source}: ${toError(error).message}`)
}

/** Prompts per embedding role, and warnings for settings this tool cannot honor. */
export function resolveModelSettings(modelPath: string, config: unknown): ModelSettings {
  const settings: ModelSettings = {
    prompts: { query: '', document: '', default: '' },
    warnings: [],
  }
  if (!isObjectLike(config)) {
    return settings
  }

  const prompts = isObjectLike(config['prompts']) ? config['prompts'] : {}
  const promptNamed = (name: unknown): string | undefined => {
    const prompt = typeof name === 'string' ? prompts[name] : undefined
    return typeof prompt === 'string' ? prompt : undefined
  }
  settings.prompts.query = promptNamed('query') ?? ''
  settings.prompts.document =
    DOCUMENT_PROMPT_NAMES.map(promptNamed).find((prompt) => prompt !== undefined) ?? ''
  settings.prompts.default = promptNamed(config['default_prompt_name']) ?? ''

  // Vectors are L2-normalized and compared by dot product, which ranks the same
  // as cosine and euclidean; LanceDB offers no manhattan distance.
  if (config['similarity_fn_name'] === 'manhattan') {
    settings.warnings.push(
      `Model "${modelPath}" declares similarity_fn_name "manhattan" in ${CONFIG_FILE_NAME}. This tool compares normalized vectors by dot product and does not support it, so search results may be inaccurate.`
    )
  }
  const modelType = config['model_type']
  if (typeof modelType === 'string' && modelType !== 'SentenceTransformer') {
    settings.warnings.push(
      `Model "${modelPath}" declares model_type "${modelType}" in ${CONFIG_FILE_NAME}. This tool supports only SentenceTransformer embedding models, so search results may be meaningless.`
    )
  }
  return settings
}
