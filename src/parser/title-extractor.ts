// Title Extractor - Per-format document title extraction
// Title is display-only metadata (NOT used for search scoring)

// ============================================
// Constants
// ============================================

/** Minimum font size (pt) for page-1 largest-font text to be treated as a title. */
const TITLE_MIN_FONT_SIZE = 14

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

/** `2024-annual-report.pdf` -> `2024 annual report`. */
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

/** Priority: YAML frontmatter title -> first `#` H1 -> file name. */
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

/** Priority: a first line followed by a blank line -> file name. */
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

/** Priority: Readability title -> file name. */
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
 * Priority: PDF metadata `/Title` -> page-1 chunk 0 -> file name.
 *
 * A metadata title that looks like a file path (contains `/` or `\`) is
 * rejected, since some producers write the source path there.
 */
export function extractPdfTitle(
  metadataTitle: string | undefined,
  firstPageChunkText: string | undefined,
  fileName: string,
  firstPageFontHint?: { text: string; fontSize: number }
): TitleExtractionResult {
  // 1. Try PDF metadata title (reject file paths and empty values)
  if (metadataTitle && metadataTitle.trim().length > 0) {
    const trimmed = metadataTitle.trim()
    const looksLikeFilePath = trimmed.includes('/') || trimmed.includes('\\')
    if (!looksLikeFilePath) {
      return { title: trimmed, source: 'metadata' }
    }
  }

  // 2. Try largest-font text from page 1 (font size > threshold indicates title)
  if (
    firstPageFontHint &&
    firstPageFontHint.fontSize > TITLE_MIN_FONT_SIZE &&
    firstPageFontHint.text.trim().length > 0
  ) {
    return { title: firstPageFontHint.text.trim(), source: 'content' }
  }

  // 3. Try first chunk from page 1 semantic chunking
  if (firstPageChunkText && firstPageChunkText.trim().length > 0) {
    return { title: firstPageChunkText.trim(), source: 'content' }
  }

  // 4. Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}

/** Priority: DOCX core title -> first non-empty `<h1>` -> file name. */
export function extractDocxTitle(
  document: Document,
  fileName: string,
  metadataTitle?: string
): TitleExtractionResult {
  const normalizedMetadataTitle = metadataTitle?.replace(/\s+/g, ' ').trim()
  if (normalizedMetadataTitle) {
    return { title: normalizedMetadataTitle, source: 'metadata' }
  }

  for (const heading of document.querySelectorAll('h1')) {
    const title = (heading.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (title) {
      return { title, source: 'content' }
    }
  }

  // Fall back to file name
  return { title: fileNameToTitle(fileName), source: 'filename' }
}
