import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { toolDefinitions } from '../tool-definitions.js'

const findTool = (name: string): Tool => {
  const tool = toolDefinitions.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not found`)
  return tool
}

const propertyOf = (tool: Tool, property: string): Record<string, unknown> =>
  (tool.inputSchema.properties as Record<string, Record<string, unknown>>)?.[property] ?? {}

describe('list_files tool definition scope', () => {
  const listFiles = findTool('list_files')
  const scope = (listFiles.inputSchema.properties as Record<string, unknown>)?.scope as
    | Record<string, unknown>
    | undefined

  it('advertises an optional scope property', () => {
    expect(scope).toBeDefined()
    // scope is optional: list_files declares no required arguments (backward compatible)
    expect(listFiles.inputSchema.required).toBeUndefined()
  })

  it('uses the string | array<string> oneOf shape', () => {
    expect(scope?.oneOf).toEqual([{ type: 'string' }, { type: 'array', items: { type: 'string' } }])
  })

  // Regression guard with provenance: the description once carried the
  // query_documents wording, which claims stored-filePath semantics and
  // contradicts the scan-path basis list_files actually filters on.
  it('does not claim the query_documents stored-filePath semantics', () => {
    expect(scope?.description as string).not.toMatch(/filePath equal to or under/)
  })
})

describe('declared tool surface', () => {
  // Pins the whole advertised set: it is simultaneously the "exactly two sync
  // tools" assertion and the "no existing entry was added, removed, or renamed"
  // assertion (SYNC-006).
  it('advertises exactly the expected tools, in order', () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual([
      'query_documents',
      'ingest_file',
      'ingest_data',
      'delete_file',
      'list_files',
      'status',
      'read_chunk_neighbors',
      'sync_start',
      'sync_status',
    ])
  })

  // SYNC-006 / ADR decision 1: the sync tools are ordinary tools/call entries.
  // Any extra top-level key would be a negotiated capability the server does
  // not implement.
  it.each(['sync_start', 'sync_status'])(
    '%s declares no notification, task, or experimental field',
    (name) => {
      expect(Object.keys(findTool(name)).sort()).toEqual(['description', 'inputSchema', 'name'])
    }
  )
})

describe('sync_start tool definition', () => {
  const syncStart = findTool('sync_start')

  it('declares path as an optional string', () => {
    expect(propertyOf(syncStart, 'path').type).toBe('string')
    // Optional: no required array at all, matching list_files and delete_file.
    expect(syncStart.inputSchema.required).toBeUndefined()
  })

  it('declares no property other than path', () => {
    expect(Object.keys(syncStart.inputSchema.properties ?? {})).toEqual(['path'])
  })

  it('exposes no visual PDF option', () => {
    expect(JSON.stringify(syncStart)).not.toMatch(/visual/i)
  })
})

describe('sync_status tool definition', () => {
  const syncStatus = findTool('sync_status')

  it('declares jobId as a required string', () => {
    expect(propertyOf(syncStatus, 'jobId').type).toBe('string')
    expect(syncStatus.inputSchema.required).toEqual(['jobId'])
  })
})
