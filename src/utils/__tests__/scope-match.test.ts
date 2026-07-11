// Scope-match helper unit tests
// Test Type: Unit Test

import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUnderOrEqual, matchesAnyScope, nonAbsolutePrefixes } from '../scope-match.js'

describe('isUnderOrEqual', () => {
  it('should return true when path equals the prefix (exact match)', () => {
    expect(isUnderOrEqual('/foo/bar', '/foo/bar')).toBe(true)
  })

  it('should return true when path is a descendant of the prefix', () => {
    expect(isUnderOrEqual('/foo/bar/baz.md', '/foo/bar')).toBe(true)
  })

  it('should return false when path shares only a name-prefix (boundary reject)', () => {
    expect(isUnderOrEqual('/foo/barista', '/foo/bar')).toBe(false)
  })

  it('should return true for an exact file-level scope', () => {
    expect(isUnderOrEqual('/foo/bar.md', '/foo/bar.md')).toBe(true)
  })

  describe('trailing-separator equivalence', () => {
    it('should treat /a/b, /a/b/ and /a/b// identically for a descendant path', () => {
      const path = '/a/b/c.md'
      expect(isUnderOrEqual(path, '/a/b')).toBe(true)
      expect(isUnderOrEqual(path, '/a/b/')).toBe(true)
      expect(isUnderOrEqual(path, '/a/b//')).toBe(true)
    })

    it('should treat /a/b, /a/b/ and /a/b// identically for the exact path', () => {
      const path = '/a/b'
      expect(isUnderOrEqual(path, '/a/b')).toBe(true)
      expect(isUnderOrEqual(path, '/a/b/')).toBe(true)
      expect(isUnderOrEqual(path, '/a/b//')).toBe(true)
    })

    it('should treat /a/b, /a/b/ and /a/b// identically for an out-of-scope path', () => {
      const path = '/a/bc'
      expect(isUnderOrEqual(path, '/a/b')).toBe(false)
      expect(isUnderOrEqual(path, '/a/b/')).toBe(false)
      expect(isUnderOrEqual(path, '/a/b//')).toBe(false)
    })
  })

  it('should keep a lone posix root prefix matching any absolute path', () => {
    expect(isUnderOrEqual('/anything/here.md', '/')).toBe(true)
    expect(isUnderOrEqual('/', '/')).toBe(true)
  })

  it('treats a backslash inside a slash-style POSIX name as a normal character', () => {
    expect(isUnderOrEqual('/docs/a\\b/file.md', '/docs/a\\b')).toBe(true)
    expect(isUnderOrEqual('/docs/a\\bc/file.md', '/docs/a\\b')).toBe(false)
  })

  describe('cross-platform (backslash-style prefix)', () => {
    it('should match a descendant under a backslash prefix', () => {
      expect(isUnderOrEqual('C:\\a\\b\\x.md', 'C:\\a\\b')).toBe(true)
    })

    it('should match the exact backslash path', () => {
      expect(isUnderOrEqual('C:\\a\\b', 'C:\\a\\b')).toBe(true)
    })

    it('should reject a name-prefix under a backslash prefix', () => {
      expect(isUnderOrEqual('C:\\a\\bc', 'C:\\a\\b')).toBe(false)
    })

    it('should honor trailing-separator equivalence for backslash prefixes', () => {
      const path = 'C:\\a\\b\\x.md'
      expect(isUnderOrEqual(path, 'C:\\a\\b')).toBe(true)
      expect(isUnderOrEqual(path, 'C:\\a\\b\\')).toBe(true)
      expect(isUnderOrEqual(path, 'C:\\a\\b\\\\')).toBe(true)
    })
  })
})

describe('matchesAnyScope', () => {
  it('should return true when any prefix matches (union)', () => {
    expect(matchesAnyScope('/foo/bar/x.md', ['/other', '/foo/bar'])).toBe(true)
  })

  it('should return false when no prefix matches', () => {
    expect(matchesAnyScope('/foo/barista', ['/foo/bar', '/other'])).toBe(false)
  })

  it('should return false for an empty prefix list', () => {
    expect(matchesAnyScope('/foo/bar', [])).toBe(false)
  })

  it('should match on the exact prefix within the union', () => {
    expect(matchesAnyScope('/foo/bar', ['/a', '/foo/bar', '/b'])).toBe(true)
  })
})

describe('nonAbsolutePrefixes', () => {
  // '/foo/bar' etc. are absolute under both posix and win32 isAbsolute (a
  // leading separator is absolute on both), so these cases are OS-stable.
  it('should return an empty array when every prefix is absolute', () => {
    expect(nonAbsolutePrefixes(['/foo/bar', '/docs/api'])).toEqual([])
  })

  it('should return every non-absolute prefix, preserving input order', () => {
    expect(nonAbsolutePrefixes(['docs/api', './rel', '../up'])).toEqual([
      'docs/api',
      './rel',
      '../up',
    ])
  })

  it('should return only the non-absolute prefixes from a mixed list', () => {
    expect(nonAbsolutePrefixes(['/abs/one', 'relative', '/abs/two'])).toEqual(['relative'])
  })

  it('should return an empty array for an empty scope', () => {
    expect(nonAbsolutePrefixes([])).toEqual([])
  })

  it('should classify prefixes exactly as node:path isAbsolute (server-OS style)', () => {
    const prefixes = ['/abs', 'rel', 'a/b/c']
    expect(nonAbsolutePrefixes(prefixes)).toEqual(prefixes.filter((p) => !isAbsolute(p)))
  })
})
