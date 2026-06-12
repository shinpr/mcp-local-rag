import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmbeddingError } from '../../embedder/index.js'
import { FileOperationError, ValidationError } from '../../parser/index.js'
import { VlmError } from '../../pdf-visual/types.js'
import { BaseDirsConfigError } from '../../utils/base-dirs.js'
import { DatabaseError } from '../../vectordb/types.js'
import { formatErrorForClient, formatErrorForLog, logError, toMcpError } from '../error-utils.js'

describe('formatErrorForClient', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env['NODE_ENV']
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      process.env['NODE_ENV'] = undefined
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
  })

  it('returns the controlled message in production mode', () => {
    process.env['NODE_ENV'] = 'production'
    const error = new Error('Something went wrong')
    expect(formatErrorForClient(error)).toBe('Something went wrong')
  })

  it('returns only the message (secure by default) when NODE_ENV is unset', () => {
    process.env['NODE_ENV'] = undefined
    const error = new Error('Default mode error')
    expect(formatErrorForClient(error)).toBe('Default mode error')
  })

  it('does NOT include the raw cause chain text', () => {
    process.env['NODE_ENV'] = 'production'
    const root = new Error('SECRET_ROOT_CAUSE')
    const mid = new Error('mid layer failed', { cause: root })
    const outer = new Error('outer message', { cause: mid })
    const result = formatErrorForClient(outer)
    expect(result).toBe('outer message')
    expect(result).not.toContain('SECRET_ROOT_CAUSE')
    expect(result).not.toContain('mid layer failed')
  })

  it('coerces non-Error values to their string message', () => {
    process.env['NODE_ENV'] = 'production'
    expect(formatErrorForClient('string error')).toBe('string error')
    expect(formatErrorForClient({ message: 'obj error' })).toBe('obj error')
    expect(formatErrorForClient(null)).toBe('null')
  })
})

describe('formatErrorForLog', () => {
  it('includes every link of a 3-deep cause chain', () => {
    const root = new Error('root cause')
    const mid = new Error('mid cause', { cause: root })
    const outer = new Error('outer cause', { cause: mid })

    const result = formatErrorForLog(outer)

    expect(result).toContain('outer cause')
    expect(result).toContain('mid cause')
    expect(result).toContain('root cause')
  })

  it('includes stack information', () => {
    const error = new Error('with stack')
    const result = formatErrorForLog(error)
    // The stack string for a real Error contains the "Error:" header.
    expect(result).toContain('Error:')
    expect(result).toContain('with stack')
  })

  it('handles non-Error values without throwing', () => {
    expect(() => formatErrorForLog('plain string')).not.toThrow()
    expect(formatErrorForLog('plain string')).toContain('plain string')
  })
})

describe('logError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('writes to stderr (console.error) and returns void', () => {
    const error = new Error('log this')
    const result = logError('ingest_file', error)
    expect(result).toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('includes the context and the full cause chain in the logged output', () => {
    const root = new Error('deep root')
    const error = new Error('top', { cause: root })
    logError('read_chunk_neighbors', error)
    const logged = errorSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n')
    expect(logged).toContain('read_chunk_neighbors')
    expect(logged).toContain('top')
    expect(logged).toContain('deep root')
  })
})

describe('toMcpError type -> code mapping', () => {
  it('maps ValidationError to InvalidParams', () => {
    const result = toMcpError(new ValidationError('bad input'), {})
    expect(result).toBeInstanceOf(McpError)
    expect(result.code).toBe(ErrorCode.InvalidParams)
  })

  it('maps BaseDirsConfigError to InvalidParams', () => {
    const result = toMcpError(new BaseDirsConfigError('bad config'), {})
    expect(result.code).toBe(ErrorCode.InvalidParams)
  })

  it('maps DatabaseError to InternalError', () => {
    const result = toMcpError(new DatabaseError('db broke'), {})
    expect(result.code).toBe(ErrorCode.InternalError)
  })

  it('maps EmbeddingError to InternalError', () => {
    const result = toMcpError(new EmbeddingError('embedder broke'), {})
    expect(result.code).toBe(ErrorCode.InternalError)
  })

  it('maps FileOperationError to InternalError', () => {
    const result = toMcpError(new FileOperationError('io broke'), {})
    expect(result.code).toBe(ErrorCode.InternalError)
  })

  it('maps VlmError to InternalError', () => {
    const result = toMcpError(new VlmError('vlm broke', { pageNum: 1 }), {})
    expect(result.code).toBe(ErrorCode.InternalError)
  })

  it('maps a native Error to InternalError', () => {
    const result = toMcpError(new Error('native'), {})
    expect(result.code).toBe(ErrorCode.InternalError)
  })

  it('maps a non-Error thrown value to InternalError', () => {
    const result = toMcpError('string thrown', {})
    expect(result.code).toBe(ErrorCode.InternalError)
  })

  it('passes an existing McpError through unchanged', () => {
    const original = new McpError(ErrorCode.InvalidParams, 'already mcp')
    const result = toMcpError(original, { prefix: 'Failed to ingest file' })
    expect(result).toBe(original)
    expect(result.code).toBe(ErrorCode.InvalidParams)
  })
})

describe('toMcpError type-conditional prefix', () => {
  it('applies the prefix on the generic/native fallback', () => {
    const result = toMcpError(new Error('disk full'), { prefix: 'Failed to ingest file' })
    expect(result.code).toBe(ErrorCode.InternalError)
    expect(result.message).toContain('Failed to ingest file: disk full')
  })

  it('does NOT apply the prefix to a recognized AppError (DatabaseError stays raw)', () => {
    const result = toMcpError(new DatabaseError('db broke'), {
      prefix: 'Failed to read chunk neighbors',
    })
    expect(result.code).toBe(ErrorCode.InternalError)
    expect(result.message).not.toContain('Failed to read chunk neighbors')
    expect(result.message).toContain('db broke')
  })

  it('does NOT apply a prefix to a recognized AppError even when context carries one (EmbeddingError)', () => {
    const result = toMcpError(new EmbeddingError('Invalid RAG_DTYPE'), {
      prefix: 'Failed to ingest file',
    })
    expect(result.message).not.toContain('Failed to ingest file')
    expect(result.message).toContain('Invalid RAG_DTYPE')
  })

  it('adds no prefix when context has no prefix (prefix-less handler) on native error', () => {
    // The SDK wraps `.message` as `MCP error <code>: <message>`; assert on the
    // trailing client message content rather than the wrapped exact string.
    const result = toMcpError(new Error('raw rethrow'), {})
    expect(result.message.endsWith('raw rethrow')).toBe(true)
    expect(result.message).not.toContain('Failed to')
  })

  it('adds no prefix when context has no prefix on an AppError', () => {
    const result = toMcpError(new ValidationError('invalid query'), {})
    expect(result.message.endsWith('invalid query')).toBe(true)
  })

  it('never leaks the raw cause chain into the client message of the fallback path', () => {
    const root = new Error('SECRET_ROOT')
    const error = new Error('top failure', { cause: root })
    const result = toMcpError(error, { prefix: 'Failed to ingest file' })
    expect(result.message).not.toContain('SECRET_ROOT')
    expect(result.message.endsWith('Failed to ingest file: top failure')).toBe(true)
  })
})
