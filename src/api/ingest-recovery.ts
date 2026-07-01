// Recover files and jobs left in a running/indexing state after a crash or restart

import { and, eq } from 'drizzle-orm'
import type { ApiConfig } from './config.js'
import { getDb } from './db/index.js'
import { indexJobs, uploadedFiles } from './db/schema.js'

export interface RecoveryResult {
  jobsFailed: number
  filesReset: number
}

/**
 * Fail orphaned running jobs and reset stuck indexing files for one project.
 * Safe to call before index/reindex when the UI detects stuck files.
 */
export async function recoverProjectIndexing(
  config: ApiConfig,
  projectId: number
): Promise<RecoveryResult> {
  const db = getDb(config.databaseUrl)

  const runningJobs = await db
    .select({ id: indexJobs.id })
    .from(indexJobs)
    .where(and(eq(indexJobs.projectId, projectId), eq(indexJobs.status, 'running')))

  if (runningJobs.length > 0) {
    await db
      .update(indexJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: 'Job interrupted or superseded',
      })
      .where(and(eq(indexJobs.projectId, projectId), eq(indexJobs.status, 'running')))
  }

  const stuckFiles = await db
    .select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(
      and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.indexingStatus, 'indexing'))
    )

  if (stuckFiles.length > 0) {
    await db
      .update(uploadedFiles)
      .set({ indexingStatus: 'pending', errorMessage: null })
      .where(
        and(eq(uploadedFiles.projectId, projectId), eq(uploadedFiles.indexingStatus, 'indexing'))
      )
  }

  const result = { jobsFailed: runningJobs.length, filesReset: stuckFiles.length }

  if (result.jobsFailed > 0 || result.filesReset > 0) {
    // biome-ignore lint/suspicious/noConsole: recovery log
    console.log(
      `Recovered project ${projectId} indexing: ${result.jobsFailed} job(s) failed, ${result.filesReset} file(s) reset to pending`
    )
  }

  return result
}

/**
 * Mark interrupted index jobs as failed and reset orphaned indexing files to pending.
 * Called once during server startup before handling requests.
 */
export async function recoverStuckIndexing(config: ApiConfig): Promise<RecoveryResult> {
  const db = getDb(config.databaseUrl)

  const runningJobs = await db
    .select({ id: indexJobs.id })
    .from(indexJobs)
    .where(eq(indexJobs.status, 'running'))

  if (runningJobs.length > 0) {
    await db
      .update(indexJobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: 'Job interrupted by server restart',
      })
      .where(eq(indexJobs.status, 'running'))
  }

  const stuckFiles = await db
    .select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(eq(uploadedFiles.indexingStatus, 'indexing'))

  if (stuckFiles.length > 0) {
    await db
      .update(uploadedFiles)
      .set({ indexingStatus: 'pending', errorMessage: null })
      .where(eq(uploadedFiles.indexingStatus, 'indexing'))
  }

  const result = { jobsFailed: runningJobs.length, filesReset: stuckFiles.length }

  if (result.jobsFailed > 0 || result.filesReset > 0) {
    // biome-ignore lint/suspicious/noConsole: startup recovery log
    console.log(
      `Recovered stuck indexing: ${result.jobsFailed} job(s) failed, ${result.filesReset} file(s) reset to pending`
    )
  }

  return result
}
