// DocumentParser Unit Test

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentParser, FileOperationError, ValidationError } from '../index'

describe('DocumentParser', () => {
  let parser: DocumentParser
  const testDir = join(process.cwd(), 'tmp', 'test-parser')
  const maxFileSize = 100 * 1024 * 1024 // 100MB

  beforeEach(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true })

    parser = new DocumentParser({
      baseDir: testDir,
      maxFileSize,
    })
  })

  afterEach(async () => {
    // Cleanup test directory
    await rm(testDir, { recursive: true, force: true })
  })

  describe('validateFilePath', () => {
    it('should accept valid absolute path within baseDir', () => {
      const validPath = join(testDir, 'test.txt')
      expect(() => parser.validateFilePath(validPath)).not.toThrow()
    })

    it('should accept nested absolute path within baseDir', () => {
      const validPath = join(testDir, 'subdir', 'test.txt')
      expect(() => parser.validateFilePath(validPath)).not.toThrow()
    })

    it('should reject relative path', () => {
      expect(() => parser.validateFilePath('test.txt')).toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/absolute path/),
        })
      )
    })

    it('should reject relative path traversal attack (../)', () => {
      expect(() => parser.validateFilePath('../outside.txt')).toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/absolute path/),
        })
      )
    })

    it('should reject absolute path outside baseDir', () => {
      expect(() => parser.validateFilePath('/etc/passwd')).toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/outside BASE_DIR/),
        })
      )
    })
  })

  describe('validateFileSize', () => {
    it('should accept file within size limit', async () => {
      const filePath = join(testDir, 'small.txt')
      await writeFile(filePath, 'Small file content')

      expect(() => parser.validateFileSize(filePath)).not.toThrow()
    })

    it('should reject file exceeding size limit', async () => {
      const filePath = join(testDir, 'large.txt')
      // Create a file larger than maxFileSize (simulate with metadata check)
      await writeFile(filePath, 'test')

      // Mock large file by adjusting maxFileSize to 1 byte
      const smallParser = new DocumentParser({
        baseDir: testDir,
        maxFileSize: 1,
      })

      expect(() => smallParser.validateFileSize(filePath)).toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/File size exceeds limit/),
        })
      )
    })

    it('should throw FileOperationError for non-existent file', () => {
      const filePath = join(testDir, 'nonexistent.txt')
      expect(() => parser.validateFileSize(filePath)).toThrow(FileOperationError)
    })
  })

  describe('parseFile', () => {
    it('should parse TXT file successfully', async () => {
      const filePath = join(testDir, 'test.txt')
      const content = 'This is a test TXT file.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result).toBe(content)
    })

    it('should parse MD file successfully', async () => {
      const filePath = join(testDir, 'test.md')
      const content = '# Markdown Test\n\nThis is a **test** MD file.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result).toBe(content)
    })

    it('should throw ValidationError for unsupported file format', async () => {
      const filePath = join(testDir, 'test.xyz')
      await writeFile(filePath, 'fake xyz content')

      await expect(parser.parseFile(filePath)).rejects.toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/Unsupported file format/),
        })
      )
    })

    it('should throw FileOperationError for invalid DOCX file', async () => {
      const filePath = join(testDir, 'test.docx')
      await writeFile(filePath, 'fake docx content')

      await expect(parser.parseFile(filePath)).rejects.toThrow(
        expect.objectContaining({
          name: 'FileOperationError',
          message: expect.stringMatching(/Failed to parse DOCX/),
        })
      )
    })

    it('should throw ValidationError for path traversal attempt', async () => {
      await expect(parser.parseFile('../outside.txt')).rejects.toThrow(ValidationError)
    })

    it('should throw FileOperationError for non-existent file', async () => {
      const nonExistentFile = join(testDir, 'nonexistent.txt')
      await expect(parser.parseFile(nonExistentFile)).rejects.toThrow(FileOperationError)
    })
  })

  describe('parseTxt', () => {
    it('should parse UTF-8 text file', async () => {
      const filePath = join(testDir, 'utf8.txt')
      const content = 'Hello, World! Hello, World!'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result).toBe(content)
    })

    it('should handle empty file', async () => {
      const filePath = join(testDir, 'empty.txt')
      await writeFile(filePath, '', 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result).toBe('')
    })
  })

  describe('parseMd', () => {
    it('should parse markdown file with formatting', async () => {
      const filePath = join(testDir, 'formatted.md')
      const content = '# Title\n\n## Subtitle\n\n- Item 1\n- Item 2\n\n**Bold** and *italic*.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result).toBe(content)
    })
  })
})
