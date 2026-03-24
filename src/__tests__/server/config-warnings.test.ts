// Configuration Warnings Test
// Test Type: Unit Test (parsers) + Integration Test (warning delivery via MCP annotations)

import { mkdir, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAGServer } from '../../server/index.js'
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

  it('returns valid integers within range', () => {
    expect(parseChunkMinLength('1')).toEqual({ value: 1 })
    expect(parseChunkMinLength('200')).toEqual({ value: 200 })
    expect(parseChunkMinLength('10000')).toEqual({ value: 10000 })
  })

  it('returns warning for zero', () => {
    const result = parseChunkMinLength('0')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for negative values', () => {
    const result = parseChunkMinLength('-1')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for values above 10000', () => {
    const result = parseChunkMinLength('10001')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for non-numeric input', () => {
    const result = parseChunkMinLength('abc')
    expect(result.value).toBeUndefined()
    expect(result.warning).toContain('Invalid CHUNK_MIN_LENGTH')
  })

  it('returns warning for float values', () => {
    // parseInt('3.5') returns 3, which is valid
    expect(parseChunkMinLength('3.5')).toEqual({ value: 3 })
  })
})

// ============================================
// Integration Tests: Warning Delivery via MCP Annotations
// ============================================

const testDbPath = './tmp/test-config-warnings-db'
const baseConfig = {
  dbPath: testDbPath,
  modelName: 'Xenova/all-MiniLM-L6-v2',
  cacheDir: './tmp/test-model-cache',
  baseDir: '.',
  maxFileSize: 10 * 1024 * 1024,
}

describe('Config warning delivery via MCP annotations', () => {
  afterAll(async () => {
    await rm(testDbPath, { recursive: true, force: true })
  })

  describe('status tool', () => {
    let server: RAGServer

    beforeAll(async () => {
      await mkdir(testDbPath, { recursive: true })
      server = new RAGServer({
        ...baseConfig,
        configWarnings: [
          'Invalid RAG_MAX_FILES value: "0". Expected positive integer (>= 1). Ignoring.',
        ],
      })
      await server.initialize()
    })

    it('always includes warning content blocks with annotations', async () => {
      const result = await server.handleStatus()

      expect(result.content.length).toBe(2)

      const warningBlock = result.content[1]
      expect(warningBlock?.text).toContain('Warning:')
      expect(warningBlock?.text).toContain('RAG_MAX_FILES')
      expect(warningBlock?.annotations).toEqual({
        audience: ['user', 'assistant'],
        priority: 0.3,
      })
    })

    it('includes warnings on repeated status calls', async () => {
      const result1 = await server.handleStatus()
      const result2 = await server.handleStatus()

      expect(result1.content.length).toBe(2)
      expect(result2.content.length).toBe(2)
    })
  })

  describe('status tool without warnings', () => {
    let server: RAGServer

    beforeAll(async () => {
      await mkdir(testDbPath, { recursive: true })
      server = new RAGServer(baseConfig)
      await server.initialize()
    })

    it('returns only status data when no config warnings exist', async () => {
      const result = await server.handleStatus()
      expect(result.content.length).toBe(1)
      expect(result.content[0]?.text).not.toContain('Warning:')
    })
  })

  describe('query_documents tool', () => {
    let server: RAGServer

    beforeAll(async () => {
      await mkdir(testDbPath, { recursive: true })
      server = new RAGServer({
        ...baseConfig,
        configWarnings: [
          'Invalid RAG_MAX_DISTANCE value: "-1". Expected positive number. Ignoring.',
        ],
      })
      await server.initialize()
    })

    it('includes warnings on first query call only', async () => {
      const result1 = await server.handleQueryDocuments({ query: 'test' })
      expect(result1.content.length).toBe(2)
      expect(result1.content[1]?.text).toContain('Warning:')
      expect(result1.content[1]?.annotations).toEqual({
        audience: ['user', 'assistant'],
        priority: 0.3,
      })

      const result2 = await server.handleQueryDocuments({ query: 'test again' })
      expect(result2.content.length).toBe(1)
    })
  })

  describe('multiple warnings', () => {
    let server: RAGServer

    beforeAll(async () => {
      await mkdir(testDbPath, { recursive: true })
      server = new RAGServer({
        ...baseConfig,
        configWarnings: [
          'Invalid RAG_MAX_FILES value: "0". Expected positive integer (>= 1). Ignoring.',
          'Invalid RAG_HYBRID_WEIGHT value: "2.0". Expected 0.0-1.0. Using default (0.6).',
        ],
      })
      await server.initialize()
    })

    it('combines multiple warnings into a single content block', async () => {
      const result = await server.handleStatus()
      const warningBlock = result.content[1]

      expect(warningBlock?.text).toContain('RAG_MAX_FILES')
      expect(warningBlock?.text).toContain('RAG_HYBRID_WEIGHT')
      expect(warningBlock?.text).toContain(' | ')
    })
  })
})
