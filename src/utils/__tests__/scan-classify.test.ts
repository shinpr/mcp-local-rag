// Collect-predicate classification tests for `src/utils/scan.ts`.
// Test Type: Unit (`classifyScanEntry`, pure) + Integration (`classifyRequestedPath`,
// real filesystem fixtures under the gitignored project-root `tmp/`)
//
// Why this file exists: sync accepts a path a caller names as well as a path the
// walk discovers, and only the discovered one used to pass the walker's four
// predicates. Everything here is that shared decision — a symbolic link is never
// followed, an excluded prefix is never entered, an unsupported extension is not a
// document, and something that is neither a regular file nor a directory (a FIFO,
// whose read never returns) is refused.
//
// No module mocking: `../scan.js` is imported by other test files, and the
// functions under test need no collaborator substitution.

import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_SCAN_DEPTH } from '../limits.js'
import { bfsCollectSupportedFiles, classifyRequestedPath, classifyScanEntry } from '../scan.js'

// ============================================
// Fixtures
// ============================================

const TMP_ROOT = resolve('./tmp/test-scan-classify')

/**
 * Stand-in for the type facts `Dirent` and `Stats` both expose. Built from one
 * label so no case can accidentally claim to be two things at once.
 */
function entryFacts(kind: 'symlink' | 'directory' | 'file' | 'fifo') {
  return {
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
  }
}

/**
 * Symlink creation needs admin/developer mode on the `windows-latest` CI leg, so
 * probe support once and skip those cases there rather than failing the job on an
 * environment limitation (same probe as `src/__tests__/cli/list-scope.int.test.ts`).
 */
function symlinkSupported(): boolean {
  const probeDir = join(TMP_ROOT, 'symlink-probe')
  try {
    mkdirSync(join(probeDir, 'target'), { recursive: true })
    symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'), 'dir')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

/** `mkfifo` is POSIX-only, so the real-FIFO case is probed the same way. */
function fifoSupported(): boolean {
  const probePath = join(TMP_ROOT, 'fifo-probe.md')
  try {
    mkdirSync(TMP_ROOT, { recursive: true })
    execFileSync('mkfifo', [probePath])
    const probe = lstatSync(probePath)
    return !probe.isFile() && !probe.isDirectory()
  } catch {
    return false
  } finally {
    rmSync(probePath, { force: true })
  }
}

const itWithSymlinks = symlinkSupported() ? it : it.skip
const itWithFifos = fifoSupported() ? it : it.skip

// ============================================
// classifyScanEntry (pure, host-independent)
// ============================================

describe('classifyScanEntry', () => {
  const EXCLUDED = [`${resolve('/db')}${sep}`]

  it('reports a symbolic link as a link even under an excluded prefix', () => {
    expect(
      classifyScanEntry(join(resolve('/db'), 'link.md'), entryFacts('symlink'), EXCLUDED)
    ).toBe('symlink')
  })

  it('reports an excluded path before looking at what it is', () => {
    expect(classifyScanEntry(join(resolve('/db'), 'a.md'), entryFacts('file'), EXCLUDED)).toBe(
      'excluded'
    )
    expect(classifyScanEntry(join(resolve('/db'), 'sub'), entryFacts('directory'), EXCLUDED)).toBe(
      'excluded'
    )
  })

  it('accepts a directory without testing its extension', () => {
    expect(
      classifyScanEntry(join(resolve('/docs'), 'archive.bin'), entryFacts('directory'), EXCLUDED)
    ).toBe('directory')
  })

  it.each(['a.md', 'a.txt', 'a.pdf', 'a.docx', 'A.MD', 'a.PDF'])(
    'accepts the supported file %s',
    (name) => {
      expect(classifyScanEntry(join(resolve('/docs'), name), entryFacts('file'), EXCLUDED)).toBe(
        'file'
      )
    }
  )

  it.each(['a.bin', 'a.zip', 'a.md.gz', 'noextension'])(
    'refuses the unsupported file %s',
    (name) => {
      expect(classifyScanEntry(join(resolve('/docs'), name), entryFacts('file'), EXCLUDED)).toBe(
        'unsupported'
      )
    }
  )

  it('refuses something that is neither a regular file nor a directory', () => {
    // A FIFO, socket, or device answers false to all three questions. Reading one
    // can block forever, which is why the answer must not be `file`.
    expect(classifyScanEntry(join(resolve('/docs'), 'pipe.md'), entryFacts('fifo'), EXCLUDED)).toBe(
      'irregular'
    )
  })
})

// ============================================
// classifyRequestedPath (real filesystem)
// ============================================

describe('classifyRequestedPath', () => {
  const caseDir = join(TMP_ROOT, 'requested')
  const dbDir = join(caseDir, 'db')
  const excludePaths = [`${dbDir}${sep}`]
  const supportedFile = join(caseDir, 'doc.md')
  const unsupportedFile = join(caseDir, 'archive.bin')
  const managedFile = join(dbDir, 'raw-data', 'captured.md')
  const outsideTarget = join(TMP_ROOT, 'outside', 'secret.md')
  const linkPath = join(caseDir, 'alias.md')
  const fifoPath = join(caseDir, 'pipe.md')

  beforeAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
    await mkdir(join(dbDir, 'raw-data'), { recursive: true })
    await mkdir(join(TMP_ROOT, 'outside'), { recursive: true })
    await writeFile(supportedFile, 'a document')
    await writeFile(unsupportedFile, 'not a document')
    await writeFile(managedFile, 'captured content')
    await writeFile(outsideTarget, 'a secret outside every root')
    if (symlinkSupported()) symlinkSync(outsideTarget, linkPath, 'file')
    if (fifoSupported()) execFileSync('mkfifo', [fifoPath])
  })

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
  })

  it('accepts a supported regular file', async () => {
    expect(await classifyRequestedPath(supportedFile, excludePaths)).toBe('file')
  })

  it('accepts a directory', async () => {
    expect(await classifyRequestedPath(caseDir, excludePaths)).toBe('directory')
  })

  it('reports an absent path as missing', async () => {
    expect(await classifyRequestedPath(join(caseDir, 'ghost.md'), excludePaths)).toBe('missing')
  })

  it('refuses an unsupported extension', async () => {
    expect(await classifyRequestedPath(unsupportedFile, excludePaths)).toBe('unsupported')
  })

  it('refuses a path inside an excluded directory', async () => {
    expect(await classifyRequestedPath(managedFile, excludePaths)).toBe('excluded')
  })

  itWithSymlinks('refuses a symbolic link instead of resolving to its target', async () => {
    // `lstat`, not `stat`: the target is a readable supported file outside every
    // configured root, so following the link is exactly the leak to avoid.
    expect(await classifyRequestedPath(linkPath, excludePaths)).toBe('symlink')
  })

  itWithFifos(
    'refuses a FIFO, and answers instead of blocking on it',
    async () => {
      // The whole point: a read of this path never returns. The tight timeout is
      // the assertion that classification does not read.
      expect(await classifyRequestedPath(fifoPath, excludePaths)).toBe('irregular')
    },
    5000
  )
})

