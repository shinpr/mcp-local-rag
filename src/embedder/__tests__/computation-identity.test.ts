import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDevice } from '../../__tests__/test-device.js'
import { isRecord } from '../../utils/type-guards.js'
import { DocumentEmbeddingSession, embeddingSnapshotPath } from '../embedding-snapshot.js'
import type { Embedder, EmbedderConfig, EmbeddingComputationIdentity } from '../index.js'

const streamGate = (() => {
  let targetPath: string | null = null
  let blocked = false
  let announceBlocked: (() => void) | null = null
  let releaseBlocked: (() => void) | null = null
  let blockedPromise: Promise<void> | null = null
  let releasePromise: Promise<void> | null = null

  return {
    arm(path: string): void {
      targetPath = path
      blocked = false
      blockedPromise = new Promise((settle) => {
        announceBlocked = settle
      })
      releasePromise = new Promise((settle) => {
        releaseBlocked = settle
      })
    },
    intercept(path: string): Promise<void> | null {
      if (targetPath !== path || blocked || releasePromise === null) {
        return null
      }
      blocked = true
      announceBlocked?.()
      return releasePromise
    },
    waitUntilBlocked(): Promise<void> {
      if (blockedPromise === null) {
        throw new Error('The stream gate was not armed')
      }
      return blockedPromise
    },
    release(): void {
      releaseBlocked?.()
      targetPath = null
    },
  }
})()

async function mockAssetReadStream(): Promise<void> {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    const createReadStream = (
      path: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1]
    ): NodeJS.ReadableStream => {
      const source = actual.createReadStream(path, options)
      const release = streamGate.intercept(String(path))
      if (release === null) {
        return source
      }

      const delayed = new PassThrough()
      release.then(
        () => source.pipe(delayed),
        (error: unknown) =>
          delayed.destroy(error instanceof Error ? error : new Error(String(error)))
      )
      return delayed
    }
    return { ...actual, createReadStream }
  })
  vi.resetModules()
}

const MODEL_PATH = 'Xenova/all-MiniLM-L6-v2'
const SOURCE_MODEL_DIR = resolve('./tmp/models', MODEL_PATH)
const TEST_ROOT = resolve('./tmp/test-computation-identity')
const MODEL_DIR = join(TEST_ROOT, MODEL_PATH)
const TOKENIZER_PATH = join(MODEL_DIR, 'tokenizer.json')
const TOKENIZER_CONFIG_PATH = join(MODEL_DIR, 'tokenizer_config.json')
const MODEL_CONFIG_PATH = join(MODEL_DIR, 'config.json')
const SENTENCE_CONFIG_PATH = join(MODEL_DIR, 'config_sentence_transformers.json')
const MODEL_FILE_PATH = join(MODEL_DIR, 'onnx', 'model.onnx')
const TEXT = 'The cat sits on the mat.'

function createEmbedderConfig(overrides: Partial<EmbedderConfig> = {}): EmbedderConfig {
  return {
    modelPath: MODEL_PATH,
    batchSize: 8,
    cacheDir: TEST_ROOT,
    device: getTestDevice(),
    ...overrides,
  }
}

function swapCatAndDogTokenIds(path: string = TOKENIZER_PATH): void {
  const tokenizer: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(tokenizer) || !isRecord(tokenizer['model'])) {
    throw new Error('Expected a tokenizer JSON model')
  }
  const vocabulary = tokenizer['model']['vocab']
  if (!isRecord(vocabulary)) {
    throw new Error('Expected a tokenizer vocabulary')
  }
  const catId = vocabulary['cat']
  const dogId = vocabulary['dog']
  if (typeof catId !== 'number' || typeof dogId !== 'number') {
    throw new Error('Expected cat and dog tokenizer IDs')
  }
  vocabulary['cat'] = dogId
  vocabulary['dog'] = catId
  writeFileSync(path, JSON.stringify(tokenizer))
}

function maximumVectorDifference(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error('Embedding dimensions did not match')
  }
  return Math.max(...left.map((value, index) => Math.abs(value - (right[index] ?? 0))))
}

async function runSessionWithCurrentIdentity(
  embedder: Embedder,
  dbPath: string,
  filePath: string,
  expectedPrevious: EmbeddingComputationIdentity | null
): Promise<{ identity: EmbeddingComputationIdentity; vector: number[] }> {
  const identity = await embedder.getComputationIdentity()
  expect(identity).not.toBeNull()
  if (!identity) {
    throw new Error('Expected a local computation identity')
  }
  if (expectedPrevious) {
    expect(identity.fingerprint).not.toBe(expectedPrevious.fingerprint)
  }

  const expected = await embedder.embedBatch([TEXT], 'document')
  const embedBatch = vi.spyOn(embedder, 'embedBatch')
  embedBatch.mockClear()
  const session = new DocumentEmbeddingSession(dbPath, filePath, embedder)
  try {
    const current = await session.embedBatch([TEXT], 'document')
    expect(current).toEqual(expected)
    expect(embedBatch).toHaveBeenCalledOnce()
    await session.publish()
    const vector = current[0]
    if (!vector) {
      throw new Error('Expected one current embedding')
    }
    return { identity, vector }
  } finally {
    session.dispose()
    embedBatch.mockRestore()
  }
}

