// Raw Data Utilities for ingest_data tool
// Handles: base64url encoding, source normalization, file saving, source extraction

import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'

import { errorCode, isRecord } from './type-guards.js'

// ============================================
// Base64URL Encoding/Decoding
// ============================================

/** Encode to URL-safe base64, so a source can be used as a filename. */
export function encodeBase64Url(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Decode URL-safe base64 (base64url). */
export function decodeBase64Url(base64url: string): string {
  // Convert base64url to standard base64
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')

  // Add padding if needed
  while (base64.length % 4 !== 0) {
    base64 += '='
  }

  return Buffer.from(base64, 'base64').toString('utf-8')
}

// ============================================
// Source Normalization
// ============================================

/**
 * Drop the query string and fragment from an HTTP(S) source, so the same page
 * maps to one path. A non-URL source (`clipboard://...`) passes through.
 */
export function normalizeSource(source: string): string {
  try {
    const parsed = new URL(source)
    // Only normalize HTTP(S) URLs
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}${parsed.pathname}`
    }
    // Non-HTTP URLs (clipboard://, etc.) are returned as-is
    return source
  } catch {
    // Not a valid URL, return as-is
    return source
  }
}

// ============================================
// Format Utilities
// ============================================

/** Formats accepted by ingest_data at runtime and in its public schema. */
export const CONTENT_FORMATS = ['text', 'html', 'markdown'] as const
export type ContentFormat = (typeof CONTENT_FORMATS)[number]

const RAW_DATA_EXTENSION = 'md'

// ============================================
// Path Generation
// ============================================

/** Raw-data directory for a given LanceDB path. */
export function getRawDataDir(dbPath: string): string {
  return join(dbPath, 'raw-data')
}

/** `{dbPath}/raw-data/{base64url(normalizedSource)}.{ext}` */
export function generateRawDataPath(dbPath: string, source: string): string {
  const normalizedSource = normalizeSource(source)
  const encoded = encodeBase64Url(normalizedSource)
  // Use resolve to ensure absolute path (required by validateFilePath)
  return resolve(getRawDataDir(dbPath), `${encoded}.${RAW_DATA_EXTENSION}`)
}

// ============================================
// File Operations
// ============================================

/** Save content under raw-data, creating the directory if needed. */
export async function saveRawData(
  dbPath: string,
  source: string,
  content: string
): Promise<string> {
  const filePath = generateRawDataPath(dbPath, source)

  // Ensure directory exists
  await mkdir(dirname(filePath), { recursive: true })

  // Write content to file
  await writeFile(filePath, content, 'utf-8')

  return filePath
}

// ============================================
// Path Detection and Source Extraction
// ============================================

/** True only for managed raw-data content files under this database. */
export function isManagedRawDataPath(filePath: string, dbPath: string): boolean {
  return (
    isPathInRawDataDirLexical(filePath, dbPath) && /^[A-Za-z0-9_-]+\.md$/.test(basename(filePath))
  )
}

/**
 * Case-normalize a path for prefix containment. Windows filesystems are
 * case-insensitive by default, so the boundary check must mirror that.
 */
function caseNormalize(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * Lexical containment in `<dbPath>/raw-data/`. Safe for cleanup gates
 * (`unlink` does not follow symlinks). Use {@link isPathInRawDataDir}
 * when the result controls `readFile`.
 */
export function isPathInRawDataDirLexical(filePath: string, dbPath: string): boolean {
  const target = caseNormalize(resolve(filePath))
  const rawDir = caseNormalize(resolve(getRawDataDir(dbPath)))
  return target === rawDir || target.startsWith(rawDir + sep)
}

/**
 * Lexical containment plus `realpath` so a symlink under raw-data
 * pointing outside cannot route a read through the raw-data fast-path.
 * Fail-closed on `realpath` errors.
 */
export async function isPathInRawDataDir(filePath: string, dbPath: string): Promise<boolean> {
  if (!isPathInRawDataDirLexical(filePath, dbPath)) {
    return false
  }
  try {
    const realTarget = caseNormalize(await realpath(resolve(filePath)))
    const realRaw = caseNormalize(await realpath(resolve(getRawDataDir(dbPath))))
    return realTarget === realRaw || realTarget.startsWith(realRaw + sep)
  } catch {
    return false
  }
}

/** Original source of a raw-data path, or `null` when it is not one. */
export function extractSourceFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const rawDataMarker = '/raw-data/'
  const rawDataIndex = normalized.indexOf(rawDataMarker)

  if (rawDataIndex === -1) {
    return null
  }

  const fileName = posix.basename(normalized)
  const dotIndex = fileName.lastIndexOf('.')

  if (dotIndex === -1) {
    return null
  }

  const encoded = fileName.slice(0, dotIndex)
  return decodeBase64Url(encoded)
}

// ============================================
// Meta JSON Sidecar Files
// ============================================

/**
 * Metadata stored alongside each raw-data .md file as a .meta.json sidecar
 */
/** What {@link saveMetaJson} writes. */
export interface RawDataMeta {
  title: string | null
  source: string
  format: ContentFormat
}

/**
 * What re-ingest reads back. Only `title` is consumed, so a sidecar missing
 * `source` or `format` still yields a usable title rather than failing an
 * otherwise valid ingest.
 */
export interface RawDataMetaRead {
  title: string | null
}

/**
 * Read one persisted sidecar. The file is plain JSON on disk, so a malformed or
 * hand-edited value is a real possibility and each field is checked rather than
 * assumed.
 */
function toRawDataMetaRead(parsed: unknown): RawDataMetaRead {
  const title = isRecord(parsed) ? parsed['title'] : undefined
  return { title: typeof title === 'string' ? title : null }
}

/** Replaces the trailing `.md` with `.meta.json`. */
export function generateMetaJsonPath(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.meta.json')
}

/** Save metadata as a JSON sidecar beside a raw-data .md file. */
export async function saveMetaJson(mdPath: string, meta: RawDataMeta): Promise<void> {
  const metaPath = generateMetaJsonPath(mdPath)
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

/** `null` when the sidecar does not exist; any other read error is re-thrown. */
export async function loadMetaJson(mdPath: string): Promise<RawDataMetaRead | null> {
  const metaPath = generateMetaJsonPath(mdPath)
  try {
    const content = await readFile(metaPath, 'utf-8')
    return toRawDataMetaRead(JSON.parse(content))
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null
    }
    throw error
  }
}

/**
 * True when a filesystem error means the target path does not exist.
 */
export function isEnoent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

// ============================================
// Raw-Data Artifact Existence
// ============================================

/**
 * Whether a path exists. access()-based, never throws.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Pre-unlink existence of the on-disk raw-data artifacts for a target .md
 * path: the raw-data file itself and its .meta.json sidecar.
 */
export interface RawDataArtifactExistence {
  rawDataExisted: boolean
  metaExisted: boolean
}

/**
 * Report which raw-data artifacts exist. Single source for the delete
 * `existed` signal, so the MCP and CLI paths cannot drift. Call BEFORE
 * unlinking — it reports pre-unlink state.
 */
export async function checkRawDataArtifacts(targetPath: string): Promise<RawDataArtifactExistence> {
  const rawDataExisted = await pathExists(targetPath)
  const metaExisted = await pathExists(generateMetaJsonPath(targetPath))
  return { rawDataExisted, metaExisted }
}
