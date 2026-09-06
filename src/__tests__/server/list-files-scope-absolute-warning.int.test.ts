// handleListFiles(scope) non-absolute-prefix warning (code-review finding #2).
//
// AC: The tool schema documents that a scope prefix must be absolute and a
//     relative prefix matches nothing. This test pins the UX signal: a
//     non-absolute prefix yields a non-fatal warning content block while the
//     result semantics stay exactly "matches nothing" (behavior-additive, no
//     rejection); absolute prefixes produce no such block and still return
//     their scoped files[].
// Behavior: `handleListFiles({ scope })` over a real LanceDB + real-FS fixture
//     (uningested files only — no embedding needed) → warning block naming each
//     non-absolute prefix; absolute prefixes produce no such block and still
//     return their scoped files[].

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RagContentBlock } from '../../server/error-utils.js'
import { RAGServer } from '../../server/index.js'
import { testModelCacheDir, withTestDevice } from '../test-device.js'
import { parseJson } from '../test-doubles.js'

const NON_ABSOLUTE_WARNING = /Warning: scope prefix "([^"]+)" is not absolute/

function warningPrefixes(content: RagContentBlock[]): string[] {
  const prefixes: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      const match = NON_ABSOLUTE_WARNING.exec(block.text)
      if (match?.[1] !== undefined) {
        prefixes.push(match[1])
      }
    }
  }
  return prefixes
}

function parsedFiles(content: RagContentBlock[]): string[] {
  const first = content[0]
  if (first === undefined || first.type !== 'text') {
    throw new Error('expected a leading JSON text block')
  }
  const parsed = parseJson<{ files: { filePath: string }[] }>(first.text)
  return parsed.files.map((f) => f.filePath)
}

describe('handleListFiles(scope) — non-absolute prefix warning (finding #2)', () => {
  const base = resolve('./tmp/test-list-files-nonabs-warning')
  const dataDir = join(base, 'data')
  const dbPath = join(base, 'lancedb')
  const cacheDir = join(base, 'cache')
  const inScopeFile = join(dataDir, 'keep.txt')

  let server: InstanceType<typeof RAGServer>

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(dbPath, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(inScopeFile, 'A scannable file. '.repeat(20))

    server = new RAGServer(
      withTestDevice({
        dbPath,
        modelName: 'Xenova/all-MiniLM-L6-v2',
        cacheDir: testModelCacheDir(cacheDir),
        baseDir: dataDir,
        maxFileSize: 100 * 1024 * 1024,
      })
    )
    await server.initialize()
  }, 120000)

  afterAll(async () => {
    if (server) {
      await server.close()
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('appends a warning block naming a non-absolute scope prefix (result stays empty)', async () => {
    const { content } = await server.handleListFiles({ scope: ['relative'] })

    expect(warningPrefixes(content)).toContain('relative')
    // Semantics unchanged: a non-absolute prefix still matches nothing.
    expect(parsedFiles(content)).toEqual([])
  })

  it('emits no non-absolute warning for an absolute scope prefix', async () => {
    const { content } = await server.handleListFiles({ scope: [dataDir] })

    expect(warningPrefixes(content)).toEqual([])
    // The absolute scope still returns its scanned file.
    expect(parsedFiles(content)).toContain(inScopeFile)
  })

  it('warns only for the relative prefix in a mixed scope and keeps absolute results', async () => {
    const { content } = await server.handleListFiles({ scope: [dataDir, 'relative'] })

    expect(warningPrefixes(content)).toEqual(['relative'])
    expect(parsedFiles(content)).toContain(inScopeFile)
  })
})
