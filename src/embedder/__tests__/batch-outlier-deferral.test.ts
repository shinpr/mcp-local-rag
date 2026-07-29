import { describe, expect, it } from 'vitest'
import { Embedder } from '../index.js'

interface FakePipeline {
  (texts: string[]): Promise<{ data: Float32Array; dims: number[] }>
  tokenizer: (
    texts: string[],
    options: { padding: boolean; truncation: boolean; return_tensor: boolean }
  ) => { input_ids: number[][] }
}

function createEmbedderWithFakePipeline(tokenLengths: Record<string, number>): {
  embedder: Embedder
  modelCalls: string[][]
} {
  const modelCalls: string[][] = []
  const vectorValues = new Map(Object.keys(tokenLengths).map((text, index) => [text, index + 1]))
  const pipeline = Object.assign(
    async (texts: string[]) => {
      modelCalls.push([...texts])
      return {
        data: Float32Array.from(texts.map((text) => vectorValues.get(text) ?? 0)),
        dims: [texts.length, 1],
      }
    },
    {
      tokenizer: (texts: string[]) => ({
        input_ids: texts.map((text) => Array.from({ length: tokenLengths[text] ?? 1 }, () => 1)),
      }),
    }
  ) as FakePipeline

  const embedder = new Embedder({
    modelPath: 'unused-by-fake-pipeline',
    batchSize: 16,
    cacheDir: 'unused-by-fake-pipeline',
  })
  ;(embedder as unknown as { model: FakePipeline }).model = pipeline

  return { embedder, modelCalls }
}

describe('Embedder batch outlier deferral', () => {
  it('defers a token-length outlier to a singleton batch and restores input order', async () => {
    const tokenLengths = {
      'short-a': 10,
      outlier: 100,
      'short-b': 12,
    }
    const { embedder, modelCalls } = createEmbedderWithFakePipeline(tokenLengths)

    const embeddings = await embedder.embedBatch(['short-a', 'outlier', 'short-b'])

    expect(modelCalls).toEqual([['short-a', 'short-b'], ['outlier']])
    expect(embeddings).toEqual([[1], [2], [3]])
  })

  it('keeps similarly sized inputs on the existing batch path', async () => {
    const tokenLengths = {
      'short-a': 10,
      'short-b': 12,
      'short-c': 14,
    }
    const { embedder, modelCalls } = createEmbedderWithFakePipeline(tokenLengths)

    const embeddings = await embedder.embedBatch(['short-a', 'short-b', 'short-c'])

    expect(modelCalls).toEqual([['short-a', 'short-b', 'short-c']])
    expect(embeddings).toEqual([[1], [2], [3]])
  })

  it('defers when padding exceeds 1.5 times the estimated attention work', async () => {
    const tokenLengths = {
      'short-a': 10,
      moderate: 15,
      'short-b': 10,
    }
    const { embedder, modelCalls } = createEmbedderWithFakePipeline(tokenLengths)

    const embeddings = await embedder.embedBatch(['short-a', 'moderate', 'short-b'])

    expect(modelCalls).toEqual([['short-a', 'short-b'], ['moderate']])
    expect(embeddings).toEqual([[1], [2], [3]])
  })

  it('defers multiple outliers individually after the normal batch', async () => {
    const shortTexts = Array.from({ length: 14 }, (_, index) => `short-${index}`)
    const texts = [
      shortTexts[0]!,
      'longest',
      ...shortTexts.slice(1, 8),
      'longer',
      ...shortTexts.slice(8),
    ]
    const tokenLengths = Object.fromEntries([
      ...shortTexts.map((text) => [text, 10]),
      ['longest', 100],
      ['longer', 90],
    ])
    const { embedder, modelCalls } = createEmbedderWithFakePipeline(tokenLengths)

    const embeddings = await embedder.embedBatch(texts)

    expect(modelCalls).toEqual([shortTexts, ['longest'], ['longer']])
    expect(embeddings).toHaveLength(texts.length)
    expect(embeddings.every((embedding) => embedding.length === 1)).toBe(true)
  })
})
