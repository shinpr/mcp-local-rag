// HTML Parser using Readability and Turndown
// Extracts main content from HTML and converts to Markdown

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import { extractHtmlTitle } from './title-extractor.js'

// ============================================
// Type Definitions
// ============================================

/**
 * Result from Readability parsing (only fields we use)
 */
interface ReadabilityResult {
  title: string
  content: string
}

// ============================================
// Turndown Service Configuration
// ============================================

/**
 * Create and configure Turndown service for HTML to Markdown conversion
 */
function createTurndownService(): TurndownService {
  const turndownService = new TurndownService({
    headingStyle: 'atx', // Use # style headings
    codeBlockStyle: 'fenced', // Use ``` for code blocks
    bulletListMarker: '-', // Use - for bullet lists
    emDelimiter: '_', // Use _ for emphasis
    strongDelimiter: '**', // Use ** for bold
  })

  // Keep code blocks intact
  turndownService.addRule('codeBlocks', {
    filter: ['pre'],
    replacement: (_content, node) => {
      const element = node as Element
      const codeElement = element.querySelector('code')
      const code = codeElement ? codeElement.textContent : element.textContent
      const language = codeElement?.className?.replace('language-', '') || ''
      return `\n\`\`\`${language}\n${code?.trim() || ''}\n\`\`\`\n`
    },
  })

  return turndownService
}

// ============================================
// HTML Parser
// ============================================

/**
 * Parse HTML content and extract main content as Markdown
 *
 * Flow:
 * 1. HTML string → JSDOM (DOM creation)
 * 2. JSDOM → Readability (main content extraction, noise removal)
 * 3. Readability result → Turndown (Markdown conversion)
 * 4. Title extracted separately via extractHtmlTitle (NOT prepended to content)
 *
 * @param html - Raw HTML string
 * @param url - Source URL (used for resolving relative links)
 * @returns Object with content (markdown) and title (extracted separately)
 */
export async function parseHtml(
  html: string,
  url: string
): Promise<{ content: string; title: string }> {
  // Handle empty or whitespace-only HTML
  if (!html || html.trim().length === 0) {
    return { content: '', title: '' }
  }

  try {
    // Create DOM from HTML string
    const dom = new JSDOM(html, {
      url,
      // Enable features needed for Readability
      runScripts: 'outside-only',
    })

    const document = dom.window.document

    // Use Readability to extract main content
    const reader = new Readability(document, {
      keepClasses: false,
      debug: false,
    })

    const article = reader.parse() as ReadabilityResult | null

    // If Readability couldn't extract content, fall back to body text
    if (!article || !article.content) {
      // Try to get body content directly
      const bodyContent = document.body?.innerHTML || ''
      if (!bodyContent.trim()) {
        return { content: '', title: '' }
      }

      // Convert raw body HTML to Markdown
      const turndownService = createTurndownService()
      return { content: turndownService.turndown(bodyContent).trim(), title: '' }
    }

    // Convert extracted HTML content to Markdown
    const turndownService = createTurndownService()
    const markdown = turndownService.turndown(article.content)

    // Extract title separately (NOT prepended to markdown content)
    const titleResult = extractHtmlTitle(article.title || '', '')
    const title = titleResult.title !== '' ? titleResult.title : ''

    return { content: markdown.trim(), title }
  } catch (error) {
    // Log error but don't throw - return empty values for graceful degradation
    console.error('Failed to parse HTML:', error)
    return { content: '', title: '' }
  }
}
