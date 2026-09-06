// Pure `sources` classifier shared by the MCP `list_files` handler and the
// `list` CLI, so the raw-data / real-file scope branch lives in one place.
//
// `sources` are ingested entries whose identity key matched no scanned file:
// content from `ingest_data`, plus orphaned DB entries for files no longer on
// disk under a scanned root.

import { extractSourceFromPath, isManagedRawDataPath } from './raw-data-utils.js'
import { matchesAnyScope } from './scope-match.js'

/**
 * An ingested entry paired with its identity key (`realpathForMatch` of the
 * stored `filePath`). Only the fields the classifier reads are required, so the
 * caller's richer row type is consumed structurally.
 */
export interface KeyedIngestedEntry {
  entry: { filePath: string; chunkCount: number; timestamp: string }
  key: string
}

/**
 * A classified source: a raw-data entry restored to its original `source`, or a
 * real-file / orphaned entry keyed by `filePath`. Structurally compatible with
 * the `SourceEntry` union both surfaces already return (no type-move refactor).
 */
export type ClassifiedSource =
  | { source: string; chunkCount: number; timestamp: string }
  | { filePath: string; chunkCount: number; timestamp: string }

/**
 * Classify the ingested entries that matched no scanned file into `sources`.
 *
 * Under a `scope`, a managed raw-data entry is always emitted — it has no
 * filesystem path to be in or out of scope — while a real-file entry is kept
 * only when its stored path is in scope. An out-of-scope real file therefore
 * appears in neither `files[]` nor `sources[]`, rather than being
 * misreported as an orphan.
 */
export function classifyIngestedSources(
  ingestedKeyed: readonly KeyedIngestedEntry[],
  matchedKeys: ReadonlySet<string>,
  dbPath: string,
  scope?: string[]
): ClassifiedSource[] {
  const scopePrefixes = scope && scope.length > 0 ? scope : undefined

  return ingestedKeyed
    .filter(({ key }) => !matchedKeys.has(key))
    .filter(({ entry }) => {
      if (!scopePrefixes) {
        return true
      }
      // Raw-data sources are exempt from scope; real-file entries respect it.
      return (
        isManagedRawDataPath(entry.filePath, dbPath) ||
        matchesAnyScope(entry.filePath, scopePrefixes)
      )
    })
    .map(({ entry }) => {
      if (isManagedRawDataPath(entry.filePath, dbPath)) {
        const source = extractSourceFromPath(entry.filePath)
        if (source) {
          return { source, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
        }
      }
      return { filePath: entry.filePath, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
    })
}
