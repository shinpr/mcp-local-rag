import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import {
  parseDeleteFileInput,
  parseIngestDataInput,
  parseIngestFileInput,
  parseListFilesInput,
  parseQueryDocumentsInput,
  parseReadChunkNeighborsInput,
  parseSyncStartInput,
  parseSyncStatusInput,
} from '../tool-input.js'

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

  it('normalizes a string scope to a single-element array', () => {
    expect(parseQueryDocumentsInput({ query: 'q', scope: '/a/b' })).toEqual({
      query: 'q',
      scope: ['/a/b'],
    })
  })

  it('passes a string array scope through', () => {
    expect(parseQueryDocumentsInput({ query: 'q', scope: ['/a/b', '/c/d'] })).toEqual({
      query: 'q',
      scope: ['/a/b', '/c/d'],
    })
  })

  it('trims surrounding whitespace from scope values (string and array)', () => {
    expect(parseQueryDocumentsInput({ query: 'q', scope: '  /a/b  ' })).toEqual({
      query: 'q',
      scope: ['/a/b'],
    })
    expect(parseQueryDocumentsInput({ query: 'q', scope: ['  /a/b', '/c/d\t'] })).toEqual({
      query: 'q',
      scope: ['/a/b', '/c/d'],
    })
  })

  it('keeps input unchanged when scope is absent (with limit)', () => {
    expect(parseQueryDocumentsInput({ query: 'q', limit: 5 })).toEqual({ query: 'q', limit: 5 })
  })

  it('keeps input unchanged when scope is absent (no limit)', () => {
    expect(parseQueryDocumentsInput({ query: 'q' })).toEqual({ query: 'q' })
  })

  it('accepts scope alongside limit', () => {
    expect(parseQueryDocumentsInput({ query: 'q', limit: 5, scope: '/a/b' })).toEqual({
      query: 'q',
      limit: 5,
      scope: ['/a/b'],
    })
  })

  it.each([
    ['empty array scope', { query: 'q', scope: [] }],
    ['empty string scope', { query: 'q', scope: '' }],
    ['whitespace string scope', { query: 'q', scope: '   ' }],
    ['array with empty-string element', { query: 'q', scope: ['/a/b', ''] }],
    ['array with whitespace element', { query: 'q', scope: ['/a/b', '   '] }],
    ['array with non-string element', { query: 'q', scope: ['/a/b', 5] }],
    ['number scope', { query: 'q', scope: 42 }],
    ['object scope', { query: 'q', scope: { path: '/a/b' } }],
    ['null scope', { query: 'q', scope: null }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseQueryDocumentsInput(raw)).toThrow(
      /scope must be a non-empty string or a non-empty array of non-empty strings/
    )
  })
})

