// Encrypt API keys at rest using a key derived from JWT_SECRET

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const SALT = 'mcp-local-rag-settings-v1'

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32)
}

export function encryptApiKey(plaintext: string, secret: string): string {
  const key = deriveKey(secret)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptApiKey(ciphertext: string, secret: string): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split(':')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted API key format')
  }
  const key = deriveKey(secret)
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••••••'
  return `${apiKey.slice(0, 4)}${'•'.repeat(Math.min(12, apiKey.length - 8))}${apiKey.slice(-4)}`
}
