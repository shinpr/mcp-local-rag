// SHA-256 file hashing for duplicate detection.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * Compute SHA-256 hex digest of a file on disk.
 * Reads the entire file into memory — suitable for documents up to the
 * configured max file size (100MB default).
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Compute SHA-256 hex digest of an in-memory buffer or string.
 */
export function computeContentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}
