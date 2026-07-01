import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_NAME, normalizeProjectName } from '../project-name.js'

describe('normalizeProjectName', () => {
  it('returns default for undefined', () => {
    expect(normalizeProjectName(undefined)).toBe(DEFAULT_PROJECT_NAME)
  })

  it('returns default for empty string', () => {
    expect(normalizeProjectName('')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('returns default for whitespace-only', () => {
    expect(normalizeProjectName('   ')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('trims whitespace', () => {
    expect(normalizeProjectName('  SEG  ')).toBe('SEG')
  })

  it('accepts valid project names', () => {
    expect(normalizeProjectName('SEG')).toBe('SEG')
    expect(normalizeProjectName('MVA')).toBe('MVA')
    expect(normalizeProjectName('SLVBankRecon')).toBe('SLVBankRecon')
    expect(normalizeProjectName('ChronoLMS')).toBe('ChronoLMS')
    expect(normalizeProjectName('my-project')).toBe('my-project')
    expect(normalizeProjectName('project_1')).toBe('project_1')
    expect(normalizeProjectName('A')).toBe('A')
  })

  it('rejects names starting with a digit', () => {
    expect(() => normalizeProjectName('123abc')).toThrow('Invalid project name')
  })

  it('rejects names with spaces', () => {
    expect(() => normalizeProjectName('my project')).toThrow('Invalid project name')
  })

  it('rejects names with special characters', () => {
    expect(() => normalizeProjectName('my@project')).toThrow('Invalid project name')
  })

  it('rejects empty after trim', () => {
    // This actually returns default, doesn't throw
    expect(normalizeProjectName('   ')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('uses custom default', () => {
    expect(normalizeProjectName(undefined, 'CUSTOM')).toBe('CUSTOM')
  })

  it('rejects names longer than 64 chars', () => {
    const longName = `A${'b'.repeat(64)}`
    expect(() => normalizeProjectName(longName)).toThrow('Invalid project name')
  })
})
