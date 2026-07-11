// Unit tests for `classifyIngestedSources` — the pure `sources` classifier
// shared by the MCP `list_files` handler and the `list` CLI (extracted from the
// byte-for-byte-identical inline blocks at src/server/index.ts:691-699 and
// src/cli/list.ts:297-305).
//
// @category: unit
// @lane: unit
// @dependency: pure (looksLikeRawDataPath / extractSourceFromPath / matchesAnyScope) — no I/O
// @complexity: medium (raw-data vs real-file branch × scope present/absent)
// ROI: n/a (pure helper unit)

import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyIngestedSources } from '../list-sources.js'

// Build a `<dbPath>/raw-data/<base64url>.md` path whose encoded segment decodes
// to `source`, so `looksLikeRawDataPath` is true and `extractSourceFromPath`
// recovers `source` — matching how ingest_data stores raw content.
function rawDataPath(source: string): string {
  const encoded = Buffer.from(source, 'utf-8').toString('base64url')
  return `${sep}db${sep}raw-data${sep}${encoded}.md`
}

// A real on-disk file path (no `/raw-data/` segment).
function realFilePath(...segments: string[]): string {
  return sep + segments.join(sep)
}

const entry = (filePath: string) => ({
  entry: { filePath, chunkCount: 3, timestamp: '2026-07-09T00:00:00.000Z' },
  key: `key:${filePath}`,
})
const dbPath = realFilePath('db')

describe('classifyIngestedSources', () => {
  it('keeps only entries whose key is absent from matchedKeys (base filter)', () => {
    const matched = entry(realFilePath('base', 'a.txt'))
    const orphan = entry(realFilePath('base', 'b.txt'))
    const matchedKeys = new Set<string>([matched.key])

    const result = classifyIngestedSources([matched, orphan], matchedKeys, dbPath)

    expect(result).toEqual([
      {
        filePath: realFilePath('base', 'b.txt'),
        chunkCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ])
  })

  it('scope absent: raw-data yields {source} and real-file yields {filePath} (byte-for-byte with the pre-extraction block)', () => {
    const raw = entry(rawDataPath('https://example.com/doc'))
    const real = entry(realFilePath('base', 'orphan.txt'))

    const result = classifyIngestedSources([raw, real], new Set(), dbPath)

    expect(result).toEqual([
      { source: 'https://example.com/doc', chunkCount: 3, timestamp: '2026-07-09T00:00:00.000Z' },
      {
        filePath: realFilePath('base', 'orphan.txt'),
        chunkCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ])
  })

  it('scope present: raw-data source is always emitted regardless of scope', () => {
    const raw = entry(rawDataPath('clipboard://2026-07-09'))
    // scope points at an unrelated real subtree; the raw-data entry has no
    // filesystem path under it yet must still be emitted.
    const scope = [realFilePath('base', 'in-scope')]

    const result = classifyIngestedSources([raw], new Set(), dbPath, scope)

    expect(result).toEqual([
      { source: 'clipboard://2026-07-09', chunkCount: 3, timestamp: '2026-07-09T00:00:00.000Z' },
    ])
  })

  it('scope present: real-file entry UNDER scope remains an orphan source', () => {
    const underScope = entry(realFilePath('base', 'in-scope', 'orphan.txt'))
    const scope = [realFilePath('base', 'in-scope')]

    const result = classifyIngestedSources([underScope], new Set(), dbPath, scope)

    expect(result).toEqual([
      {
        filePath: realFilePath('base', 'in-scope', 'orphan.txt'),
        chunkCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ])
  })

  it('scope present: real-file entry OUTSIDE scope is dropped from sources (no orphan misclassification)', () => {
    const outsideScope = entry(realFilePath('base', 'other', 'orphan.txt'))
    const scope = [realFilePath('base', 'in-scope')]

    const result = classifyIngestedSources([outsideScope], new Set(), dbPath, scope)

    expect(result).toEqual([])
  })

  it('scope present: mixes raw-data (kept) + in-scope real (kept) + out-of-scope real (dropped)', () => {
    const raw = entry(rawDataPath('https://example.com/keep'))
    const underScope = entry(realFilePath('base', 'in-scope', 'keep.txt'))
    const outsideScope = entry(realFilePath('base', 'nope', 'drop.txt'))
    const scope = [realFilePath('base', 'in-scope')]

    const result = classifyIngestedSources(
      [raw, underScope, outsideScope],
      new Set(),
      dbPath,
      scope
    )

    expect(result).toEqual([
      { source: 'https://example.com/keep', chunkCount: 3, timestamp: '2026-07-09T00:00:00.000Z' },
      {
        filePath: realFilePath('base', 'in-scope', 'keep.txt'),
        chunkCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ])
  })

  it('empty scope array is treated as scope-absent (no extra filtering)', () => {
    const real = entry(realFilePath('base', 'orphan.txt'))

    const result = classifyIngestedSources([real], new Set(), dbPath, [])

    expect(result).toEqual([
      {
        filePath: realFilePath('base', 'orphan.txt'),
        chunkCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ])
  })

  it('does not classify a normal file merely because its directory is named raw-data', () => {
    const normal = entry(realFilePath('base', 'raw-data', 'plain.md'))

    expect(classifyIngestedSources([normal], new Set(), dbPath)).toEqual([
      {
        filePath: normal.entry.filePath,
        chunkCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
      },
    ])
  })
})
