// HTML Parser Test
// Test Type: Unit Test

import { describe, expect, it } from 'vitest'
import { parseHtml } from '../html-parser.js'

// ============================================
// Tests
// ============================================

describe('HTML Parser', () => {
  // --------------------------------------------
  // Basic HTML Parsing
  // --------------------------------------------
  describe('Basic HTML Parsing', () => {
    it('extracts main content from simple HTML', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Test Page</title></head>
          <body>
            <article>
              <h1>Main Title</h1>
              <p>This is the main content of the article.</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/article')

      // Should contain the main content
      expect(result).toContain('Main Title')
      expect(result).toContain('This is the main content of the article')
    })

    it('converts HTML to Markdown format', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <h1>Heading 1</h1>
              <h2>Heading 2</h2>
              <p>Paragraph text.</p>
              <ul>
                <li>Item 1</li>
                <li>Item 2</li>
              </ul>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should have Markdown heading syntax (h1 may become ## if no title extracted)
      expect(result).toMatch(/^##?\s+Heading 1/m)
      expect(result).toMatch(/^##\s+Heading 2/m)
      // Should have list items
      expect(result).toContain('Item 1')
      expect(result).toContain('Item 2')
    })

    it('preserves links in Markdown format', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <p>Check out <a href="https://example.com/link">this link</a> for more info.</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should have Markdown link syntax
      expect(result).toContain('[this link](https://example.com/link)')
    })

    it('preserves code blocks', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <pre><code>const x = 1;
console.log(x);</code></pre>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should preserve code content
      expect(result).toContain('const x = 1')
      expect(result).toContain('console.log(x)')
    })
  })

  // --------------------------------------------
  // Noise Removal
  // --------------------------------------------
  describe('Noise Removal', () => {
    it('removes navigation elements', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <nav>
              <a href="/">Home</a>
              <a href="/about">About</a>
            </nav>
            <article>
              <h1>Article Title</h1>
              <p>Article content here. This paragraph contains enough text for Readability to identify it as the main content of the page.</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should contain article content
      expect(result).toContain('Article Title')
      expect(result).toContain('Article content here')
      // Navigation should be removed
      expect(result).not.toContain('Home')
      expect(result).not.toContain('About')
    })

    it('removes footer elements', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <h1>Main Content</h1>
              <p>Important information about the topic. This is a longer paragraph to ensure readability can extract the main content properly. The content should be substantial enough for the algorithm to identify it as the main article.</p>
              <p>Additional paragraph with more details about the subject matter.</p>
            </article>
            <footer>
              <p>Copyright 2024. All rights reserved.</p>
            </footer>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should contain main content
      expect(result).toContain('Main Content')
      expect(result).toContain('Important information')
      // Footer should be removed
      expect(result).not.toContain('Copyright 2024')
      expect(result).not.toContain('All rights reserved')
    })

    it('removes sidebar elements', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <aside>
              <h3>Related Posts</h3>
              <ul><li>Post 1</li></ul>
            </aside>
            <article>
              <h1>Main Article</h1>
              <p>This is the main article content. Adding more text here to ensure Readability can properly identify this as the primary content section.</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should contain main article
      expect(result).toContain('Main Article')
      expect(result).toContain('main article content')
      // Sidebar should be removed
      expect(result).not.toContain('Related Posts')
      expect(result).not.toContain('Post 1')
    })
  })

  // --------------------------------------------
  // Edge Cases
  // --------------------------------------------
  describe('Edge Cases', () => {
    it('handles empty HTML gracefully', async () => {
      const html = ''

      const result = await parseHtml(html, 'https://example.com/page')

      // Should return empty string or minimal content
      expect(typeof result).toBe('string')
    })

    it('handles HTML with only whitespace', async () => {
      const html = '   \n\t  '

      const result = await parseHtml(html, 'https://example.com/page')

      expect(typeof result).toBe('string')
    })

    it('handles malformed HTML', async () => {
      const html = '<div><p>Unclosed paragraph<div>Another div</div>'

      const result = await parseHtml(html, 'https://example.com/page')

      // Should still extract content
      expect(result).toContain('Unclosed paragraph')
    })

    it('handles HTML without article tag', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <div class="content">
              <h1>Page Title</h1>
              <p>Some content without article wrapper.</p>
            </div>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should still extract content
      expect(result).toContain('Page Title')
      expect(result).toContain('Some content without article wrapper')
    })

    it('handles HTML with only navigation (no main content)', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <nav>
              <a href="/">Home</a>
              <a href="/about">About</a>
            </nav>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      // Should return something (possibly empty or minimal)
      expect(typeof result).toBe('string')
    })
  })

  // --------------------------------------------
  // Unicode and Internationalization
  // --------------------------------------------
  describe('Unicode and Internationalization', () => {
    it('handles Japanese content', async () => {
      const html = `
        <!DOCTYPE html>
        <html lang="ja">
          <body>
            <article>
              <h1>日本語タイトル</h1>
              <p>これは日本語のコンテンツです。</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/ja/page')

      expect(result).toContain('日本語タイトル')
      expect(result).toContain('これは日本語のコンテンツです')
    })

    it('handles mixed language content', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <h1>API Documentation</h1>
              <p>APIの使い方について説明します。</p>
              <p>Use the <code>fetch</code> function to make requests.</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/docs')

      expect(result).toContain('API Documentation')
      expect(result).toContain('APIの使い方について説明します')
      expect(result).toContain('fetch')
    })

    it('handles emoji content', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <article>
              <h1>Welcome! 👋</h1>
              <p>Great news! 🎉 The feature is ready.</p>
            </article>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/page')

      expect(result).toContain('👋')
      expect(result).toContain('🎉')
    })
  })

  // --------------------------------------------
  // Real-world HTML patterns
  // --------------------------------------------
  describe('Real-world HTML patterns', () => {
    it('handles blog post structure', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>My Blog Post</title></head>
          <body>
            <header>
              <nav><a href="/">Blog Home</a></nav>
            </header>
            <main>
              <article>
                <h1>How to Build a RAG System</h1>
                <p class="meta">Published on December 30, 2024</p>
                <p>Building a RAG system involves several key components...</p>
                <h2>Step 1: Document Ingestion</h2>
                <p>First, you need to parse and chunk your documents.</p>
                <h2>Step 2: Vector Embeddings</h2>
                <p>Next, generate embeddings for each chunk.</p>
              </article>
            </main>
            <footer>
              <p>© 2024 My Blog</p>
            </footer>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/blog/rag-system')

      expect(result).toContain('How to Build a RAG System')
      expect(result).toContain('Document Ingestion')
      expect(result).toContain('Vector Embeddings')
      expect(result).toContain('parse and chunk your documents')
    })

    it('handles documentation page structure', async () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <body>
            <div class="sidebar">
              <ul>
                <li><a href="/docs/intro">Introduction</a></li>
                <li><a href="/docs/api">API Reference</a></li>
              </ul>
            </div>
            <div class="content">
              <h1>API Reference</h1>
              <h2>query_documents</h2>
              <p>Search ingested documents using semantic search.</p>
              <h3>Parameters</h3>
              <ul>
                <li><code>query</code> - The search query string</li>
                <li><code>limit</code> - Maximum results (default: 10)</li>
              </ul>
            </div>
          </body>
        </html>
      `

      const result = await parseHtml(html, 'https://example.com/docs/api')

      expect(result).toContain('API Reference')
      // Note: Turndown escapes underscores in some contexts
      expect(result.replace(/\\_/g, '_')).toContain('query_documents')
      expect(result).toContain('semantic search')
    })
  })
})
