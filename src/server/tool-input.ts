// Runtime validation for MCP tool arguments.
//
// MCP tool arguments arrive as `unknown` from the SDK: TypeScript types are
// erased at runtime, so the previous `as unknown as XxxInput` casts let
// malformed input flow into the handlers (non-string query, negative limit,
// missing metadata, enum-violating format). These validators reject malformed
// input at the entry boundary with `McpError(InvalidParams)` — the same
// structured failure shape `read_chunk_neighbors` already uses — without
// leaking internal diagnostics to the client.

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { ContentFormat } from '../utils/raw-data-utils.js'
import type {
  DeleteFileInput,
  IngestDataInput,
  IngestFileInput,
  ListFilesInput,
  QueryDocumentsInput,
  ReadChunkNeighborsInput,
} from './types.js'

const CONTENT_FORMATS: readonly ContentFormat[] = ['text', 'html', 'markdown']

const SCOPE_ERROR = 'scope must be a non-empty string or a non-empty array of non-empty strings'

/**
 * Normalize the optional `scope` to a trimmed `string[]`, rejecting any other
 * shape with `McpError(InvalidParams)`. Mirrors the `limit` boundary check.
 */
function normalizeScope(scope: unknown): string[] {
  const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0

  // Trim so whitespace-padded prefixes don't silently match nothing.
  if (isNonEmptyString(scope)) {
    return [scope.trim()]
  }

  if (Array.isArray(scope) && scope.length > 0 && scope.every(isNonEmptyString)) {
    return scope.map((value) => value.trim())
  }

  throw new McpError(ErrorCode.InvalidParams, SCOPE_ERROR)
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpError(ErrorCode.InvalidParams, `${label} arguments must be an object`)
  }
  return raw as Record<string, unknown>
}

/**
 * Validate `query_documents` arguments. `query` must be a non-empty string;
 * `limit`, when provided, must be a positive integer (the handler defaults it
 * to 10 when absent).
 */
export function parseQueryDocumentsInput(raw: unknown): QueryDocumentsInput {
  const obj = asRecord(raw, 'query_documents')
  const { query, limit, scope } = obj

  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'query must be a non-empty string')
  }

  const input: QueryDocumentsInput = { query }

  if (limit !== undefined) {
    // Bound to 1-20 at the entry boundary — the same range VectorStore.search
    // enforces and the CLI `--limit` accepts. Rejecting here returns a clean
    // McpError(InvalidParams) instead of letting an out-of-range value reach
    // search() and surface as a DatabaseError.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new McpError(ErrorCode.InvalidParams, 'limit must be an integer between 1 and 20')
    }
    input.limit = limit
  }

  if (scope !== undefined) {
    input.scope = normalizeScope(scope)
  }

  return input
}

/**
 * Validate `list_files` arguments. The tool historically takes no arguments, so
 * an omitted `arguments` (`undefined`) or `{}` is accepted as "no scope". When
 * `scope` is present, it is normalized the same way as `query_documents`.
 */
export function parseListFilesInput(raw: unknown): ListFilesInput {
  // Preserve the no-argument contract: `asRecord` rejects `undefined`, so
  // short-circuit before it to avoid a spurious McpError on no-arg calls.
  if (raw === undefined) {
    return {}
  }

  const { scope } = asRecord(raw, 'list_files')

  if (scope === undefined) {
    return {}
  }

  return { scope: normalizeScope(scope) }
}

/**
 * Validate `ingest_data` arguments. `content` must be a non-empty string;
 * `metadata` must be an object with a non-empty `source` string and a `format`
 * in the supported set.
 */
export function parseIngestDataInput(raw: unknown): IngestDataInput {
  const obj = asRecord(raw, 'ingest_data')
  const { content, metadata } = obj

  if (typeof content !== 'string' || content.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'content must be a non-empty string')
  }

  const meta = asRecord(metadata, 'ingest_data metadata')
  const { source, format } = meta

  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'metadata.source must be a non-empty string')
  }

  if (typeof format !== 'string' || !CONTENT_FORMATS.includes(format as ContentFormat)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `metadata.format must be one of: ${CONTENT_FORMATS.join(', ')}`
    )
  }

  return { content, metadata: { source, format: format as ContentFormat } }
}

export function parseIngestFileInput(raw: unknown): IngestFileInput {
  const { filePath, visual, visualQuality } = asRecord(raw, 'ingest_file')
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'filePath must be a non-empty string')
  }
  if (visual !== undefined && typeof visual !== 'boolean') {
    throw new McpError(ErrorCode.InvalidParams, "'visual' must be a boolean if provided")
  }
  if (
    visualQuality !== undefined &&
    visualQuality !== '' &&
    visualQuality !== 'fast' &&
    visualQuality !== 'quality'
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "'visualQuality' must be 'fast' or 'quality' if provided"
    )
  }

  return {
    filePath,
    ...(visual !== undefined ? { visual } : {}),
    ...(visualQuality === 'fast' || visualQuality === 'quality' ? { visualQuality } : {}),
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseDeleteFileInput(raw: unknown): DeleteFileInput {
  const { filePath, source } = asRecord(raw, 'delete_file')
  const hasFilePath = nonEmptyString(filePath)
  const hasSource = nonEmptyString(source)
  if (hasFilePath === hasSource) {
    throw new McpError(
      ErrorCode.InvalidParams,
      hasFilePath
        ? 'Provide either filePath or source, not both'
        : 'Either filePath or source must be provided'
    )
  }
  return hasFilePath ? { filePath } : { source: source as string }
}

export function parseReadChunkNeighborsInput(raw: unknown): ReadChunkNeighborsInput {
  const { filePath, source, chunkIndex, before, after } = asRecord(raw, 'read_chunk_neighbors')
  if (!Number.isInteger(chunkIndex) || (chunkIndex as number) < 0) {
    throw new McpError(ErrorCode.InvalidParams, 'chunkIndex must be a non-negative integer')
  }
  for (const [label, value] of [
    ['before', before],
    ['after', after],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      throw new McpError(ErrorCode.InvalidParams, `${label} must be a non-negative integer`)
    }
    if (typeof value === 'number' && value > 50) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${label} must be between 0 and 50 (got ${value})`
      )
    }
  }

  const ref = parseDeleteFileInput({ filePath, source })
  return {
    ...ref,
    chunkIndex: chunkIndex as number,
    ...(before !== undefined ? { before: before as number } : {}),
    ...(after !== undefined ? { after: after as number } : {}),
  }
}
