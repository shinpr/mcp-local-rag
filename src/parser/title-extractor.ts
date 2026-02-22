// Title Extractor - Per-format document title extraction
// Title is display-only metadata (NOT used for search scoring)

// ============================================
// Type Definitions
// ============================================

/**
 * Result of title extraction, including how the title was determined
 */
export interface TitleExtractionResult {
  title: string
  source: 'metadata' | 'content' | 'filename'
}

// ============================================
// Shared Helper
// ============================================

/**
 * Convert a file name to a human-readable title
 * Strips the extension and replaces hyphens/underscores with spaces
 *
 * @param fileName - File name (e.g., "2024-annual-report.pdf")
 * @returns Human-readable title (e.g., "2024 annual report")
 */
export function fileNameToTitle(fileName: string): string {
  // Strip extension (last dot and everything after)
  const lastDotIndex = fileName.lastIndexOf('.')
  const nameWithoutExt = lastDotIndex > 0 ? fileName.substring(0, lastDotIndex) : fileName
  // Replace hyphens and underscores with spaces
  return nameWithoutExt.replace(/[-_]/g, ' ')
}

// ============================================
// Per-Format Extractors
// ============================================

/**
 * Extract title from Markdown content
 * Priority: YAML frontmatter title -> first # H1 -> file name
 *
 * @param text - Markdown content
 * @param fileName - File name for fallback
 * @returns Title extraction result
 */
export function extractMarkdownTitle(text: string, fileName: string): TitleExtractionResult {
  // 1. Try YAML frontmatter
  const frontmatterMatch = text.match(/^---\n[\s\S]*?title:\s*['"]?(.+?)['"]?\s*\n[\s\S]*?---/)
  if (frontmatterMatch?.[1]) {
    return { title: frontmatterMatch[1].trim(), source: 'metadata' }
  }

  // 2. Try first H1 heading
  const h1Match = text.match(/^# (.+)$/m)
  if (h1Match?.[1]) {
    return { title: h1Match[1].trim(), source: 'content' }
  }

  // 3. Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}

/**
 * Extract title from plain text content
 * Priority: first line followed by empty line -> file name
 *
 * @param text - Plain text content
 * @param fileName - File name for fallback
 * @returns Title extraction result
 */
export function extractTxtTitle(text: string, fileName: string): TitleExtractionResult {
  // Try first line followed by empty line
  if (text.length > 0) {
    const lines = text.split('\n')
    const firstLine = lines[0]
    const secondLine = lines[1]
    if (
      firstLine !== undefined &&
      secondLine !== undefined &&
      firstLine.trim().length > 0 &&
      secondLine.trim().length === 0
    ) {
      return { title: firstLine.trim(), source: 'content' }
    }
  }

  // Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}

/**
 * Extract title from HTML content (using Readability title)
 * Priority: readability title -> file name
 *
 * @param readabilityTitle - Title extracted by Readability
 * @param fileName - File name for fallback
 * @returns Title extraction result
 */
export function extractHtmlTitle(
  readabilityTitle: string,
  fileName: string
): TitleExtractionResult {
  if (readabilityTitle && readabilityTitle.trim().length > 0) {
    return { title: readabilityTitle.trim(), source: 'content' }
  }

  // Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}

/**
 * Extract title from PDF metadata and first page items
 * Priority: PDF metadata /Title -> largest font text on page 1 -> file name
 *
 * Rejects metadata titles that look like file paths (contain / or \) or are empty/whitespace-only.
 *
 * @param metadataTitle - PDF metadata /Title value (may be undefined)
 * @param firstPageItems - Text items from first page with font size
 * @param fileName - File name for fallback
 * @returns Title extraction result
 */
export function extractPdfTitle(
  metadataTitle: string | undefined,
  firstPageItems: Array<{ text: string; fontSize: number }>,
  fileName: string
): TitleExtractionResult {
  // 1. Try PDF metadata title (reject file paths and empty values)
  if (metadataTitle && metadataTitle.trim().length > 0) {
    const trimmed = metadataTitle.trim()
    const looksLikeFilePath = trimmed.includes('/') || trimmed.includes('\\')
    if (!looksLikeFilePath) {
      return { title: trimmed, source: 'metadata' }
    }
  }

  // 2. Try largest font text on first page
  if (firstPageItems.length > 0) {
    let largestItem = firstPageItems[0] as { text: string; fontSize: number }
    for (const item of firstPageItems) {
      if (item.fontSize > largestItem.fontSize) {
        largestItem = item
      }
    }
    if (largestItem.text.trim().length > 0) {
      return { title: largestItem.text.trim(), source: 'content' }
    }
  }

  // 3. Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}

/**
 * Extract title from DOCX mammoth HTML output
 * Priority: first <h1> from mammoth HTML -> file name
 *
 * @param htmlContent - HTML content generated by mammoth.convertToHtml()
 * @param fileName - File name for fallback
 * @returns Title extraction result
 */
export function extractDocxTitle(htmlContent: string, fileName: string): TitleExtractionResult {
  // Try to find first <h1> tag
  const h1Match = htmlContent.match(/<h1>([\s\S]*?)<\/h1>/)
  if (h1Match?.[1]) {
    const title = h1Match[1].trim()
    if (title.length > 0) {
      return { title, source: 'content' }
    }
  }

  // Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}
