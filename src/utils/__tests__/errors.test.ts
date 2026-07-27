// Unit tests for the shared error taxonomy foundation.
//
// Covers the `AppError` abstract base, the `isAppError` type guard, and the
// `getCauseChain` walker. Also asserts that all 6 concrete error classes join
// the taxonomy (recognized by `isAppError`) and expose the `layer`/`kind`
// discriminants — the behavior-preserving foundation for the refactor.

import { describe, expect, it } from 'vitest'
import { EmbeddingError } from '../../embedder/index.js'
import { FileOperationError, ValidationError } from '../../parser/index.js'
import { VlmError } from '../../pdf-visual/types.js'
import { DatabaseError } from '../../vectordb/types.js'
import { BaseDirsConfigError } from '../base-dirs.js'
import { type AppError, getCauseChain, isAppError } from '../errors.js'

// Builds one instance of each of the 6 concrete classes for taxonomy checks.
const oneOfEach = (): AppError[] => [
  new EmbeddingError('embed failed'),
  new ValidationError('invalid input'),
  new FileOperationError('io failed'),
  new DatabaseError('db failed'),
  new BaseDirsConfigError('config failed'),
  new VlmError('vlm failed', { pageNum: 1 }),
]

describe('isAppError', () => {
  it('should return true for an instance of each of the 6 concrete classes', () => {
    for (const err of oneOfEach()) {
      expect(isAppError(err)).toBe(true)
    }
  })

  it('should return false for a plain Error', () => {
    expect(isAppError(new Error('plain'))).toBe(false)
  })

  it('should return false for non-error values', () => {
    expect(isAppError(null)).toBe(false)
    expect(isAppError(undefined)).toBe(false)
    expect(isAppError('a string')).toBe(false)
    expect(isAppError({ message: 'duck' })).toBe(false)
    expect(isAppError(42)).toBe(false)
  })
})

describe('AppError discriminants', () => {
  it('should map each concrete class to its own layer and kind', () => {
    expect(oneOfEach().map((err) => [err.name, err.layer, err.kind])).toEqual([
      ['EmbeddingError', 'embedder', 'internal'],
      ['ValidationError', 'parser', 'validation'],
      ['FileOperationError', 'parser', 'io'],
      ['DatabaseError', 'vectordb', 'internal'],
      ['BaseDirsConfigError', 'config', 'config'],
      ['VlmError', 'pdf-visual', 'internal'],
    ])
  })

  it('should preserve the cause as the original error object', () => {
    const original = new Error('root')
    expect(new EmbeddingError('x', original).cause).toBe(original)
    expect(new DatabaseError('x', original).cause).toBe(original)
    expect(new VlmError('x', { cause: original, pageNum: 3 }).cause).toBe(original)
  })
})

describe('getCauseChain', () => {
  it('should return the ordered chain [outer, cause, cause.cause, ...]', () => {
    const root = new Error('root')
    const middle = new DatabaseError('middle', root)
    const outer = new EmbeddingError('outer', middle)

    const chain = getCauseChain(outer)

    expect(chain).toHaveLength(3)
    expect(chain[0]).toBe(outer)
    expect(chain[1]).toBe(middle)
    expect(chain[2]).toBe(root)
    expect(chain.map((e) => e.message)).toEqual(['outer', 'middle', 'root'])
  })

  it('should return a single-element chain when there is no cause', () => {
    const solo = new ValidationError('solo')
    const chain = getCauseChain(solo)
    expect(chain).toHaveLength(1)
    expect(chain[0]).toBe(solo)
  })
})
