import { describe, expect, it, vi } from 'vitest'

import type { SemanticChunker } from '../../chunker/index.js'
import type { EmbedderInterface } from '../../chunker/semantic-chunker.js'
import { buildChunksAndEmbeddings } from '../compute.js'

describe('buildChunksAndEmbeddings', () => {
  it('performs one ordered chunk pass and preserves returned source envelopes', async () => {
    const text = 'Before.\n\n[Visual content on page 1, visual 0: Caption.]\n\nAfter.'
    const captionStart = text.indexOf('[Visual content')
    const atomicRanges = [{ start: captionStart, end: text.indexOf(']\n\n') + 1 }]
    const expectedChunks = [{ text, index: 0, sourceStart: 0, sourceEnd: text.length }]
    const chunkText = vi.fn().mockResolvedValue(expectedChunks)
    const embedBatch = vi.fn().mockResolvedValue([[1, 0]])

    const result = await buildChunksAndEmbeddings(
      text,
      { chunkText } as unknown as SemanticChunker,
      { embedBatch } satisfies EmbedderInterface,
      atomicRanges
    )

    expect(chunkText).toHaveBeenCalledTimes(1)
    expect(chunkText).toHaveBeenCalledWith(text, expect.anything(), atomicRanges)
    expect(embedBatch).toHaveBeenCalledWith([text])
    expect(result).toEqual({ chunks: expectedChunks, embeddings: [[1, 0]] })
  })

  it('does not create an embedding when the ordered document produces zero chunks', async () => {
    const chunkText = vi.fn().mockResolvedValue([])
    const embedBatch = vi.fn()

    await expect(
      buildChunksAndEmbeddings(
        '',
        { chunkText } as unknown as SemanticChunker,
        { embedBatch } satisfies EmbedderInterface,
        []
      )
    ).resolves.toEqual({ chunks: [], embeddings: [] })
    expect(chunkText).toHaveBeenCalledTimes(1)
    expect(embedBatch).not.toHaveBeenCalled()
  })
})
