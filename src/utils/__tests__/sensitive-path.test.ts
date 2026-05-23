// Sensitive-path policy unit tests
// Test Type: Unit Test

import { describe, expect, it } from 'vitest'

import { buildSensitivePrefixes } from '../sensitive-path.js'

describe('buildSensitivePrefixes', () => {
  it('keeps both the literal and the realpath-resolved form', () => {
    const fakeRealpath = (p: string) => (p === '/etc' ? '/private/etc' : p)
    const prefixes = buildSensitivePrefixes(fakeRealpath)
    expect(prefixes).toContain('/etc')
    expect(prefixes).toContain('/private/etc')
  })

  it('retains the literal when realpath throws (fail-closed)', () => {
    const failing = (_p: string) => {
      throw new Error('ENOENT')
    }
    const prefixes = buildSensitivePrefixes(failing)
    expect(prefixes).toContain('/etc')
    expect(prefixes).toContain('/var')
  })

  it('ignores realpath results that are empty or non-strings', () => {
    const empty = (_p: string) => ''
    const prefixes = buildSensitivePrefixes(empty)
    // Only the literals remain.
    for (const literal of ['/etc', '/usr', '/sys', '/proc', '/var']) {
      expect(prefixes).toContain(literal)
    }
    expect(prefixes.some((p) => p === '')).toBe(false)
  })

  it('deduplicates when realpath returns the literal itself', () => {
    const identity = (p: string) => p
    const prefixes = buildSensitivePrefixes(identity)
    const counts = new Map<string, number>()
    for (const p of prefixes) counts.set(p, (counts.get(p) ?? 0) + 1)
    for (const [, n] of counts) expect(n).toBe(1)
  })
})
