// Type guard helpers for test assertions on FileEntry and SourceEntry unions

import type { FileEntry, SourceEntry } from '../../server/types.js'

/** Narrows a FileEntry to one with `failed: true` */
export function isFailedFileEntry(
  entry: FileEntry
): entry is { filePath: string; ingested: false; failed: true; error: string } {
  return 'failed' in entry && (entry as { failed?: boolean }).failed === true
}

/** Narrows a FileEntry to one with `ingesting: true` (not yet ingested) */
export function isIngestingFileEntry(
  entry: FileEntry
): entry is { filePath: string; ingested: false; ingesting: true; startedAt: string } {
  return (
    'ingesting' in entry &&
    (entry as { ingesting?: boolean }).ingesting === true &&
    (entry as { ingested: boolean }).ingested === false
  )
}

/** Narrows a SourceEntry to one with `failed: true` and no existing DB data */
export function isFailedSourceEntry(
  entry: SourceEntry
): entry is { source: string; failed: true; error: string } {
  return (
    'failed' in entry && (entry as { failed?: boolean }).failed === true && !('chunkCount' in entry)
  )
}
