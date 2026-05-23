// Raw Data Utilities Test
// Test Type: Unit Test

import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  decodeBase64Url,
  encodeBase64Url,
  extractSourceFromPath,
  formatToExtension,
  generateRawDataPath,
  getRawDataDir,
  isPathInRawDataDir,
  looksLikeRawDataPath,
  normalizeSource,
  saveRawData,
} from '../../utils/raw-data-utils.js'

// ============================================
// Test Configuration
// ============================================

const testDbPath = './tmp/test-raw-data-db'

// ============================================
// Tests
// ============================================

describe('Raw Data Utilities', () => {
  beforeAll(async () => {
    await mkdir(testDbPath, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDbPath, { recursive: true, force: true })
  })

  // --------------------------------------------
  // Base64URL Encoding/Decoding
  // --------------------------------------------
  describe('Base64URL Encoding/Decoding', () => {
    it('encodeBase64Url encodes string to URL-safe base64', () => {
      const input = 'https://example.com/page'
      const encoded = encodeBase64Url(input)

      // URL-safe: no +, /, or = characters
      expect(encoded).not.toContain('+')
      expect(encoded).not.toContain('/')
      expect(encoded).not.toContain('=')
    })

    it('decodeBase64Url decodes URL-safe base64 back to original string', () => {
      const original = 'https://example.com/page'
      const encoded = encodeBase64Url(original)
      const decoded = decodeBase64Url(encoded)

      expect(decoded).toBe(original)
    })

    it('handles special characters in URLs', () => {
      const urls = [
        'https://example.com/path?query=value&foo=bar',
        'https://example.com/path#section',
        'https://example.com/path/with/日本語',
        'clipboard://2024-12-30',
      ]

      for (const url of urls) {
        const encoded = encodeBase64Url(url)
        const decoded = decodeBase64Url(encoded)
        expect(decoded).toBe(url)
      }
    })
  })

  // --------------------------------------------
  // Source Normalization
  // --------------------------------------------
  describe('Source Normalization', () => {
    it('removes query string from URL', () => {
      const source = 'https://example.com/page?utm_source=google&id=123'
      const normalized = normalizeSource(source)

      expect(normalized).toBe('https://example.com/page')
    })

    it('removes fragment from URL', () => {
      const source = 'https://example.com/page#section'
      const normalized = normalizeSource(source)

      expect(normalized).toBe('https://example.com/page')
    })

    it('removes both query string and fragment', () => {
      const source = 'https://example.com/page?query=value#section'
      const normalized = normalizeSource(source)

      expect(normalized).toBe('https://example.com/page')
    })

    it('returns non-URL sources unchanged', () => {
      const sources = ['clipboard://2024-12-30', 'manual-input', 'some-custom-id']

      for (const source of sources) {
        const normalized = normalizeSource(source)
        expect(normalized).toBe(source)
      }
    })

    it('preserves path for valid URLs', () => {
      const source = 'https://example.com/docs/api/v1/users'
      const normalized = normalizeSource(source)

      expect(normalized).toBe('https://example.com/docs/api/v1/users')
    })
  })

  // --------------------------------------------
  // Format to Extension
  // --------------------------------------------
  describe('Format to Extension', () => {
    it('returns .md for all formats (unified extension)', () => {
      // All formats now return .md for consistency
      // This allows generating unique path from source without knowing original format
      expect(formatToExtension('html')).toBe('md')
      expect(formatToExtension('markdown')).toBe('md')
      expect(formatToExtension('text')).toBe('md')
    })
  })

  // --------------------------------------------
  // Raw Data Directory
  // --------------------------------------------
  describe('Raw Data Directory', () => {
    it('returns correct raw-data directory path', () => {
      const dbPath = '/path/to/lancedb'
      const rawDataDir = getRawDataDir(dbPath)

      expect(rawDataDir).toBe(join('/path/to/lancedb', 'raw-data'))
    })
  })

  // --------------------------------------------
  // Generate Raw Data Path
  // --------------------------------------------
  describe('Generate Raw Data Path', () => {
    it('generates correct path with base64url encoded filename', () => {
      const dbPath = '/path/to/lancedb'
      const source = 'https://example.com/page'
      const format = 'html' as const

      const path = generateRawDataPath(dbPath, source, format)

      expect(path).toContain(`raw-data${sep}`)
      expect(path).toMatch(/\.md$/) // All formats use .md extension
      // Should not contain original URL characters
      expect(path).not.toContain('https:')
      expect(path).not.toContain('example.com')
    })

    it('normalizes source before encoding', () => {
      const dbPath = '/path/to/lancedb'
      const source1 = 'https://example.com/page?query=value'
      const source2 = 'https://example.com/page#section'
      const source3 = 'https://example.com/page'

      const path1 = generateRawDataPath(dbPath, source1, 'html')
      const path2 = generateRawDataPath(dbPath, source2, 'html')
      const path3 = generateRawDataPath(dbPath, source3, 'html')

      // All should generate the same path (normalized source is the same)
      expect(path1).toBe(path2)
      expect(path2).toBe(path3)
    })
  })

  // --------------------------------------------
  // Save Raw Data
  // --------------------------------------------
  describe('Save Raw Data', () => {
    it('saves content to raw-data directory and returns file path', async () => {
      const source = 'https://example.com/test-page'
      const content = '<html><body>Test content</body></html>'
      const format = 'html' as const

      const savedPath = await saveRawData(testDbPath, source, content, format)

      // Verify file was saved
      const savedContent = await readFile(savedPath, 'utf-8')
      expect(savedContent).toBe(content)

      // Verify path structure
      expect(savedPath).toContain('raw-data')
      expect(savedPath).toMatch(/\.md$/) // All formats use .md extension
    })

    it('creates raw-data directory if not exists', async () => {
      const newDbPath = './tmp/test-raw-data-new'
      await rm(newDbPath, { recursive: true, force: true })

      const source = 'https://example.com/new-page'
      const content = 'Test content'
      const format = 'text' as const

      const savedPath = await saveRawData(newDbPath, source, content, format)

      // Verify file was saved
      const savedContent = await readFile(savedPath, 'utf-8')
      expect(savedContent).toBe(content)

      // Cleanup
      await rm(newDbPath, { recursive: true, force: true })
    })

    it('overwrites existing file with same source', async () => {
      const source = 'https://example.com/overwrite-test'
      const format = 'text' as const

      // Save initial content
      await saveRawData(testDbPath, source, 'Original content', format)

      // Save updated content
      const savedPath = await saveRawData(testDbPath, source, 'Updated content', format)

      // Verify content was updated
      const savedContent = await readFile(savedPath, 'utf-8')
      expect(savedContent).toBe('Updated content')
    })
  })

  // --------------------------------------------
  // Path Detection
  // --------------------------------------------
  describe('Path Detection (display heuristic)', () => {
    it('looksLikeRawDataPath returns true for raw-data paths', () => {
      expect(looksLikeRawDataPath('/path/to/lancedb/raw-data/abc123.html')).toBe(true)
      expect(looksLikeRawDataPath('./lancedb/raw-data/xyz.txt')).toBe(true)
    })

    it('looksLikeRawDataPath returns false for non-raw-data paths', () => {
      expect(looksLikeRawDataPath('/path/to/documents/file.pdf')).toBe(false)
      expect(looksLikeRawDataPath('/home/user/raw-data-backup/file.txt')).toBe(false)
    })
  })

  // --------------------------------------------
  // Boundary Containment (security)
  // --------------------------------------------
  describe('isPathInRawDataDir (security boundary)', () => {
    const boundaryDbPath = resolve('./tmp/test-raw-data-db-boundary')
    const boundaryRawDir = `${boundaryDbPath}${sep}raw-data`
    const outsideFile = resolve('./tmp/test-raw-data-db-boundary-outside.txt')
    const symlinkEscape = `${boundaryRawDir}${sep}escape.md`
    const realFile = `${boundaryRawDir}${sep}real.md`
    const nestedFile = `${boundaryRawDir}${sep}sub${sep}deep${sep}file.md`

    beforeAll(async () => {
      await mkdir(`${boundaryRawDir}${sep}sub${sep}deep`, { recursive: true })
      await writeFile(realFile, 'real')
      await writeFile(nestedFile, 'nested')
      await writeFile(outsideFile, 'secret')
      await symlink(outsideFile, symlinkEscape)
    })

    afterAll(async () => {
      await rm(boundaryDbPath, { recursive: true, force: true })
      await rm(outsideFile, { force: true })
    })

    it('accepts a real raw-data file inside the configured dbPath', async () => {
      await expect(isPathInRawDataDir(realFile, boundaryDbPath)).resolves.toBe(true)
    })

    it('rejects a traversal payload that escapes the raw-data dir', async () => {
      const evil = `${boundaryDbPath}/raw-data/../../../etc/passwd`
      await expect(isPathInRawDataDir(evil, boundaryDbPath)).resolves.toBe(false)
    })

    it('rejects a path matching the directory name but a different dbPath', async () => {
      await expect(isPathInRawDataDir('/other/db/raw-data/abc.md', boundaryDbPath)).resolves.toBe(
        false
      )
    })

    it('rejects sibling-prefix paths', async () => {
      const sibling = `${boundaryDbPath}/raw-data-backup/foo.md`
      await expect(isPathInRawDataDir(sibling, boundaryDbPath)).resolves.toBe(false)
    })

    it('accepts the raw-data directory itself', async () => {
      await expect(isPathInRawDataDir(getRawDataDir(boundaryDbPath), boundaryDbPath)).resolves.toBe(
        true
      )
    })

    it('accepts nested children of the raw-data directory', async () => {
      await expect(isPathInRawDataDir(nestedFile, boundaryDbPath)).resolves.toBe(true)
    })

    it('rejects a symlink under raw-data that resolves outside the directory', async () => {
      // Lexical containment passes (the symlink path string is under raw-data),
      // so without realpath this would be a false positive. realpath collapses
      // the symlink to the outside target which is no longer contained.
      await expect(isPathInRawDataDir(symlinkEscape, boundaryDbPath)).resolves.toBe(false)
    })

    it('treats matching paths case-insensitively on win32', async () => {
      // Skip on POSIX where the filesystem is case-sensitive — the lexical
      // comparison stays strict there, matching FS semantics.
      if (process.platform !== 'win32') return
      const mixed = realFile.toUpperCase()
      await expect(isPathInRawDataDir(mixed, boundaryDbPath)).resolves.toBe(true)
    })
  })

  // --------------------------------------------
  // Source Extraction
  // --------------------------------------------
  describe('Source Extraction', () => {
    it('extractSourceFromPath extracts original source from raw-data path', () => {
      const originalSource = 'https://example.com/page'
      const filePath = generateRawDataPath(testDbPath, originalSource, 'html')

      const extractedSource = extractSourceFromPath(filePath)

      expect(extractedSource).toBe(originalSource)
    })

    it('extractSourceFromPath returns null for non-raw-data paths', () => {
      const filePath = '/path/to/documents/file.pdf'

      const extractedSource = extractSourceFromPath(filePath)

      expect(extractedSource).toBeNull()
    })

    it('handles round-trip: save then extract source', async () => {
      const sources = [
        'https://example.com/docs/api',
        'https://blog.example.com/2024/12/30/post',
        'clipboard://2024-12-30-10-30-00',
      ]

      for (const source of sources) {
        const savedPath = await saveRawData(testDbPath, source, 'content', 'text')
        const extractedSource = extractSourceFromPath(savedPath)

        // For URLs, the source will be normalized
        const expectedSource = normalizeSource(source)
        expect(extractedSource).toBe(expectedSource)
      }
    })
  })
})
