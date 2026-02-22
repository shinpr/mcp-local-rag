// DocumentParser Unit Test

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
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
    const outsideDir = join(process.cwd(), 'tmp', 'test-parser-outside')

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true })
    })

    it('should accept valid absolute path within baseDir', async () => {
      const validPath = join(testDir, 'test.txt')
      await expect(parser.validateFilePath(validPath)).resolves.toBeUndefined()
    })

    it('should accept nested absolute path within baseDir', async () => {
      const validPath = join(testDir, 'subdir', 'test.txt')
      await expect(parser.validateFilePath(validPath)).resolves.toBeUndefined()
    })

    it('should reject relative path', async () => {
      await expect(parser.validateFilePath('test.txt')).rejects.toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/absolute path/),
        })
      )
    })

    it('should reject relative path traversal attack (../)', async () => {
      await expect(parser.validateFilePath('../outside.txt')).rejects.toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/absolute path/),
        })
      )
    })

    it('should reject absolute path outside baseDir', async () => {
      await expect(parser.validateFilePath('/etc/passwd')).rejects.toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/outside BASE_DIR/),
        })
      )
    })

    it('should reject symlink pointing outside baseDir', async () => {
      // Create outside directory and target file
      await mkdir(outsideDir, { recursive: true })
      const outsideFile = join(outsideDir, 'secret.txt')
      await writeFile(outsideFile, 'secret content')

      // Create symlink inside testDir with .txt extension pointing to outside file
      const linkPath = join(testDir, 'evil-link.txt')
      await symlink(outsideFile, linkPath)

      // Should reject because resolved path is outside baseDir
      await expect(parser.validateFilePath(linkPath)).rejects.toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/BASE_DIR/),
        })
      )
    })

    it('should reject broken symlink', async () => {
      // Create symlink pointing to non-existent file
      const linkPath = join(testDir, 'broken-link.txt')
      await symlink('/nonexistent/path/to/file.txt', linkPath)

      // Should reject because symlink target cannot be resolved
      await expect(parser.validateFilePath(linkPath)).rejects.toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          message: expect.stringMatching(/Cannot resolve|broken symlink/),
        })
      )
    })

    it('should accept non-symlink file within baseDir (regression guard)', async () => {
      // Create a real file inside testDir
      const filePath = join(testDir, 'real-file.txt')
      await writeFile(filePath, 'real content')

      // Should still work after async conversion
      await expect(parser.validateFilePath(filePath)).resolves.toBeUndefined()
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
    it('should parse TXT file and return ParseResult', async () => {
      const filePath = join(testDir, 'test.txt')
      const content = 'This is a test TXT file.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.content).toBe(content)
      expect(result.title).toBe('test')
    })

    it('should parse MD file and return ParseResult', async () => {
      const filePath = join(testDir, 'test.md')
      const content = '# Markdown Test\n\nThis is a **test** MD file.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.content).toBe(content)
      expect(result.title).toBe('Markdown Test')
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
    it('should parse UTF-8 text file and return ParseResult', async () => {
      const filePath = join(testDir, 'utf8.txt')
      const content = 'Hello, World! Hello, World!'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.content).toBe(content)
      expect(result.title).toBe('utf8')
    })

    it('should handle empty file', async () => {
      const filePath = join(testDir, 'empty.txt')
      await writeFile(filePath, '', 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.content).toBe('')
    })
  })

  describe('parseMd', () => {
    it('should parse markdown file with formatting and return ParseResult', async () => {
      const filePath = join(testDir, 'formatted.md')
      const content = '# Title\n\n## Subtitle\n\n- Item 1\n- Item 2\n\n**Bold** and *italic*.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.content).toBe(content)
      expect(result.title).toBe('Title')
    })
  })

  // --------------------------------------------
  // Title Extraction per Format
  // --------------------------------------------
  describe('Title extraction per format', () => {
    it('should extract title from markdown frontmatter', async () => {
      const filePath = join(testDir, 'with-frontmatter.md')
      const content = '---\ntitle: My Document Title\n---\n\nContent here.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.title).toBe('My Document Title')
      expect(result.content).toBe(content)
    })

    it('should extract title from first heading in markdown', async () => {
      const filePath = join(testDir, 'with-heading.md')
      const content = '# My Heading\n\nContent here.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.title).toBe('My Heading')
    })

    it('should extract title from first line of txt', async () => {
      const filePath = join(testDir, 'titled.txt')
      const content = 'Document Title\n\nThis is the body text.'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.title).toBe('Document Title')
    })

    it('should fall back to file name for txt without title pattern', async () => {
      const filePath = join(testDir, 'my-notes.txt')
      const content = 'Line one\nLine two\nLine three'
      await writeFile(filePath, content, 'utf-8')

      const result = await parser.parseFile(filePath)
      expect(result.title).toBe('my notes')
    })
  })
})
