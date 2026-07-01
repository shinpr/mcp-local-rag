// Repair uploaded_files rows with stale or relative file_path values

import { eq } from 'drizzle-orm'
import type { ApiConfig } from './config.js'
import { getDb } from './db/index.js'
import { uploadedFiles } from './db/schema.js'
import { resolveStoredFilePath } from './upload-utils.js'

const PATH_REPAIR_ERROR_PATTERN =
  /configured base directory|File path must be absolute|File not found|No configured base directory/i

/**
 * Normalize file_path to the canonical path on this machine.
 * Returns the number of rows repaired.
 */
export async function repairRelativeFilePaths(config: ApiConfig): Promise<number> {
  const db = getDb(config.databaseUrl)
  const files = await db
    .select({
      id: uploadedFiles.id,
      filePath: uploadedFiles.filePath,
      projectId: uploadedFiles.projectId,
      storedFilename: uploadedFiles.storedFilename,
      indexingStatus: uploadedFiles.indexingStatus,
      errorMessage: uploadedFiles.errorMessage,
    })
    .from(uploadedFiles)

  let repaired = 0

  for (const file of files) {
    const resolved = resolveStoredFilePath(file.filePath, config.uploadDir, {
      projectId: file.projectId,
      storedFilename: file.storedFilename,
    })
    if (resolved === file.filePath) continue

    await db
      .update(uploadedFiles)
      .set({
        filePath: resolved,
        ...(file.indexingStatus === 'failed' &&
        file.errorMessage &&
        PATH_REPAIR_ERROR_PATTERN.test(file.errorMessage)
          ? { indexingStatus: 'pending' as const, errorMessage: null }
          : {}),
      })
      .where(eq(uploadedFiles.id, file.id))

    repaired++
  }

  if (repaired > 0) {
    console.log(`Repaired ${repaired} stale file path(s) in database`)
  }

  return repaired
}
