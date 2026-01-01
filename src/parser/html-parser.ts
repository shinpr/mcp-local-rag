// HTML Parser using Readability and Turndown
// Extracts main content from HTML and converts to Markdown

import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'

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
 *
 * @param html - Raw HTML string
 * @param url - Source URL (used for resolving relative links)
 * @returns Markdown string of extracted content
 */
export async function parseHtml(html: string, url: string): Promise<string> {
  // Handle empty or whitespace-only HTML
  if (!html || html.trim().length === 0) {
    return ''
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
        return ''
      }

      // Convert raw body HTML to Markdown
      const turndownService = createTurndownService()
      return turndownService.turndown(bodyContent).trim()
    }

    // Convert extracted HTML content to Markdown
    const turndownService = createTurndownService()
    const markdown = turndownService.turndown(article.content)

    // Add title if available
    if (article.title) {
      return `# ${article.title}\n\n${markdown}`.trim()
    }

    return markdown.trim()
  } catch (error) {
    // Log error but don't throw - return empty string for graceful degradation
    console.error('Failed to parse HTML:', error)
    return ''
  }
}
