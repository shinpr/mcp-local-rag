import { describe, expect, it } from 'vitest'
import {
  parseChunkMinLength,
  parseGroupingMode,
  parseHybridWeight,
  parseMaxDistance,
  parseMaxFiles,
} from '../../server-main.js'

// ============================================
// Unit Tests: Parser Functions
// ============================================

describe('parseGroupingMode', () => {
  it('returns undefined with no warning for empty input', () => {
    expect(parseGroupingMode(undefined)).toEqual({ value: undefined })
    expect(parseGroupingMode('')).toEqual({ value: undefined })
  })

  it('returns valid grouping modes', () => {
    expect(parseGroupingMode('similar')).toEqual({ value: 'similar' })
    expect(parseGroupingMode('related')).toEqual({ value: 'related' })
    expect(parseGroupingMode('SIMILAR')).toEqual({ value: 'similar' })
    expect(parseGroupingMode(' Related ')).toEqual({ value: 'related' })
  })

  it('returns warning for invalid values', () => {
    const result = parseGroupingMode('invalid')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_GROUPING')
    expect(result.warning).toContain('"invalid"')
  })
})

describe('parseMaxDistance', () => {
  it('returns undefined with no warning for empty input', () => {
    expect(parseMaxDistance(undefined)).toEqual({ value: undefined })
    expect(parseMaxDistance('')).toEqual({ value: undefined })
  })

  it('returns valid positive numbers', () => {
    expect(parseMaxDistance('0.5')).toEqual({ value: 0.5 })
    expect(parseMaxDistance('1.0')).toEqual({ value: 1.0 })
    expect(parseMaxDistance('0.001')).toEqual({ value: 0.001 })
  })

  it('returns warning for zero', () => {
    const result = parseMaxDistance('0')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_DISTANCE')
  })

  it('returns warning for negative values', () => {
    const result = parseMaxDistance('-1')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_DISTANCE')
  })

  it('returns warning for non-numeric input', () => {
    const result = parseMaxDistance('abc')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_DISTANCE')
  })

  it('returns warning for Infinity', () => {
    const result = parseMaxDistance('Infinity')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_DISTANCE')
  })
})

describe('parseMaxFiles', () => {
  it('returns undefined with no warning for empty input', () => {
    expect(parseMaxFiles(undefined)).toEqual({ value: undefined })
    expect(parseMaxFiles('')).toEqual({ value: undefined })
  })

  it('returns valid positive integers', () => {
    expect(parseMaxFiles('1')).toEqual({ value: 1 })
    expect(parseMaxFiles('10')).toEqual({ value: 10 })
  })

  it('returns warning for zero', () => {
    const result = parseMaxFiles('0')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_FILES')
    expect(result.warning).toContain('"0"')
  })

  it('returns warning for negative values', () => {
    const result = parseMaxFiles('-1')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_FILES')
  })

  it('returns warning for non-numeric input', () => {
    const result = parseMaxFiles('abc')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_MAX_FILES')
  })
})

describe('parseHybridWeight', () => {
  it('returns undefined with no warning for empty input', () => {
    expect(parseHybridWeight(undefined)).toEqual({ value: undefined })
    expect(parseHybridWeight('')).toEqual({ value: undefined })
  })

  it('returns valid values in 0.0-1.0 range', () => {
    expect(parseHybridWeight('0')).toEqual({ value: 0 })
    expect(parseHybridWeight('0.5')).toEqual({ value: 0.5 })
    expect(parseHybridWeight('1')).toEqual({ value: 1 })
    expect(parseHybridWeight('1.0')).toEqual({ value: 1.0 })
  })

  it('returns warning for values below 0', () => {
    const result = parseHybridWeight('-0.1')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_HYBRID_WEIGHT')
  })

  it('returns warning for values above 1', () => {
    const result = parseHybridWeight('1.1')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_HYBRID_WEIGHT')
  })

  it('returns warning for non-numeric input', () => {
    const result = parseHybridWeight('abc')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid RAG_HYBRID_WEIGHT')
  })
})

describe('parseChunkMinLength', () => {
  it('returns undefined with no warning for empty input', () => {
    expect(parseChunkMinLength(undefined)).toEqual({ value: undefined })
    expect(parseChunkMinLength('')).toEqual({ value: undefined })
  })

  it('returns valid integer values', () => {
    expect(parseChunkMinLength('100')).toEqual({ value: 100 })
    expect(parseChunkMinLength('50')).toEqual({ value: 50 })
  })

  it('returns valid boundary values', () => {
    expect(parseChunkMinLength('1')).toEqual({ value: 1 })
    expect(parseChunkMinLength('10000')).toEqual({ value: 10000 })
  })

  it('returns warning for value below minimum', () => {
    const result = parseChunkMinLength('0')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for negative value', () => {
    const result = parseChunkMinLength('-1')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for value above maximum', () => {
    const result = parseChunkMinLength('10001')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for non-numeric input', () => {
    const result = parseChunkMinLength('abc')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('truncates float input to integer via parseInt', () => {
    // parseInt('50.5') returns 50, which is valid — consistent with parseMaxFiles behavior
    expect(parseChunkMinLength('50.5')).toEqual({ value: 50 })
  })
})
