import { describe, expect, it } from 'vitest'
import { decryptApiKey, encryptApiKey, maskApiKey } from '../embedding/settings-crypto.js'

describe('settings-crypto', () => {
  it('round-trips API key encryption', () => {
    const secret = 'test-jwt-secret'
    const plaintext = 'sk-test-key-12345'
    const encrypted = encryptApiKey(plaintext, secret)
    expect(encrypted).not.toContain(plaintext)
    expect(decryptApiKey(encrypted, secret)).toBe(plaintext)
  })

  it('masks API keys for display', () => {
    expect(maskApiKey('sk-abcdefghijklmnop')).toMatch(/^sk-a/)
    expect(maskApiKey('short')).toBe('••••••••')
  })
})
