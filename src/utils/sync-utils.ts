/**
 * Synchronization utilities for incremental updates
 */

/**
 * Sync plan for a single file
 */
export type SyncAction = 'skip' | 'upsert' | 'prune'

/**
 * File metadata for sync diffing
 */
export interface SyncFileMetadata {
  fileModifiedAt: string
  fileSize: number
}

/**
 * Batch sync plan
 */
export interface SyncPlan {
  upsertList: string[]
  pruneList: string[]
  skipList: string[]
}

/**
 * Compare disk state with database state to create a sync plan.
 *
 * @param diskFiles - Map of filePath to disk metadata
 * @param dbFiles - Map of filePath to database metadata
 * @returns SyncPlan categorized by action
 */
export function createSyncPlan(
  diskFiles: Map<string, SyncFileMetadata>,
  dbFiles: Map<string, SyncFileMetadata>
): SyncPlan {
  const upsertList: string[] = []
  const pruneList: string[] = []
  const skipList: string[] = []

  // 1. Check disk files against DB
  for (const [filePath, diskMeta] of diskFiles.entries()) {
    const dbMeta = dbFiles.get(filePath)

    if (!dbMeta) {
      // New file
      upsertList.push(filePath)
    } else if (dbMeta.fileModifiedAt !== diskMeta.fileModifiedAt) {
      // Changed file
      upsertList.push(filePath)
    } else {
      // Unchanged file
      skipList.push(filePath)
    }
  }

  // 2. Check DB files against disk (Pruning)
  for (const filePath of dbFiles.keys()) {
    if (!diskFiles.has(filePath)) {
      pruneList.push(filePath)
    }
  }

  return { upsertList, pruneList, skipList }
}
