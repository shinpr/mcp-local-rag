// Pure `sources` classifier shared by the MCP `list_files` handler
// (`src/server/index.ts`) and the `list` CLI (`src/cli/list.ts`). Extracted
// from the byte-for-byte-identical inline blocks in both surfaces so the
// raw-data / real-file scope branch lives in one place, mirroring the
// drift-avoidance rationale behind the shared `scope-match.ts` matcher.
//
// `sources` are ingested entries whose identity key matched no scanned file:
// content ingested via `ingest_data` (raw-data paths) plus orphaned DB entries
// for real files not currently on disk under a scanned root.

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
 * Base filter (always): keep only entries whose `key` is absent from
 * `matchedKeys`.
 *
 * When `scope` is present (non-empty): raw-data entries
 * Managed raw-data entries have no filesystem path under a base directory, so
 * they are always emitted regardless of scope; real-file entries are kept only
 * when their stored `filePath` is under scope (`matchesAnyScope`) — a real-file
 * entry outside scope is dropped so it appears in neither `files[]` (already
 * pruned from the scan) nor `sources[]` (no orphan misclassification), while an
 * unmatched real-file entry under scope remains an orphan source.
 *
 * When `scope` is absent (or empty): behavior is unchanged from the pre-extraction
 * inline block — every unmatched entry is emitted, raw-data as `{ source }` when
 * `extractSourceFromPath` yields one, else as `{ filePath }`.
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
      if (!scopePrefixes) return true
      // Raw-data sources are exempt from scope; real-file entries respect it.
      return (
        isManagedRawDataPath(entry.filePath, dbPath) ||
        matchesAnyScope(entry.filePath, scopePrefixes)
      )
    })
    .map(({ entry }) => {
      if (isManagedRawDataPath(entry.filePath, dbPath)) {
        const source = extractSourceFromPath(entry.filePath)
        if (source) return { source, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
      }
      return { filePath: entry.filePath, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
    })
}
