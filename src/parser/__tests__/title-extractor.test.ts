// Title Extractor Unit Tests
// Test Type: Unit Test

import { describe, expect, it } from 'vitest'
import {
  extractDocxTitle,
  extractHtmlTitle,
  extractMarkdownTitle,
  extractPdfTitle,
  extractTxtTitle,
  fileNameToTitle,
} from '../title-extractor.js'

// ============================================
// Tests
// ============================================

describe('Title Extractor', () => {
  // --------------------------------------------
  // fileNameToTitle helper
  // --------------------------------------------
  describe('fileNameToTitle', () => {
    it('should strip extension and replace hyphens/underscores with spaces', () => {
      expect(fileNameToTitle('2024-annual-report.pdf')).toBe('2024 annual report')
    })

    it('should handle file names with multiple dots', () => {
      expect(fileNameToTitle('report.v2.final.pdf')).toBe('report.v2.final')
    })

    it('should handle file names with underscores', () => {
      expect(fileNameToTitle('my_document_title.md')).toBe('my document title')
    })

    it('should handle file names with mixed hyphens and underscores', () => {
      expect(fileNameToTitle('project-plan_v2.txt')).toBe('project plan v2')
    })

    it('should handle file names with no extension', () => {
      expect(fileNameToTitle('README')).toBe('README')
    })
  })

  // --------------------------------------------
  // extractMarkdownTitle
  // --------------------------------------------
  describe('extractMarkdownTitle', () => {
    it('should extract title from YAML frontmatter', () => {
      const text = '---\ntitle: My Document\ndate: 2024-01-01\n---\n\nContent here.'
      const result = extractMarkdownTitle(text, 'test.md')

      expect(result.title).toBe('My Document')
      expect(result.source).toBe('metadata')
    })

    it('should extract title from YAML frontmatter with double quotes', () => {
      const text = '---\ntitle: "My Quoted Document"\n---\n\nContent here.'
      const result = extractMarkdownTitle(text, 'test.md')

      expect(result.title).toBe('My Quoted Document')
      expect(result.source).toBe('metadata')
    })

    it('should extract title from YAML frontmatter with single quotes', () => {
      const text = "---\ntitle: 'My Single Quoted Document'\n---\n\nContent here."
      const result = extractMarkdownTitle(text, 'test.md')

      expect(result.title).toBe('My Single Quoted Document')
      expect(result.source).toBe('metadata')
    })

    it('should extract first H1 heading when no frontmatter', () => {
      const text = '# My Title\n\nContent here.'
      const result = extractMarkdownTitle(text, 'test.md')

      expect(result.title).toBe('My Title')
      expect(result.source).toBe('content')
    })

    it('should prefer frontmatter over H1', () => {
      const text = '---\ntitle: Frontmatter Title\n---\n\n# Heading Title\n\nContent here.'
      const result = extractMarkdownTitle(text, 'test.md')

      expect(result.title).toBe('Frontmatter Title')
      expect(result.source).toBe('metadata')
    })

    it('should fall back to file name when no title found', () => {
      const text = 'Just some plain text without any title markers.'
      const result = extractMarkdownTitle(text, 'my-notes.md')

      expect(result.title).toBe('my notes')
      expect(result.source).toBe('filename')
    })

    it('should return source metadata for frontmatter, content for H1, filename for fallback', () => {
      const frontmatter = extractMarkdownTitle('---\ntitle: Test\n---\n', 'test.md')
      expect(frontmatter.source).toBe('metadata')

      const h1 = extractMarkdownTitle('# Test\n', 'test.md')
      expect(h1.source).toBe('content')

      const fallback = extractMarkdownTitle('no title here', 'test.md')
      expect(fallback.source).toBe('filename')
    })
  })

  // --------------------------------------------
  // extractTxtTitle
  // --------------------------------------------
  describe('extractTxtTitle', () => {
    it('should extract first line as title when followed by empty line', () => {
      const text = 'Document Title\n\nThis is the body text.'
      const result = extractTxtTitle(text, 'document.txt')

      expect(result.title).toBe('Document Title')
      expect(result.source).toBe('content')
    })

    it('should fall back to file name when first line has no empty line after', () => {
      const text = 'Line one\nLine two\nLine three'
      const result = extractTxtTitle(text, 'my-notes.txt')

      expect(result.title).toBe('my notes')
      expect(result.source).toBe('filename')
    })

    it('should fall back to file name for empty text', () => {
      const result = extractTxtTitle('', 'empty-file.txt')

      expect(result.title).toBe('empty file')
      expect(result.source).toBe('filename')
    })
  })

  // --------------------------------------------
  // extractHtmlTitle
  // --------------------------------------------
  describe('extractHtmlTitle', () => {
    it('should use readability title when available', () => {
      const result = extractHtmlTitle('Article Title', 'page.html')

      expect(result.title).toBe('Article Title')
      expect(result.source).toBe('content')
    })

    it('should fall back to file name when readability title is empty', () => {
      const result = extractHtmlTitle('', 'my-page.html')

      expect(result.title).toBe('my page')
      expect(result.source).toBe('filename')
    })

    it('should fall back to file name when readability title is whitespace only', () => {
      const result = extractHtmlTitle('   ', 'my-page.html')

      expect(result.title).toBe('my page')
      expect(result.source).toBe('filename')
    })
  })

  // --------------------------------------------
  // extractPdfTitle
  // --------------------------------------------
  describe('extractPdfTitle', () => {
    it('should use PDF metadata title when available', () => {
      const result = extractPdfTitle('Annual Report 2024', [], 'report.pdf')

      expect(result.title).toBe('Annual Report 2024')
      expect(result.source).toBe('metadata')
    })

    it('should use largest font text on first page when no metadata title', () => {
      const items = [
        { text: 'Small body text', fontSize: 12 },
        { text: 'Large Title Text', fontSize: 24 },
        { text: 'Another small text', fontSize: 10 },
      ]
      const result = extractPdfTitle(undefined, items, 'report.pdf')

      expect(result.title).toBe('Large Title Text')
      expect(result.source).toBe('content')
    })

    it('should fall back to file name when no metadata and no items', () => {
      const result = extractPdfTitle(undefined, [], 'annual-report.pdf')

      expect(result.title).toBe('annual report')
      expect(result.source).toBe('filename')
    })

    it('should ignore metadata title if it looks like a file path', () => {
      const result = extractPdfTitle('/home/user/document.pdf', [], 'my-doc.pdf')

      expect(result.title).toBe('my doc')
      expect(result.source).toBe('filename')
    })

    it('should ignore metadata title if it contains backslash path', () => {
      const result = extractPdfTitle('C:\\Users\\doc.pdf', [], 'my-doc.pdf')

      expect(result.title).toBe('my doc')
      expect(result.source).toBe('filename')
    })

    it('should ignore metadata title if it is empty or whitespace', () => {
      const result = extractPdfTitle('   ', [], 'my-doc.pdf')

      expect(result.title).toBe('my doc')
      expect(result.source).toBe('filename')
    })
  })

  // --------------------------------------------
  // extractDocxTitle
  // --------------------------------------------
  describe('extractDocxTitle', () => {
    it('should extract first h1 from mammoth HTML output', () => {
      const html = '<h1>Document Title</h1><p>Some content here.</p>'
      const result = extractDocxTitle(html, 'document.docx')

      expect(result.title).toBe('Document Title')
      expect(result.source).toBe('content')
    })

    it('should fall back to file name when no h1 found', () => {
      const html = '<p>Some content without heading.</p>'
      const result = extractDocxTitle(html, 'my-document.docx')

      expect(result.title).toBe('my document')
      expect(result.source).toBe('filename')
    })

    it('should handle HTML with no heading tags', () => {
      const html = '<p>Just a paragraph.</p><p>Another paragraph.</p>'
      const result = extractDocxTitle(html, 'notes.docx')

      expect(result.title).toBe('notes')
      expect(result.source).toBe('filename')
    })

    it('should extract only the first h1 when multiple exist', () => {
      const html = '<h1>First Title</h1><h1>Second Title</h1><p>Content.</p>'
      const result = extractDocxTitle(html, 'document.docx')

      expect(result.title).toBe('First Title')
      expect(result.source).toBe('content')
    })
  })
})
