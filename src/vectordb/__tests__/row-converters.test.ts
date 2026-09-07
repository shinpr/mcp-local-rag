// What `toVectorChunk` refuses when reading a row's embedding.
//
// The accepted path — a real LanceDB `Float32Array` round-tripping back as
// `number[]` — is covered by the store's own backup/restore test, so only the
// refusals and the one documented gap are pinned here.

import { describe, expect, it } from 'vitest'
import { DatabaseError, toVectorChunk } from '../types.js'

const ROW = {
  id: 'chunk-1',
  filePath: '/docs/a.md',
  chunkIndex: 0,
  text: 'body',
  timestamp: '2026-01-01T00:00:00.000Z',
  metadata: { fileName: 'a.md', fileSize: 4, fileType: 'md' },
}

describe('toVectorChunk embedding read', () => {
  it('refuses a non-numeric element rather than coercing it', () => {
    // A numeric `length` says nothing about the contents: this shape used to
    // reach callers as a `number[]` holding a string and a null.
    expect(() => toVectorChunk({ ...ROW, vector: { length: 2, 0: 'bad', 1: null } })).toThrow(
      DatabaseError
    )
  })

  it('refuses a value carrying no length', () => {
    expect(() => toVectorChunk({ ...ROW, vector: {} })).toThrow(DatabaseError)
  })

  it('passes NaN through, so a poisoned distance is still possible', () => {
    const chunk = toVectorChunk({ ...ROW, vector: [Number.NaN, 0.5] })
    expect(chunk.vector[0]).toBeNaN()
  })
})

/**
 * Full-row conversion feeds backup and rollback, so it must be lossless for any
 * nonempty stored value — including one this version's planner cannot interpret
 * — while the legacy/seed no-value forms read back as absence.
 */
describe('toVectorChunk visualProfile read', () => {
  const rowWithVector = { ...ROW, vector: [0.5, 0.5] }

  it.each([
    ['a missing column', {}],
    ['an explicit null', { visualProfile: null }],
    ['an undefined value', { visualProfile: undefined }],
    ['the create-path empty seed', { visualProfile: '' }],
  ])('reads %s as absence', (_case, raw) => {
    expect('visualProfile' in toVectorChunk({ ...rowWithVector, ...raw })).toBe(false)
  })

  it.each(['fast', 'quality', 'legacy-unsupported'])('preserves the raw value %s', (value) => {
    expect(toVectorChunk({ ...rowWithVector, visualProfile: value }).visualProfile).toBe(value)
  })
})