describe('Embedder computation identity', () => {
  beforeEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(MODEL_DIR, { recursive: true })
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      cpSync(join(SOURCE_MODEL_DIR, name), join(MODEL_DIR, name))
    }
    symlinkSync(join(SOURCE_MODEL_DIR, 'onnx'), join(MODEL_DIR, 'onnx'), 'dir')
  })

  afterEach(() => {
    streamGate.release()
    vi.doUnmock('node:fs')
    vi.resetModules()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('does not publish an old pipeline vector under identity for a changed tokenizer', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'document.md')
    await mockAssetReadStream()
    let first: Embedder | null = null
    let second: Embedder | null = null
    streamGate.arm(MODEL_FILE_PATH)

    try {
      const { Embedder: EmbedderClass } = await import('../index.js')
      first = new EmbedderClass(createEmbedderConfig())
      const firstSession = new DocumentEmbeddingSession(dbPath, filePath, first)
      const original = await firstSession.embedBatch([TEXT], 'document')
      const publish = firstSession.publish()
      await streamGate.waitUntilBlocked()
      swapCatAndDogTokenIds()
      streamGate.release()
      await publish
      expect(await first.getComputationIdentity()).toBeNull()

      second = new EmbedderClass(createEmbedderConfig())
      const currentIdentity = await second.getComputationIdentity()
      expect(currentIdentity).not.toBeNull()
      const direct = await second.embedBatch([TEXT], 'document')
      const embedBatch = vi.spyOn(second, 'embedBatch')
      embedBatch.mockClear()
      const currentSession = new DocumentEmbeddingSession(dbPath, filePath, second)
      try {
        const reused = await currentSession.embedBatch([TEXT], 'document')
        expect(reused).toEqual(direct)
        expect(embedBatch).toHaveBeenCalledOnce()
        expect(maximumVectorDifference(original[0] ?? [], reused[0] ?? [])).toBeGreaterThan(0.01)
      } finally {
        currentSession.dispose()
        embedBatch.mockRestore()
      }
      firstSession.dispose()
    } finally {
      streamGate.release()
      await first?.dispose()
      await second?.dispose()
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  }, 180_000)

  it('invalidates sessions from loaded assets, config, prompts, and prefix settings', async () => {
    const { Embedder: EmbedderClass } = await import('../index.js')
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'document.md')
    let previous: EmbeddingComputationIdentity | null = null
    let previousVector: number[] | null = null

    const baselineEmbedder = new EmbedderClass(createEmbedderConfig())
    try {
      const baseline = await runSessionWithCurrentIdentity(baselineEmbedder, dbPath, filePath, null)
      previous = baseline.identity
      previousVector = baseline.vector
    } finally {
      await baselineEmbedder.dispose()
    }

    const tokenizerConfig: unknown = JSON.parse(readFileSync(TOKENIZER_CONFIG_PATH, 'utf8'))
    if (!isRecord(tokenizerConfig)) {
      throw new Error('Expected tokenizer config object')
    }
    tokenizerConfig['identity_test_marker'] = 'updated'
    writeFileSync(TOKENIZER_CONFIG_PATH, JSON.stringify(tokenizerConfig))
    const changedAssetEmbedder = new EmbedderClass(createEmbedderConfig())
    try {
      const changedAsset = await runSessionWithCurrentIdentity(
        changedAssetEmbedder,
        dbPath,
        filePath,
        previous
      )
      previous = changedAsset.identity
      previousVector = changedAsset.vector
    } finally {
      await changedAssetEmbedder.dispose()
    }

    swapCatAndDogTokenIds()
    const changedTokenizerEmbedder = new EmbedderClass(createEmbedderConfig())
    try {
      const changedTokenizer = await runSessionWithCurrentIdentity(
        changedTokenizerEmbedder,
        dbPath,
        filePath,
        previous
      )
      expect(
        maximumVectorDifference(previousVector ?? [], changedTokenizer.vector)
      ).toBeGreaterThan(0.01)
      previous = changedTokenizer.identity
      previousVector = changedTokenizer.vector
    } finally {
      await changedTokenizerEmbedder.dispose()
    }

    const modelConfig: unknown = JSON.parse(readFileSync(MODEL_CONFIG_PATH, 'utf8'))
    if (!isRecord(modelConfig)) {
      throw new Error('Expected model config object')
    }
    modelConfig['transformers_version'] = 'identity-test-update'
    writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(modelConfig))
    const changedConfigEmbedder = new EmbedderClass(createEmbedderConfig())
    try {
      const changedConfig = await runSessionWithCurrentIdentity(
        changedConfigEmbedder,
        dbPath,
        filePath,
        previous
      )
      previous = changedConfig.identity
      previousVector = changedConfig.vector
    } finally {
      await changedConfigEmbedder.dispose()
    }

    writeFileSync(SENTENCE_CONFIG_PATH, JSON.stringify({ prompts: { document: 'Document: ' } }))
    const promptedEmbedder = new EmbedderClass(createEmbedderConfig())
    try {
      expect(await promptedEmbedder.getDocumentPrompt()).toBe('Document: ')
      const prompted = await runSessionWithCurrentIdentity(
        promptedEmbedder,
        dbPath,
        filePath,
        previous
      )
      expect(maximumVectorDifference(previousVector ?? [], prompted.vector)).toBeGreaterThan(0.01)
      previous = prompted.identity
      previousVector = prompted.vector
    } finally {
      await promptedEmbedder.dispose()
    }

    const titleEmbedder = new EmbedderClass(createEmbedderConfig({ titlePrefix: true }))
    try {
      expect(titleEmbedder.titlePrefix).toBe(true)
      const titled = await runSessionWithCurrentIdentity(titleEmbedder, dbPath, filePath, previous)
      previous = titled.identity
      previousVector = titled.vector
    } finally {
      await titleEmbedder.dispose()
    }

    const headingEmbedder = new EmbedderClass(
      createEmbedderConfig({ titlePrefix: true, headingPrefix: true })
    )
    try {
      expect(headingEmbedder.titlePrefix).toBe(true)
      expect(headingEmbedder.headingPrefix).toBe(true)
      const headed = await runSessionWithCurrentIdentity(
        headingEmbedder,
        dbPath,
        filePath,
        previous
      )
      expect(headed.identity.fingerprint).not.toBe(previous?.fingerprint)
      expect(maximumVectorDifference(previousVector ?? [], headed.vector)).toBe(0)
    } finally {
      await headingEmbedder.dispose()
    }
  }, 300_000)

  it('does not share snapshots when local and cache model copies disagree', async () => {
    const transformers = await import('@huggingface/transformers')
    const previousEnvironment = {
      cacheDir: transformers.env.cacheDir,
      localModelPath: transformers.env.localModelPath,
      remoteHost: transformers.env.remoteHost,
    }
    const localModelDir = join(TEST_ROOT, 'local-assets', MODEL_PATH)
    const localTokenizerPath = join(localModelDir, 'tokenizer.json')
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'ambiguous-document.md')
    const snapshotPath = embeddingSnapshotPath(dbPath, filePath)
    let first: Embedder | null = null
    let second: Embedder | null = null

    mkdirSync(localModelDir, { recursive: true })
    for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      cpSync(join(SOURCE_MODEL_DIR, name), join(localModelDir, name))
    }
    symlinkSync(join(SOURCE_MODEL_DIR, 'onnx'), join(localModelDir, 'onnx'), 'dir')
    // The pipeline resolves this model ID from the cache when both locations
    // exist. Give the local candidate a different tokenizer to expose ambiguity.
    swapCatAndDogTokenIds(localTokenizerPath)
    try {
      transformers.env.localModelPath = join(TEST_ROOT, 'local-assets')
      const { Embedder: EmbedderClass } = await import('../index.js')
      first = new EmbedderClass(createEmbedderConfig())
      expect(await first.getComputationIdentity()).toBeNull()
      const firstInference = vi.spyOn(first, 'embedBatch')
      const firstSession = new DocumentEmbeddingSession(dbPath, filePath, first)
      const original = await firstSession.embedBatch([TEXT], 'document')
      await firstSession.publish()
      expect(firstInference).toHaveBeenCalledOnce()
      expect(existsSync(snapshotPath)).toBe(false)

      // Make the cache match the local candidate. The next pipeline loads a
      // different tokenizer and must infer rather than reuse the first output.
      cpSync(localTokenizerPath, TOKENIZER_PATH)
      second = new EmbedderClass(createEmbedderConfig())
      expect(await second.getComputationIdentity()).toBeNull()
      const secondInference = vi.spyOn(second, 'embedBatch')
      const secondSession = new DocumentEmbeddingSession(dbPath, filePath, second)
      const current = await secondSession.embedBatch([TEXT], 'document')
      await secondSession.publish()
      expect(secondInference).toHaveBeenCalledOnce()
      expect(existsSync(snapshotPath)).toBe(false)
      expect(maximumVectorDifference(original[0] ?? [], current[0] ?? [])).toBeGreaterThan(0.01)
    } finally {
      try {
        await first?.dispose()
        await second?.dispose()
      } finally {
        transformers.env.cacheDir = previousEnvironment.cacheDir
        transformers.env.localModelPath = previousEnvironment.localModelPath
        transformers.env.remoteHost = previousEnvironment.remoteHost
      }
    }
  }, 180_000)
})
