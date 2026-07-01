// Shared helpers for multipart file uploads

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import type { MultipartFile } from '@fastify/multipart'
import { withTrailingSeparator } from '../utils/base-dirs.js'
import type { VectorStore } from '../vectordb/index.js'

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

export interface StoredFileFields {
  projectId: number
  storedFilename: string
}

function isUnderDir(candidate: string, dir: string): boolean {
  const resolvedDir = withTrailingSeparator(resolve(dir))
  return resolve(candidate).startsWith(resolvedDir)
}

/**
 * Canonical on-disk path for an uploaded file row (project subdir layout).
 */
export function canonicalStoredFilePath(uploadDir: string, fields: StoredFileFields): string {
  return resolve(uploadDir, String(fields.projectId), fields.storedFilename)
}

/**
 * Legacy flat layout: uploads stored directly under UPLOAD_DIR without a project subfolder.
 */
export function legacyFlatStoredFilePath(uploadDir: string, storedFilename: string): string {
  return resolve(uploadDir, storedFilename)
}

function storedFilePathCandidates(
  filePath: string,
  uploadDir: string,
  fields: StoredFileFields
): string[] {
  const resolvedUploadDir = resolve(uploadDir)
  const candidates: string[] = []

  if (isAbsolute(filePath)) {
    candidates.push(resolve(filePath))
  } else if (filePath.trim().length > 0) {
    candidates.push(resolve(process.cwd(), filePath))
  }

  candidates.push(canonicalStoredFilePath(resolvedUploadDir, fields))
  candidates.push(legacyFlatStoredFilePath(resolvedUploadDir, fields.storedFilename))

  return [...new Set(candidates)]
}

/**
 * Normalize a stored file path to an absolute path on this machine.
 *
 * When `fields` are provided, paths from another host/container (e.g.
 * `/app/lancedb/uploads/...` in Postgres while this API uses `./lancedb/uploads`)
 * are remapped to the canonical layout under the current `uploadDir`.
 */
export function resolveStoredFilePath(
  filePath: string,
  uploadDir: string,
  fields?: StoredFileFields
): string {
  const resolvedUploadDir = resolve(uploadDir)

  if (fields) {
    for (const candidate of storedFilePathCandidates(filePath, uploadDir, fields)) {
      if (isUnderDir(candidate, resolvedUploadDir) && existsSync(candidate)) {
        return candidate
      }
    }

    return canonicalStoredFilePath(resolvedUploadDir, fields)
  }

  if (isAbsolute(filePath)) {
    return resolve(filePath)
  }

  return resolve(process.cwd(), filePath)
}

/**
 * All file paths that may have been used when indexing vectors for a row.
 * Needed when Postgres/LanceDB still reference a path from another machine.
 */
export function listStoredFilePathCandidates(
  filePath: string,
  uploadDir: string,
  fields: StoredFileFields
): string[] {
  return storedFilePathCandidates(filePath, uploadDir, fields)
}

/**
 * Best-effort vector cleanup for a stored file, trying every known path variant.
 */
export async function deleteStoredFileChunks(
  vectorStore: VectorStore,
  filePath: string,
  uploadDir: string,
  fields: StoredFileFields,
  projectName: string
): Promise<void> {
  for (const candidate of listStoredFilePathCandidates(filePath, uploadDir, fields)) {
    try {
      await vectorStore.deleteChunks(candidate, projectName)
    } catch {
      // Vector cleanup is best-effort across stale path variants
    }
  }
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadValidationError'
  }
}
