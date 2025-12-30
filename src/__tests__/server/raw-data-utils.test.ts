// Raw Data Utilities Test
// Test Type: Unit Test

import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  decodeBase64Url,
  encodeBase64Url,
  extractSourceFromPath,
  formatToExtension,
  generateRawDataPath,
  getRawDataDir,
  isRawDataPath,
  normalizeSource,
  saveRawData,
} from '../../server/raw-data-utils.js'

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
    it('returns correct extension for each format', () => {
      expect(formatToExtension('html')).toBe('html')
      expect(formatToExtension('markdown')).toBe('md')
      expect(formatToExtension('text')).toBe('txt')
    })
  })

  // --------------------------------------------
  // Raw Data Directory
  // --------------------------------------------
  describe('Raw Data Directory', () => {
    it('returns correct raw-data directory path', () => {
      const dbPath = '/path/to/lancedb'
      const rawDataDir = getRawDataDir(dbPath)

      expect(rawDataDir).toBe('/path/to/lancedb/raw-data')
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

      expect(path).toContain('/path/to/lancedb/raw-data/')
      expect(path).toMatch(/\.html$/)
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
      expect(savedPath).toMatch(/\.html$/)
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
  describe('Path Detection', () => {
    it('isRawDataPath returns true for raw-data paths', () => {
      expect(isRawDataPath('/path/to/lancedb/raw-data/abc123.html')).toBe(true)
      expect(isRawDataPath('./lancedb/raw-data/xyz.txt')).toBe(true)
    })

    it('isRawDataPath returns false for non-raw-data paths', () => {
      expect(isRawDataPath('/path/to/documents/file.pdf')).toBe(false)
      expect(isRawDataPath('/home/user/raw-data-backup/file.txt')).toBe(false)
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
