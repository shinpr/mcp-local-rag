import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { toolDefinitions } from '../tool-definitions.js'
import type { SyncStatusResult } from '../types.js'

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

  it('describes scope on a reachable/scan-path basis, not the query stored-filePath phrasing', () => {
    const description = scope?.description as string
    expect(description).toMatch(/reachable/i)
    // MUST NOT copy the query_documents wording, which contradicts the scan-path basis
    expect(description).not.toMatch(/filePath equal to or under/)
  })

  it('keeps boundary-safe and absolute-path guidance', () => {
    const description = scope?.description as string
    expect(description).toContain('/docs/api')
    expect(description).toContain('/docs/apiv2')
    expect(description).toMatch(/absolute/i)
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

  it('declares no sync tool beyond sync_start and sync_status', () => {
    const syncTools = toolDefinitions
      .filter((tool) => tool.name.startsWith('sync_'))
      .map((tool) => tool.name)
    expect(syncTools).toEqual(['sync_start', 'sync_status'])
    expect(syncTools).not.toContain('sync_cancel')
    expect(syncTools).not.toContain('sync_list_jobs')
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

  it('states that the call returns a jobId before the work begins and is polled via sync_status', () => {
    const description = syncStart.description as string
    expect(description).toMatch(/jobId/)
    expect(description).toMatch(/before scanning/i)
    expect(description).toMatch(/sync_status/)
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

  it('describes the returned record as the current or latest job', () => {
    const description = syncStatus.description as string
    expect(description).toMatch(/current or latest/i)
  })
})

describe('sync status record contract', () => {
  const record: SyncStatusResult = {
    jobId: '8f2d1c34-1f9a-4f1e-9a3f-6d1b2c3e4f50',
    state: 'running',
    total: null,
    completed: 0,
    summary: { upserted: 0, skipped: 0, empty: 0, pruned: 0 },
    warnings: [],
    error: null,
  }

  // The plan restricts the record to these keys: no history, timestamps,
  // failure collection, or recovery state may appear.
  it('carries exactly the fields of the MCP contract', () => {
    expect(Object.keys(record).sort()).toEqual([
      'completed',
      'error',
      'jobId',
      'state',
      'summary',
      'total',
      'warnings',
    ])
  })

  it('carries exactly the four summary counters', () => {
    expect(Object.keys(record.summary).sort()).toEqual(['empty', 'pruned', 'skipped', 'upserted'])
  })

  it('serializes total as JSON null before scanning has counted the disk files', () => {
    expect(JSON.parse(JSON.stringify(record))).toEqual({
      jobId: '8f2d1c34-1f9a-4f1e-9a3f-6d1b2c3e4f50',
      state: 'running',
      total: null,
      completed: 0,
      summary: { upserted: 0, skipped: 0, empty: 0, pruned: 0 },
      warnings: [],
      error: null,
    })
  })
})
