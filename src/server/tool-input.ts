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
import type { IngestDataInput, QueryDocumentsInput } from './types.js'

const CONTENT_FORMATS: readonly ContentFormat[] = ['text', 'html', 'markdown']

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
  const { query, limit } = obj

  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'query must be a non-empty string')
  }

  if (limit !== undefined) {
    // Bound to 1-20 at the entry boundary — the same range VectorStore.search
    // enforces and the CLI `--limit` accepts. Rejecting here returns a clean
    // McpError(InvalidParams) instead of letting an out-of-range value reach
    // search() and surface as a DatabaseError.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new McpError(ErrorCode.InvalidParams, 'limit must be an integer between 1 and 20')
    }
    return { query, limit }
  }

  return { query }
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