describe('parseListFilesInput', () => {
  it('returns {} when arguments are omitted (undefined)', () => {
    expect(parseListFilesInput(undefined)).toEqual({})
  })

  it('returns {} for an empty object (no scope)', () => {
    expect(parseListFilesInput({})).toEqual({})
  })

  it('normalizes a string scope to a single-element array', () => {
    expect(parseListFilesInput({ scope: '/a/b' })).toEqual({ scope: ['/a/b'] })
  })

  it('passes a string array scope through', () => {
    expect(parseListFilesInput({ scope: ['/a', '/b'] })).toEqual({ scope: ['/a', '/b'] })
  })

  it('trims surrounding whitespace from scope values (string and array)', () => {
    expect(parseListFilesInput({ scope: '  /a/b  ' })).toEqual({ scope: ['/a/b'] })
    expect(parseListFilesInput({ scope: ['  /a', '/b\t'] })).toEqual({ scope: ['/a', '/b'] })
  })

  it.each([
    ['empty array scope', { scope: [] }],
    ['empty string scope', { scope: '' }],
    ['whitespace string scope', { scope: '  ' }],
    ['array with empty-string element', { scope: ['', '/a'] }],
    ['array with whitespace element', { scope: ['   ', '/a'] }],
    ['array with non-string element', { scope: ['/a', 5] }],
    ['number scope', { scope: 42 }],
    ['object scope', { scope: { path: '/a/b' } }],
    ['null scope', { scope: null }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseListFilesInput(raw)).toThrow(
      /scope must be a non-empty string or a non-empty array of non-empty strings/
    )
  })

  it.each([
    ['non-object non-undefined', 42],
    ['null', null],
    ['array', ['/a']],
  ])('rejects %s arguments', (_label, raw) => {
    expect(() => parseListFilesInput(raw)).toThrow(McpError)
  })

  it('throws InvalidParams error code for malformed scope', () => {
    try {
      parseListFilesInput({ scope: 42 })
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

describe('parseIngestFileInput', () => {
  it('accepts and preserves valid options', () => {
    expect(
      parseIngestFileInput({ filePath: '/docs/a.pdf', visual: true, visualQuality: 'quality' })
    ).toEqual({
      filePath: '/docs/a.pdf',
      visual: true,
      visualQuality: 'quality',
    })
  })

  it.each([undefined, null, {}, { filePath: '' }, { filePath: 1 }])(
    'rejects malformed input %#',
    (raw) => expect(() => parseIngestFileInput(raw)).toThrow(McpError)
  )

  it.each(['true', 1, null])('rejects visual=%j', (visual) => {
    expect(() => parseIngestFileInput({ filePath: '/docs/a.pdf', visual })).toThrow(
      /visual.*boolean/
    )
  })
})

describe('parseDeleteFileInput', () => {
  it.each([
    [{ filePath: '/docs/a.md' }, { filePath: '/docs/a.md' }],
    [{ source: 'https://example.com' }, { source: 'https://example.com' }],
  ])('accepts one document reference', (raw, expected) => {
    expect(parseDeleteFileInput(raw)).toEqual(expected)
  })

  it.each([undefined, null, {}, { filePath: '', source: '' }, { filePath: '/a', source: 's' }])(
    'rejects malformed or non-XOR input %#',
    (raw) => expect(() => parseDeleteFileInput(raw)).toThrow(McpError)
  )
})

describe('parseReadChunkNeighborsInput', () => {
  it('accepts a valid range request', () => {
    expect(
      parseReadChunkNeighborsInput({ filePath: '/docs/a.md', chunkIndex: 3, before: 1, after: 4 })
    ).toEqual({ filePath: '/docs/a.md', chunkIndex: 3, before: 1, after: 4 })
  })

  it.each([
    undefined,
    {},
    { filePath: '/a', chunkIndex: -1 },
    { filePath: '/a', chunkIndex: 1.5 },
    { filePath: '/a', chunkIndex: 0, before: 51 },
    { filePath: '/a', chunkIndex: 0, after: -1 },
  ])('rejects malformed input %#', (raw) => {
    expect(() => parseReadChunkNeighborsInput(raw)).toThrow(McpError)
  })
})

describe('parseSyncStartInput', () => {
  it('returns {} when arguments are omitted (undefined)', () => {
    expect(parseSyncStartInput(undefined)).toEqual({})
  })

  it('returns {} for an empty object (sync every configured root)', () => {
    expect(parseSyncStartInput({})).toEqual({})
  })

  it('passes an absolute path through', () => {
    expect(parseSyncStartInput({ path: '/docs/api' })).toEqual({ path: '/docs/api' })
  })

  it('trims surrounding whitespace from path', () => {
    expect(parseSyncStartInput({ path: '  /docs/api\t' })).toEqual({ path: '/docs/api' })
  })

  it.each([
    ['empty path', { path: '' }],
    ['whitespace path', { path: '   ' }],
    ['number path', { path: 42 }],
    ['null path', { path: null }],
    ['array path', { path: ['/docs/api'] }],
    ['object path', { path: { dir: '/docs/api' } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSyncStartInput(raw)).toThrow(/path must be a non-empty string/)
  })

  it.each([
    ['non-object', 42],
    ['null', null],
    ['array', ['/docs/api']],
  ])('rejects %s arguments', (_label, raw) => {
    expect(() => parseSyncStartInput(raw)).toThrow(McpError)
  })

  it('throws InvalidParams error code', () => {
    try {
      parseSyncStartInput({ path: 42 })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(McpError)
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams)
    }
  })

  it('reports a message that leaks no stack or caller-supplied path', () => {
    try {
      parseSyncStartInput({ path: ['/Users/someone/private/docs'] })
      expect.unreachable('should have thrown')
    } catch (error) {
      const { message } = error as McpError
      expect(message).not.toContain('/Users/someone/private/docs')
      expect(message).not.toContain('\n')
      expect(message).not.toMatch(/\bat\s+\S+:\d+/)
    }
  })
})

describe('parseSyncStatusInput', () => {
  it('accepts a job id', () => {
    expect(parseSyncStatusInput({ jobId: '8f2d1c34-1f9a-4f1e-9a3f-6d1b2c3e4f50' })).toEqual({
      jobId: '8f2d1c34-1f9a-4f1e-9a3f-6d1b2c3e4f50',
    })
  })

  it('trims surrounding whitespace from jobId', () => {
    expect(parseSyncStatusInput({ jobId: '  abc\t' })).toEqual({ jobId: 'abc' })
  })

  it.each([
    ['missing jobId', {}],
    ['empty jobId', { jobId: '' }],
    ['whitespace jobId', { jobId: '   ' }],
    ['number jobId', { jobId: 1 }],
    ['null jobId', { jobId: null }],
    ['array jobId', { jobId: ['abc'] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSyncStatusInput(raw)).toThrow(/jobId must be a non-empty string/)
  })

  it.each([
    ['omitted arguments', undefined],
    ['non-object', 42],
    ['null', null],
    ['array', ['abc']],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSyncStatusInput(raw)).toThrow(McpError)
  })

  it('throws InvalidParams error code', () => {
    try {
      parseSyncStatusInput({})
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(McpError)
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams)
    }
  })

  it('reports a message that leaks no stack or caller-supplied value', () => {
    try {
      parseSyncStatusInput({ jobId: ['/Users/someone/private/docs'] })
      expect.unreachable('should have thrown')
    } catch (error) {
      const { message } = error as McpError
      expect(message).not.toContain('/Users/someone/private/docs')
      expect(message).not.toMatch(/\bat\s+\S+:\d+/)
    }
  })
})
