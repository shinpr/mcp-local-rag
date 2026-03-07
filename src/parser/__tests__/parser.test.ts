// DocumentParser Unit Test

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentParser, FileOperationError, ValidationError } from '../index'

// ============================================
// Mocks for parsePdf tests (vi.hoisted ensures availability in vi.mock factories)
// ============================================

const { mockOpenDocument, mockFilterPageBoundarySentences, mockExtractPdfTitle, mockChunkText } =
  vi.hoisted(() => ({
    mockOpenDocument: vi.fn(),
    mockFilterPageBoundarySentences: vi.fn(),
    mockExtractPdfTitle: vi.fn(),
    mockChunkText: vi.fn(),
  }))

vi.mock('mupdf', () => ({
  Document: { openDocument: mockOpenDocument },
}))

vi.mock('../pdf-filter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../pdf-filter.js')>()
  return {
    ...original,
    filterPageBoundarySentences: (...args: unknown[]) => mockFilterPageBoundarySentences(...args),
  }
})

vi.mock('../title-extractor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../title-extractor.js')>()
  return {
    ...original,
    extractPdfTitle: (...args: unknown[]) => mockExtractPdfTitle(...args),
  }
})

vi.mock('../../chunker/index.js', () => ({
  SemanticChunker: class {
    chunkText = mockChunkText
  },
}))

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

  // --------------------------------------------
  // parsePdf
  // --------------------------------------------
  describe('parsePdf', () => {
    const mockEmbedder = { embed: vi.fn() }

    /**
     * Helper to build a mupdf mock document with configurable pages.
     * Each page entry defines: bounds, blocks (mupdf JSON structure), and optional metadata title.
     */
    function setupMupdfMock(
      pages: Array<{
        bounds: [number, number, number, number]
        blocks: Array<{
          type: string
          lines?: Array<{ text: string; x: number; y: number; font: { size: number } }>
        }>
      }>,
      metadataTitle?: string
    ) {
      const mockPages = pages.map((pageDef) => {
        const mockStext = {
          asJSON: vi.fn().mockReturnValue(JSON.stringify({ blocks: pageDef.blocks })),
        }
        return {
          getBounds: vi.fn().mockReturnValue(pageDef.bounds),
          toStructuredText: vi.fn().mockReturnValue(mockStext),
        }
      })

      const mockDoc = {
        countPages: vi.fn().mockReturnValue(pages.length),
        loadPage: vi.fn().mockImplementation((i: number) => mockPages[i]),
        getMetaData: vi.fn().mockReturnValue(metadataTitle ?? ''),
      }

      mockOpenDocument.mockReturnValue(mockDoc)
      return mockDoc
    }

    beforeEach(async () => {
      vi.clearAllMocks()

      // filterPageBoundarySentences: pass through by joining item texts per page
      mockFilterPageBoundarySentences.mockImplementation(
        async (pageDataArr: Array<{ items: Array<{ text: string }> }>) =>
          pageDataArr.map((p) => p.items.map((item) => item.text).join('\n'))
      )

      // extractPdfTitle: return the title or fallback
      mockExtractPdfTitle.mockImplementation(
        (metadata: string | undefined, _chunk: string | undefined, fileName: string) => ({
          title: metadata ?? fileName.replace(/\.pdf$/, ''),
          source: metadata ? 'metadata' : 'filename',
        })
      )

      // SemanticChunker.chunkText: return first line as chunk
      mockChunkText.mockImplementation(async (text: string) => [{ text, index: 0 }])

      // Create a dummy PDF file so validateFilePath and validateFileSize pass
      await writeFile(join(testDir, 'test.pdf'), 'dummy-pdf-content')
    })

    it('should extract text from a single block with one line', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Hello World', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      expect(result.content).toBe('Hello World')
      expect(result.title).toBeDefined()
      // Verify filterPageBoundarySentences received correct PageData structure
      expect(mockFilterPageBoundarySentences).toHaveBeenCalledWith(
        [
          {
            pageNum: 1,
            pageHeight: 792,
            items: [
              expect.objectContaining({
                text: 'Hello World',
                x: 72,
                y: 692, // 792 - 100
                fontSize: 12,
                hasEOL: true,
              }),
            ],
          },
        ],
        mockEmbedder
      )
    })

    it('should invert Y coordinate correctly (pageHeight - line.y)', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Bottom text', x: 72, y: 751, font: { size: 10 } }],
            },
          ],
        },
      ])

      await parser.parsePdf(filePath, mockEmbedder)

      // Y inversion: 792 - 751 = 41
      const calledPages = mockFilterPageBoundarySentences.mock.calls[0][0]
      expect(calledPages[0].items[0].y).toBe(41)
    })

    it('should use zero-based loadPage index and one-based pageNum in output', async () => {
      const filePath = join(testDir, 'test.pdf')
      const mockDoc = setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Page 1 text', x: 0, y: 0, font: { size: 12 } }],
            },
          ],
        },
      ])

      await parser.parsePdf(filePath, mockEmbedder)

      // loadPage called with 0 (zero-based)
      expect(mockDoc.loadPage).toHaveBeenCalledWith(0)
      // Output pageNum is 1 (one-based)
      const calledPages = mockFilterPageBoundarySentences.mock.calls[0][0]
      expect(calledPages[0].pageNum).toBe(1)
    })

    it('should skip non-text blocks (e.g., image blocks)', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            { type: 'image' },
            {
              type: 'text',
              lines: [{ text: 'Visible text', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      await parser.parsePdf(filePath, mockEmbedder)

      const calledPages = mockFilterPageBoundarySentences.mock.calls[0][0]
      // Only the text block should produce items, image block is skipped
      expect(calledPages[0].items).toHaveLength(1)
      expect(calledPages[0].items[0].text).toBe('Visible text')
    })

    it('should use metadata title when getMetaData returns a value', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock(
        [
          {
            bounds: [0, 0, 612, 792],
            blocks: [
              {
                type: 'text',
                lines: [{ text: 'Body text', x: 72, y: 100, font: { size: 12 } }],
              },
            ],
          },
        ],
        'My Title'
      )

      const result = await parser.parsePdf(filePath, mockEmbedder)

      // extractPdfTitle receives metadata title as first argument
      expect(mockExtractPdfTitle).toHaveBeenCalledWith('My Title', expect.any(String), 'test.pdf', {
        text: 'Body text',
        fontSize: 12,
      })
      expect(result.title).toBe('My Title')
    })

    it('should pass undefined metadata when getMetaData returns empty string', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Some text', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      await parser.parsePdf(filePath, mockEmbedder)

      // getMetaData returns '' which is falsy, so metadataTitle becomes undefined
      expect(mockExtractPdfTitle).toHaveBeenCalledWith(undefined, expect.any(String), 'test.pdf', {
        text: 'Some text',
        fontSize: 12,
      })
    })

    it('should produce empty items array for a page with no blocks', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [],
        },
      ])

      await parser.parsePdf(filePath, mockEmbedder)

      const calledPages = mockFilterPageBoundarySentences.mock.calls[0][0]
      expect(calledPages[0].items).toEqual([])
      expect(calledPages[0].pageNum).toBe(1)
    })
  })
})
