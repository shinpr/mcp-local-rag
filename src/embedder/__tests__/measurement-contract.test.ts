// Self-initializing measurement contract (AC-003, AC-004).
//
// The cached default model, not a fake pipeline: a fake injected past
// `initialize()` can show neither that measurement bypasses the installed clamp
// proxy nor that both members drive initialization themselves.

import { beforeEach, describe, expect, it } from 'vitest'
import { getTestDevice, testModelCacheDir } from '../../__tests__/test-device.js'
import { expectDefined, privateMembers } from '../../__tests__/test-doubles.js'
import type { EmbedderConfig } from '../index.js'
import { Embedder, EmbeddingError } from '../index.js'

// The default tokenizer splits CJK ideographs per character (measured: 702
// tokens), so this sits well above the model's 512-token cap: inference
// truncates it, measurement must not. Hiragana is outside that vocabulary and
// collapses to a single [UNK], which is why the fixture uses an ideograph.
const OVERSIZED_CJK_TEXT = '漢'.repeat(700)

describe('Embedder measurement contract', () => {
  let testConfig: EmbedderConfig

  beforeEach(() => {
    testConfig = {
      modelPath: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
      cacheDir: testModelCacheDir(),
      device: getTestDevice(),
    }
  })

  it('resolves the repo default cap as the first call on a fresh embedder', async () => {
    const embedder = new Embedder(testConfig)

    expect(await embedder.getTokenLimit()).toBe(512)
  }, 180000)

  it('measures as the first call on a fresh embedder, with no prior embed call', async () => {
    const embedder = new Embedder(testConfig)

    // WordPiece plus the [CLS]/[SEP] pair the tokenizer always adds.
    expect(await embedder.countTokens(['hello', 'hello world'])).toEqual([3, 4])
  }, 180000)

  it('returns true unclamped lengths for input longer than the cap', async () => {
    const embedder = new Embedder(testConfig)

    const tokenLimit = expectDefined(await embedder.getTokenLimit())
    const [measured] = await embedder.countTokens([OVERSIZED_CJK_TEXT])

    expect(expectDefined(measured)).toBeGreaterThan(tokenLimit)
    // The same input still embeds, because inference goes through the clamp.
    const [embedding] = await embedder.embedBatch([OVERSIZED_CJK_TEXT])
    expect(expectDefined(embedding)).toHaveLength(384)
  }, 180000)

  it('rejects measurement when the pipeline shape yielded no tokenizer', async () => {
    const embedder = new Embedder(testConfig)
    // An initialized instance whose shape the clamp did not recognize: no
    // measurement tokenizer was captured, so a measured length cannot be trusted.
    privateMembers<{ model: unknown }>(embedder).model = { tokenizer: 'not-callable' }

    await expect(embedder.countTokens(['text'])).rejects.toThrow(EmbeddingError)
  })

  it('identifies the initialized default model from local assets and retains that identity', async () => {
    const embedder = new Embedder(testConfig)
    try {
      const identity = await embedder.getComputationIdentity()

      expect(identity).not.toBeNull()
      expect(identity?.dimension).toBe(384)
      expect(identity?.fingerprint).toMatch(/^[a-f\d]{64}$/)
      expect(await embedder.getComputationIdentity()).toEqual(identity)
    } finally {
      await embedder.dispose()
    }
  }, 180_000)
})
