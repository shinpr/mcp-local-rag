// Shared helpers for multipart file uploads

import { createHash } from 'node:crypto'
import { extname, isAbsolute, resolve } from 'node:path'
import type { MultipartFile } from '@fastify/multipart'

export const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md', 'html', 'json'])

export function getFileType(filename: string): string | null {
  const ext = extname(filename)
  const fileType = ext.startsWith('.') ? ext.slice(1).toLowerCase() : ext.toLowerCase()
  return SUPPORTED_EXTENSIONS.has(fileType) ? fileType : null
}

export function sanitizeFilename(filename: string): string {
  // Strip path components and control characters; keep the original name readable.
  const base = filename.split(/[/\\]/).pop() ?? 'upload'
  return base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 255) || 'upload'
}

export async function readMultipartFile(data: MultipartFile): Promise<{
  buffer: Buffer
  originalFilename: string
  fileType: string
  sha256Hash: string
}> {
  const originalFilename = sanitizeFilename(data.filename)
  const fileType = getFileType(originalFilename)
  if (!fileType) {
    throw new UploadValidationError(
      `Unsupported file type. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`
    )
  }

  const chunks: Buffer[] = []
  for await (const chunk of data.file) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  const sha256Hash = createHash('sha256').update(buffer).digest('hex')

  return { buffer, originalFilename, fileType, sha256Hash }
}

/**
 * Normalize a stored file path to an absolute path.
 * Relative paths in the DB are resolved via canonical upload layout or cwd.
 */
export function resolveStoredFilePath(
  filePath: string,
  uploadDir: string,
  fields?: { projectId: number; storedFilename: string }
): string {
  if (isAbsolute(filePath)) {
    return resolve(filePath)
  }

  if (fields) {
    return resolve(uploadDir, String(fields.projectId), fields.storedFilename)
  }

  return resolve(process.cwd(), filePath)
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadValidationError'
  }
}
