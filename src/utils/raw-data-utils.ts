// Raw Data Utilities for ingest_data tool
// Handles: base64url encoding, source normalization, file saving, source extraction

import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

// ============================================
// Base64URL Encoding/Decoding
// ============================================

/**
 * Encode string to URL-safe base64 (base64url)
 * - Replaces + with -
 * - Replaces / with _
 * - Removes padding (=)
 *
 * @param str - String to encode
 * @returns URL-safe base64 encoded string
 */
export function encodeBase64Url(str: string): string {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Decode URL-safe base64 (base64url) to string
 *
 * @param base64url - URL-safe base64 encoded string
 * @returns Decoded string
 */
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
 * Normalize source URL by removing query string and fragment
 * Only normalizes HTTP(S) URLs. Other sources (e.g., "clipboard://...") are returned as-is
 *
 * @param source - Source identifier (URL or custom ID)
 * @returns Normalized source
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

/**
 * Content format type for ingest_data
 */
export type ContentFormat = 'text' | 'html' | 'markdown'

const RAW_DATA_EXTENSION = 'md'

// ============================================
// Path Generation
// ============================================

/**
 * Get raw-data directory path
 *
 * @param dbPath - LanceDB database path
 * @returns Raw-data directory path
 */
export function getRawDataDir(dbPath: string): string {
  return join(dbPath, 'raw-data')
}

/**
 * Generate raw-data file path from source and format
 * Path format: {dbPath}/raw-data/{base64url(normalizedSource)}.{ext}
 *
 * @param dbPath - LanceDB database path
 * @param source - Source identifier (URL or custom ID)
 * @param format - Content format
 * @returns Generated file path
 */
export function generateRawDataPath(dbPath: string, source: string): string {
  const normalizedSource = normalizeSource(source)
  const encoded = encodeBase64Url(normalizedSource)
  // Use resolve to ensure absolute path (required by validateFilePath)
  return resolve(getRawDataDir(dbPath), `${encoded}.${RAW_DATA_EXTENSION}`)
}

// ============================================
// File Operations
// ============================================

/**
 * Save content to raw-data directory
 * Creates directory if it doesn't exist
 *
 * @param dbPath - LanceDB database path
 * @param source - Source identifier (URL or custom ID)
 * @param content - Content to save
 * @param format - Content format
 * @returns Saved file path
 */
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
  if (!isPathInRawDataDirLexical(filePath, dbPath)) return false
  try {
    const realTarget = caseNormalize(await realpath(resolve(filePath)))
    const realRaw = caseNormalize(await realpath(resolve(getRawDataDir(dbPath))))
    return realTarget === realRaw || realTarget.startsWith(realRaw + sep)
  } catch {
    return false
  }
}

/**
 * Extract original source from raw-data file path
 * Returns null if not a raw-data path
 *
 * @param filePath - Raw-data file path
 * @returns Original source or null
 */
export function extractSourceFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const rawDataMarker = '/raw-data/'
  const rawDataIndex = normalized.indexOf(rawDataMarker)

  if (rawDataIndex === -1) {
    return null
  }

  const fileName = filePath.slice(rawDataIndex + rawDataMarker.length)
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
export interface RawDataMeta {
  title: string | null
  source: string
  format: ContentFormat
}

/**
 * Generate the .meta.json sidecar path for a given .md file path
 * Replaces the trailing `.md` extension with `.meta.json`
 *
 * @param mdPath - Path to the .md raw-data file
 * @returns Path to the corresponding .meta.json file
 */
export function generateMetaJsonPath(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.meta.json')
}

/**
 * Save metadata as a JSON sidecar file alongside a raw-data .md file
 *
 * @param mdPath - Path to the .md raw-data file
 * @param meta - Metadata to persist
 */
export async function saveMetaJson(mdPath: string, meta: RawDataMeta): Promise<void> {
  const metaPath = generateMetaJsonPath(mdPath)
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

/**
 * Load metadata from a .meta.json sidecar file
 * Returns null when the sidecar file does not exist (ENOENT).
 * All other read errors are re-thrown (fail-fast).
 *
 * @param mdPath - Path to the .md raw-data file
 * @returns Parsed metadata or null if file does not exist
 */
export async function loadMetaJson(mdPath: string): Promise<RawDataMeta | null> {
  const metaPath = generateMetaJsonPath(mdPath)
  try {
    const content = await readFile(metaPath, 'utf-8')
    return JSON.parse(content) as RawDataMeta
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
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
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
 * Report which raw-data artifacts exist for a target path. Single source for
 * the delete `existed` signal so the MCP server and CLI delete paths cannot
 * drift. Call BEFORE unlinking — it reports pre-unlink state.
 *
 * @param targetPath - Raw-data .md file path
 */
export async function checkRawDataArtifacts(targetPath: string): Promise<RawDataArtifactExistence> {
  const rawDataExisted = await pathExists(targetPath)
  const metaExisted = await pathExists(generateMetaJsonPath(targetPath))
  return { rawDataExisted, metaExisted }
}
