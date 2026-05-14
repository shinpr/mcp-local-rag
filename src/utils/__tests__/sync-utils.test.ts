import { describe, expect, it } from 'vitest'
import { createSyncPlan, type SyncFileMetadata } from '../sync-utils.js'

describe('createSyncPlan', () => {
  it('should categorize files into skip, upsert, and prune', () => {
    const diskFiles = new Map<string, SyncFileMetadata>([
      ['unchanged.md', { contentHash: 'aaa' }],
      ['modified.md', { contentHash: 'bbb' }],
      ['new.md', { contentHash: 'ccc' }],
    ])

    const dbFiles = new Map<string, SyncFileMetadata>([
      ['unchanged.md', { contentHash: 'aaa' }],
      ['modified.md', { contentHash: 'ddd' }],
      ['deleted.md', { contentHash: 'eee' }],
    ])

    const plan = createSyncPlan(diskFiles, dbFiles)

    expect(plan.skipList).toEqual(['unchanged.md'])
    expect(plan.upsertList).toEqual(expect.arrayContaining(['modified.md', 'new.md']))
    expect(plan.upsertList).toHaveLength(2)
    expect(plan.pruneList).toEqual(['deleted.md'])
  })

  it('should handle empty disk and db', () => {
    const plan = createSyncPlan(new Map(), new Map())
    expect(plan.skipList).toHaveLength(0)
    expect(plan.upsertList).toHaveLength(0)
    expect(plan.pruneList).toHaveLength(0)
  })

  it('should prune all files if disk is empty', () => {
    const diskFiles = new Map()
    const dbFiles = new Map<string, SyncFileMetadata>([['a.md', { contentHash: 'aaa' }]])
    const plan = createSyncPlan(diskFiles, dbFiles)
    expect(plan.pruneList).toEqual(['a.md'])
    expect(plan.upsertList).toHaveLength(0)
  })

  it('should upsert all files if db is empty', () => {
    const diskFiles = new Map<string, SyncFileMetadata>([['a.md', { contentHash: 'aaa' }]])
    const dbFiles = new Map()
    const plan = createSyncPlan(diskFiles, dbFiles)
    expect(plan.upsertList).toEqual(['a.md'])
    expect(plan.pruneList).toHaveLength(0)
  })
})
