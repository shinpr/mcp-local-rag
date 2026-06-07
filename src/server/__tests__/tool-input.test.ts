import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { parseIngestDataInput, parseQueryDocumentsInput } from '../tool-input.js'

describe('parseQueryDocumentsInput', () => {
  it('accepts a valid query without limit', () => {
    expect(parseQueryDocumentsInput({ query: 'hello' })).toEqual({ query: 'hello' })
  })

  it('accepts a valid query with an integer limit', () => {
    expect(parseQueryDocumentsInput({ query: 'hello', limit: 5 })).toEqual({
      query: 'hello',
      limit: 5,
    })
  })

  it.each([
    ['non-object', 42],
    ['null', null],
    ['array', ['hello']],
  ])('rejects %s arguments', (_label, raw) => {
    expect(() => parseQueryDocumentsInput(raw)).toThrow(McpError)
  })

  it.each([
    ['missing query', {}],
    ['non-string query', { query: 123 }],
    ['empty query', { query: '' }],
    ['whitespace query', { query: '   ' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseQueryDocumentsInput(raw)).toThrow(/query must be a non-empty string/)
  })

  it.each([
    ['negative limit', { query: 'q', limit: -5 }],
    ['zero limit', { query: 'q', limit: 0 }],
    ['non-integer limit', { query: 'q', limit: 2.7 }],
    ['string limit', { query: 'q', limit: '5' }],
    ['just-above-max limit', { query: 'q', limit: 21 }],
    ['large limit', { query: 'q', limit: 999 }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseQueryDocumentsInput(raw)).toThrow(/limit must be an integer between 1 and 20/)
  })

  it('accepts the max limit (20)', () => {
    expect(parseQueryDocumentsInput({ query: 'q', limit: 20 })).toEqual({ query: 'q', limit: 20 })
  })

  it('throws InvalidParams error code', () => {
    try {
      parseQueryDocumentsInput({})
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(McpError)
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams)
    }
  })
})

describe('parseIngestDataInput', () => {
  it('accepts valid input for each format', () => {
    for (const format of ['text', 'html', 'markdown'] as const) {
      expect(
        parseIngestDataInput({ content: 'body', metadata: { source: 'clipboard://x', format } })
      ).toEqual({ content: 'body', metadata: { source: 'clipboard://x', format } })
    }
  })

  it.each([
    ['missing content', { metadata: { source: 's', format: 'text' } }],
    ['non-string content', { content: 1, metadata: { source: 's', format: 'text' } }],
    ['empty content', { content: '', metadata: { source: 's', format: 'text' } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseIngestDataInput(raw)).toThrow(/content must be a non-empty string/)
  })

  it('rejects missing metadata', () => {
    expect(() => parseIngestDataInput({ content: 'body' })).toThrow(McpError)
  })

  it.each([
    ['missing source', { content: 'b', metadata: { format: 'text' } }],
    ['empty source', { content: 'b', metadata: { source: '', format: 'text' } }],
    ['non-string source', { content: 'b', metadata: { source: 5, format: 'text' } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseIngestDataInput(raw)).toThrow(/metadata\.source must be a non-empty string/)
  })

  it.each([
    ['missing format', { content: 'b', metadata: { source: 's' } }],
    ['enum-violation format', { content: 'b', metadata: { source: 's', format: 'pdf' } }],
    ['non-string format', { content: 'b', metadata: { source: 's', format: 1 } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseIngestDataInput(raw)).toThrow(/metadata\.format must be one of/)
  })
})