// ============================================
// Case-folded exclusion (Windows), both routes
// ============================================

describe('exclude-prefix comparison, case differences', () => {
  // Exclude prefixes are built with `resolve()` only, which preserves case, so on
  // Windows — where the filesystem does not — `BASE_DIRS` and `DB_PATH` spelled
  // with different case left database and cache files classified as documents.
  // Worse than a plain miss: the prune guard compares case-folded keys
  // (`toSyncPathKey`), so those files were ingested and then never prunable.
  // `platform` is a parameter for the same reason `toSyncPathKey` takes one — the
  // Windows branch has to be provable from a POSIX host.
  const caseDir = join(TMP_ROOT, 'case-fold')
  const dbDir = join(caseDir, 'LanceDB')
  const dbFile = join(dbDir, 'raw.md')
  const documentFile = join(caseDir, 'report.md')
  // The same directory as `dbDir`, spelled in a different case, prefixed exactly
  // the way both adapters build `excludePaths`.
  const differentlyCasedDbPrefix = `${dbDir.toLowerCase()}${sep}`

  beforeAll(async () => {
    await mkdir(dbDir, { recursive: true })
    await writeFile(dbFile, 'database internals')
    await writeFile(documentFile, 'a document')
  })

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true })
  })

  const walkedFiles = async (platform: NodeJS.Platform): Promise<string[]> =>
    (
      await bfsCollectSupportedFiles(
        caseDir,
        [differentlyCasedDbPrefix],
        MAX_SCAN_DEPTH,
        undefined,
        platform
      )
    ).files.sort()

  it('excludes a path that differs from its prefix only in case under win32', async () => {
    expect(await walkedFiles('win32')).toEqual([documentFile])
    expect(await classifyRequestedPath(dbFile, [differentlyCasedDbPrefix], 'win32')).toBe(
      'excluded'
    )
  })

  it('keeps the comparison case-sensitive on a POSIX platform', async () => {
    expect(await walkedFiles('linux')).toEqual([dbFile, documentFile].sort())
    expect(await classifyRequestedPath(dbFile, [differentlyCasedDbPrefix], 'linux')).toBe('file')
  })

  // The prefixes carry a trailing separator, so `startsWith` matched the
  // directory's contents but never the directory itself.
  it('excludes the database directory itself, not only its contents', async () => {
    const ownPrefix = `${dbDir}${sep}`
    expect(await classifyRequestedPath(dbDir, [ownPrefix], 'linux')).toBe('excluded')
    expect(await classifyRequestedPath(dbDir, [ownPrefix], 'win32')).toBe('excluded')
    expect(await classifyRequestedPath(documentFile, [ownPrefix], 'linux')).toBe('file')
  })

  // A symlink inside the excluded directory is the observable proof: reaching it
  // means the walk read a directory it should have refused, and it would then
  // become an unobserved prefix protecting rows in a region that is out of scope.
  itWithSymlinks('does not descend into the excluded directory during a walk', async () => {
    symlinkSync(documentFile, join(dbDir, 'alias.md'), 'file')

    const result = await bfsCollectSupportedFiles(
      caseDir,
      [`${dbDir}${sep}`],
      MAX_SCAN_DEPTH,
      undefined,
      'linux'
    )

    expect(result.files).toEqual([documentFile])
    expect(result.skippedSymlinks).toEqual([])
  })
})
