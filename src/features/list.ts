import { type ClassifiedSource, classifyIngestedSources } from '../utils/list-sources.js'
import { realpathForMatch } from '../utils/scan.js'

export interface IngestedFileSummary {
  filePath: string
  chunkCount: number
  timestamp: string
}

export type ListedFile =
  | {
      filePath: string
      baseDir: string
      ingested: true
      chunkCount: number
      timestamp: string
    }
  | { filePath: string; baseDir: string; ingested: false }

export interface RootScanResult {
  files: string[]
  warnings: string[]
}

export interface ListDocumentsResult {
  files: ListedFile[]
  sources: ClassifiedSource[]
  warnings: Array<{ baseDir: string; message: string }>
}

export async function listDocuments(input: {
  roots: readonly string[]
  dbPath: string
  ingested: IngestedFileSummary[]
  scope?: string[] | undefined
  scan: (root: string, scope?: string[] | undefined) => Promise<RootScanResult>
}): Promise<ListDocumentsResult> {
  const ingestedKeyed = await Promise.all(
    input.ingested.map(async (entry) => ({ entry, key: await realpathForMatch(entry.filePath) }))
  )
  const ingestedByKey = new Map(ingestedKeyed.map(({ entry, key }) => [key, entry]))
  const seenKeys = new Set<string>()
  const matchedKeys = new Set<string>()
  const files: ListedFile[] = []
  const warnings: Array<{ baseDir: string; message: string }> = []

  for (const baseDir of input.roots) {
    const scanned = await input.scan(baseDir, input.scope)
    warnings.push(...scanned.warnings.map((message) => ({ baseDir, message })))

    for (const scannedPath of scanned.files) {
      const key = await realpathForMatch(scannedPath)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)

      const entry = ingestedByKey.get(key)
      if (entry) {
        matchedKeys.add(key)
        files.push({
          filePath: entry.filePath,
          baseDir,
          ingested: true,
          chunkCount: entry.chunkCount,
          timestamp: entry.timestamp,
        })
      } else {
        files.push({ filePath: scannedPath, baseDir, ingested: false })
      }
    }
  }

  return {
    files,
    sources: classifyIngestedSources(ingestedKeyed, matchedKeys, input.dbPath, input.scope),
    warnings,
  }
}
