// Repair uploaded_files rows that store cwd-relative paths instead of absolute paths

import { eq } from 'drizzle-orm'
import type { ApiConfig } from './config.js'
import { getDb } from './db/index.js'
import { uploadedFiles } from './db/schema.js'
import { resolveStoredFilePath } from './upload-utils.js'

/**
 * Update legacy relative file_path values to absolute paths.
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
        ...(file.indexingStatus === 'failed'
          ? { indexingStatus: 'pending' as const, errorMessage: null }
          : {}),
      })
      .where(eq(uploadedFiles.id, file.id))

    repaired++
  }

  if (repaired > 0) {
    // biome-ignore lint/suspicious/noConsole: startup repair log
    console.log(`Repaired ${repaired} relative file path(s) in database`)
  }

  return repaired
}
