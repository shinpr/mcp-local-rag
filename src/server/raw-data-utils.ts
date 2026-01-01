// Raw Data Utilities for ingest_data tool
// Handles: base64url encoding, source normalization, file saving, source extraction

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

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

/**
 * Get file extension from content format
 *
 * All formats return .md for consistency.
 * This allows generating unique path from source without knowing original format,
 * which is essential for delete_file with source parameter.
 *
 * @param _format - Content format (ignored, always returns 'md')
 * @returns File extension (without dot) - always 'md'
 */
export function formatToExtension(_format: ContentFormat): string {
  return 'md'
}

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
export function generateRawDataPath(dbPath: string, source: string, format: ContentFormat): string {
  const normalizedSource = normalizeSource(source)
  const encoded = encodeBase64Url(normalizedSource)
  const extension = formatToExtension(format)
  // Use resolve to ensure absolute path (required by validateFilePath)
  return resolve(getRawDataDir(dbPath), `${encoded}.${extension}`)
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
  content: string,
  format: ContentFormat
): Promise<string> {
  const filePath = generateRawDataPath(dbPath, source, format)

  // Ensure directory exists
  await mkdir(dirname(filePath), { recursive: true })

  // Write content to file
  await writeFile(filePath, content, 'utf-8')

  return filePath
}

// ============================================
// Path Detection and Source Extraction
// ============================================

/**
 * Check if file path is in raw-data directory
 *
 * @param filePath - File path to check
 * @returns True if path is in raw-data directory
 */
export function isRawDataPath(filePath: string): boolean {
  return filePath.includes('/raw-data/')
}

/**
 * Extract original source from raw-data file path
 * Returns null if not a raw-data path
 *
 * @param filePath - Raw-data file path
 * @returns Original source or null
 */
export function extractSourceFromPath(filePath: string): string | null {
  const rawDataMarker = '/raw-data/'
  const rawDataIndex = filePath.indexOf(rawDataMarker)

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
