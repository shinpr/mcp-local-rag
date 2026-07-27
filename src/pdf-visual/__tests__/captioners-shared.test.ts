// Both captioner profiles route decoded output through `postProcess`, so its
// rules are pinned here once instead of through each profile's mock stack.

import { describe, expect, it } from 'vitest'
import { postProcess } from '../captioners/shared.js'

// Built from code points rather than written as escapes: a literal control
// character in a fixture is invisible in review, which is how an earlier version
// of this coverage came to assert on a plain space.
const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('')

const C0_LOW = chars(0x00, 0x01, 0x08)
const C0_ABOVE_LF = chars(0x0b, 0x0c, 0x1f)
const DEL_AND_C1 = chars(0x7f, 0x80, 0x9f)
const NBSP = chars(0xa0)
const TAB = chars(0x09)
const LF = chars(0x0a)

describe('postProcess — control character stripping', () => {
  it('strips the low C0 range (0x00-0x08)', () => {
    expect(postProcess(`a${C0_LOW}b`)).toBe('ab')
  })

  it('strips the C0 range above LF (0x0b-0x1f)', () => {
    expect(postProcess(`a${C0_ABOVE_LF}b`)).toBe('ab')
  })

  it('strips DEL and the C1 range (0x7f-0x9f)', () => {
    expect(postProcess(`a${DEL_AND_C1}b`)).toBe('ab')
  })

  it('keeps tab and newline verbatim', () => {
    expect(postProcess(`one${LF}two${TAB}three`)).toBe(`one${LF}two${TAB}three`)
  })

  it('keeps U+00A0, the code point immediately past the C1 range', () => {
    // Boundary pair with the C1 case: 0x9f is stripped, 0xa0 is content. Placed
    // mid-string so `trim()` cannot remove it.
    expect(postProcess(`a${NBSP}b`)).toBe(`a${NBSP}b`)
  })

  it('returns null for control characters only', () => {
    expect(postProcess(`${C0_LOW}${C0_ABOVE_LF}${DEL_AND_C1}`)).toBeNull()
  })

  it('trims the whitespace that stripping exposes at the edges', () => {
    expect(postProcess(`${C0_LOW}  hello ${C0_LOW}`)).toBe('hello')
  })
})

describe('postProcess — emptiness', () => {
  it('returns null for the empty string', () => {
    expect(postProcess('')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(postProcess(`  ${TAB}${LF} `)).toBeNull()
  })
})

describe('postProcess — length cap', () => {
  it('returns a 1000-character caption unchanged', () => {
    const text = 'a'.repeat(1000)

    expect(postProcess(text)).toBe(text)
  })

  it('truncates a 1001-character caption to 1000 characters plus an ellipsis', () => {
    const result = postProcess('b'.repeat(1001))

    expect(result).toBe(`${'b'.repeat(1000)}…`)
    expect(result).toHaveLength(1001)
  })

  it('measures length after stripping, so control characters never trigger truncation', () => {
    const text = `${'c'.repeat(1000)}${chars(0x00).repeat(500)}`

    expect(postProcess(text)).toBe('c'.repeat(1000))
  })
})
