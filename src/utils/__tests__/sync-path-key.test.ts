// Sync comparison-key generation unit tests
// Test Type: Unit Test
//
// Containment cases are asserted through the real, unchanged `isUnderOrEqual`
// so the composed contract (`isUnderOrEqual(toSyncPathKey(candidate),
// toSyncPathKey(prefix))`) is what gets proven, not a second matcher.

import { describe, expect, it } from 'vitest'
import { isUnderOrEqual } from '../scope-match.js'
import { toSyncPathKey } from '../sync-path-key.js'

describe('toSyncPathKey', () => {
  it('should preserve case on POSIX so paths differing only in case get distinct keys', () => {
    expect(toSyncPathKey('/a/B.md', 'linux')).toBe('/a/B.md')
    expect(toSyncPathKey('/a/b.md', 'linux')).toBe('/a/b.md')
  })

  it('should case-fold on Windows so paths differing only in case share one key', () => {
    expect(toSyncPathKey('C:\\A\\B.MD', 'win32')).toBe('c:\\a\\b.md')
    expect(toSyncPathKey('c:\\a\\b.md', 'win32')).toBe('c:\\a\\b.md')
  })

  it('should normalize redundant segments and trailing separators on POSIX', () => {
    expect(toSyncPathKey('/a/b/./c/../c.md', 'linux')).toBe('/a/b/c.md')
    expect(toSyncPathKey('/a/b//', 'linux')).toBe('/a/b')
  })

  it('should normalize redundant segments and trailing separators on Windows', () => {
    expect(toSyncPathKey('C:\\A\\B\\.\\C\\..\\C.MD', 'win32')).toBe('c:\\a\\b\\c.md')
    expect(toSyncPathKey('C:\\A\\B\\\\', 'win32')).toBe('c:\\a\\b')
  })

  it('should return a key for a path that does not exist on disk without throwing', () => {
    expect(toSyncPathKey('/no/such/dir/ghost.md', 'linux')).toBe('/no/such/dir/ghost.md')
    expect(toSyncPathKey('Z:\\No\\Such\\Ghost.md', 'win32')).toBe('z:\\no\\such\\ghost.md')
  })

  it('should default the platform to process.platform', () => {
    expect(toSyncPathKey('/a/B.md')).toBe(toSyncPathKey('/a/B.md', process.platform))
  })
})

describe('toSyncPathKey composed with isUnderOrEqual', () => {
  it('should treat a Windows case-differing descendant as in scope', () => {
    expect(
      isUnderOrEqual(
        toSyncPathKey('C:\\Root\\Sub\\f.md', 'win32'),
        toSyncPathKey('c:\\root\\sub', 'win32')
      )
    ).toBe(true)
  })

  it('should treat a POSIX case-differing descendant as out of scope', () => {
    expect(
      isUnderOrEqual(toSyncPathKey('/Root/Sub/f.md', 'linux'), toSyncPathKey('/root/sub', 'linux'))
    ).toBe(false)
  })

  it('should reject a sibling prefix on POSIX', () => {
    expect(
      isUnderOrEqual(toSyncPathKey('/a/foo', 'linux'), toSyncPathKey('/a/foobar', 'linux'))
    ).toBe(false)
    expect(
      isUnderOrEqual(
        toSyncPathKey('/root/barista/f.md', 'linux'),
        toSyncPathKey('/root/bar', 'linux')
      )
    ).toBe(false)
  })

  it('should reject a sibling prefix on Windows despite case folding', () => {
    expect(
      isUnderOrEqual(
        toSyncPathKey('C:\\Root\\Barista\\f.md', 'win32'),
        toSyncPathKey('c:\\root\\bar', 'win32')
      )
    ).toBe(false)
  })

  it('should give the same POSIX answer for zero, one, and two trailing separators', () => {
    const file = toSyncPathKey('/root/sub/f.md', 'linux')
    expect(isUnderOrEqual(file, toSyncPathKey('/root/sub', 'linux'))).toBe(true)
    expect(isUnderOrEqual(file, toSyncPathKey('/root/sub/', 'linux'))).toBe(true)
    expect(isUnderOrEqual(file, toSyncPathKey('/root/sub//', 'linux'))).toBe(true)

    const sibling = toSyncPathKey('/root/subx/f.md', 'linux')
    expect(isUnderOrEqual(sibling, toSyncPathKey('/root/sub', 'linux'))).toBe(false)
    expect(isUnderOrEqual(sibling, toSyncPathKey('/root/sub/', 'linux'))).toBe(false)
    expect(isUnderOrEqual(sibling, toSyncPathKey('/root/sub//', 'linux'))).toBe(false)
  })

  it('should give the same Windows answer for zero, one, and two trailing separators', () => {
    const file = toSyncPathKey('C:\\Root\\Sub\\f.md', 'win32')
    expect(isUnderOrEqual(file, toSyncPathKey('c:\\root\\sub', 'win32'))).toBe(true)
    expect(isUnderOrEqual(file, toSyncPathKey('c:\\root\\sub\\', 'win32'))).toBe(true)
    expect(isUnderOrEqual(file, toSyncPathKey('c:\\root\\sub\\\\', 'win32'))).toBe(true)

    const sibling = toSyncPathKey('C:\\Root\\Subx\\f.md', 'win32')
    expect(isUnderOrEqual(sibling, toSyncPathKey('c:\\root\\sub', 'win32'))).toBe(false)
    expect(isUnderOrEqual(sibling, toSyncPathKey('c:\\root\\sub\\', 'win32'))).toBe(false)
    expect(isUnderOrEqual(sibling, toSyncPathKey('c:\\root\\sub\\\\', 'win32'))).toBe(false)
  })

  it('should treat a single-file scope as matching only itself', () => {
    const target = toSyncPathKey('/root/sub/f.md', 'linux')
    expect(isUnderOrEqual(target, target)).toBe(true)
    expect(isUnderOrEqual(toSyncPathKey('/root/sub/g.md', 'linux'), target)).toBe(false)
  })

  it('should treat a Windows single-file scope as matching only its case-folded self', () => {
    const target = toSyncPathKey('c:\\root\\sub\\f.md', 'win32')
    expect(isUnderOrEqual(toSyncPathKey('C:\\Root\\Sub\\F.MD', 'win32'), target)).toBe(true)
    expect(isUnderOrEqual(toSyncPathKey('C:\\Root\\Sub\\g.md', 'win32'), target)).toBe(false)
  })
})
