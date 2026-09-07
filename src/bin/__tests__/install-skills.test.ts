// The installer copies a declared set rather than the whole directory, so the
// declaration can fall behind the files on disk. These cases compare an actual
// install against the repository's own `skills/` tree, which is what turns that
// drift into a failure here instead of a reference silently missing from a
// release.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../install-skills.js'

const SKILLS_SOURCE = resolve(process.cwd(), 'skills', 'mcp-local-rag')

/** Reference file names the repository actually ships, sorted. */
function sourceReferences(): string[] {
  return readdirSync(join(SKILLS_SOURCE, 'references'))
    .filter((name) => name.endsWith('.md'))
    .sort()
}

describe('skills install', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-local-rag-skills-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function install(): string {
    const target = join(root, 'skills')
    run(['--path', target])
    return join(target, 'mcp-local-rag')
  }

  it('installs every reference the repository ships', () => {
    const installed = install()

    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    expect(readdirSync(join(installed, 'references')).sort()).toEqual(sourceReferences())
  })

  it('removes a retired reference while keeping one the user added', () => {
    const references = join(root, 'skills', 'mcp-local-rag', 'references')
    mkdirSync(references, { recursive: true })
    writeFileSync(join(references, 'query-optimization.md'), 'stale release content')
    writeFileSync(join(references, 'team-notes.md'), 'notes the user wrote')

    const installed = install()

    expect(readdirSync(join(installed, 'references')).sort()).toEqual([
      ...sourceReferences(),
      'team-notes.md',
    ])
  })
})
