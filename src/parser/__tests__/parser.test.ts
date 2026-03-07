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
    filterPageBoundarySentences: mockFilterPageBoundarySentences,
  }
})

vi.mock('../title-extractor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../title-extractor.js')>()
  return {
    ...original,
    extractPdfTitle: mockExtractPdfTitle,
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

      // extractPdfTitle: mirror real priority (metadata → font hint → filename)
      mockExtractPdfTitle.mockImplementation(
        (
          metadata: string | undefined,
          _chunk: string | undefined,
          fileName: string,
          fontHint?: { text: string; fontSize: number }
        ) => {
          if (metadata) return { title: metadata, source: 'metadata' as const }
          if (fontHint && fontHint.fontSize > 14)
            return { title: fontHint.text.trim(), source: 'content' as const }
          return { title: fileName.replace(/\.pdf$/, ''), source: 'filename' as const }
        }
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
              lines: [{ text: 'Sample paragraph content', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      expect(result.content).toBe('Sample paragraph content')
      expect(result.title).toBeDefined()
    })

    // Note: Y-coordinate inversion (pageHeight - line.y) and one-based pageNum (i + 1)
    // are internal to parsePdf and not observable from its output. Under isolate: false,
    // vi.mock for pdf-filter.js is ineffective (pdf-filter.test.ts imports the real module),
    // so these cannot be tested via mock inspection either. They are implicitly covered
    // by pdf-filter integration tests that receive correctly transformed page data.

    it('should skip non-text blocks (e.g., image blocks)', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            { type: 'image' },
            {
              type: 'text',
              lines: [{ text: 'Text after image', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      // Only text blocks should be extracted, image blocks are skipped
      expect(result.content).toBe('Text after image')
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
                lines: [{ text: 'Document body', x: 72, y: 100, font: { size: 12 } }],
              },
            ],
          },
        ],
        'Research Paper Title'
      )

      const result = await parser.parsePdf(filePath, mockEmbedder)

      // When metadata title is available, it should be used
      expect(result.title).toBe('Research Paper Title')
    })

    it('should concatenate consecutive largest-font lines for font hint', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [
                { text: 'Getting Started ', x: 44, y: 100, font: { size: 48 } },
                { text: 'with Testing', x: 44, y: 150, font: { size: 48 } },
                { text: 'and Validation', x: 44, y: 200, font: { size: 48 } },
                { text: 'A subtitle', x: 44, y: 300, font: { size: 12 } },
              ],
            },
          ],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      // Multi-line title (font size 48 > 14pt threshold) should be used
      // extractPdfTitle prioritizes font hint over chunk text when fontSize > 14
      expect(result.title).toBe('Getting Started with Testing and Validation')
    })

    it('should normalize tab characters to spaces in extracted text', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: '—\tList item content', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      expect(result.content).toBe('— List item content')
    })

    it('should fall back to filename when getMetaData returns empty string', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Introductory paragraph', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      // getMetaData returns '' → no metadata title, font size 12 < 14pt → no font hint
      // Falls back to filename-based title: 'test.pdf' → 'test'
      expect(result.title).toBe('test')
    })

    it('should produce empty content for a page with no blocks', async () => {
      const filePath = join(testDir, 'test.pdf')
      setupMupdfMock([
        {
          bounds: [0, 0, 612, 792],
          blocks: [],
        },
      ])

      const result = await parser.parsePdf(filePath, mockEmbedder)

      expect(result.content).toBe('')
    })
  })
})
