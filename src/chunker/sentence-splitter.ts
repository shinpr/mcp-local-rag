// Sentence Splitter for Semantic Chunking
// Created: 2024-12-27
// Purpose: Split text into sentences while preserving code blocks and handling multiple languages

// ============================================
// Constants
// ============================================

/**
 * Common abbreviations that should not trigger sentence splits
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  'e.g',
  'i.e',
  'cf',
  'vol',
  'no',
  'pp',
  'fig',
  'eq',
])

/**
 * Placeholder for code blocks during processing
 */
const CODE_BLOCK_PLACEHOLDER = '\u0000CODE_BLOCK\u0000'

/**
 * Placeholder for inline code during processing
 */
const INLINE_CODE_PLACEHOLDER = '\u0000INLINE_CODE\u0000'

// ============================================
// Types
// ============================================

interface CodeBlockInfo {
  placeholder: string
  content: string
}

// ============================================
// Helper Functions
// ============================================

/**
 * Extract and replace code blocks with placeholders
 */
function extractCodeBlocks(text: string): { text: string; blocks: CodeBlockInfo[] } {
  const blocks: CodeBlockInfo[] = []
  let processedText = text

  // Extract fenced code blocks (```...```)
  const codeBlockRegex = /```[\s\S]*?```/g
  let index = 0

  const codeBlockMatches = text.matchAll(codeBlockRegex)
  for (const match of codeBlockMatches) {
    const placeholder = `${CODE_BLOCK_PLACEHOLDER}${index}${CODE_BLOCK_PLACEHOLDER}`
    blocks.push({ placeholder, content: match[0] })
    processedText = processedText.replace(match[0], placeholder)
    index++
  }

  // Extract inline code (`...`)
  const inlineCodeRegex = /`[^`]+`/g
  const inlineMatches = processedText.matchAll(inlineCodeRegex)
  for (const match of inlineMatches) {
    const placeholder = `${INLINE_CODE_PLACEHOLDER}${index}${INLINE_CODE_PLACEHOLDER}`
    blocks.push({ placeholder, content: match[0] })
    processedText = processedText.replace(match[0], placeholder)
    index++
  }

  return { text: processedText, blocks }
}

/**
 * Restore code blocks from placeholders
 */
function restoreCodeBlocks(sentences: string[], blocks: CodeBlockInfo[]): string[] {
  return sentences.map((sentence) => {
    let restored = sentence
    for (const block of blocks) {
      restored = restored.replace(block.placeholder, block.content)
    }
    return restored
  })
}

/**
 * Check if a period is likely part of an abbreviation
 */
function isAbbreviation(text: string, periodIndex: number): boolean {
  // Find the word before the period
  let wordStart = periodIndex - 1
  while (wordStart >= 0 && /[a-zA-Z.]/.test(text[wordStart] ?? '')) {
    wordStart--
  }
  wordStart++

  const word = text.slice(wordStart, periodIndex).toLowerCase()
  return ABBREVIATIONS.has(word)
}

/**
 * Check if a period is part of a number (e.g., 3.14)
 */
function isNumberDecimal(text: string, periodIndex: number): boolean {
  const charBefore = text[periodIndex - 1]
  const charAfter = text[periodIndex + 1]
  return /\d/.test(charBefore ?? '') && /\d/.test(charAfter ?? '')
}

// ============================================
// Main Function
// ============================================

/**
 * Split text into sentences
 *
 * Handles:
 * - English sentence boundaries (. ! ?)
 * - Japanese sentence boundaries (。 ！ ？)
 * - Paragraph boundaries (\n\n)
 * - Markdown headings
 * - Code blocks (preserved as single units)
 * - Abbreviations (Mr., Dr., etc.)
 * - Decimal numbers (3.14)
 *
 * @param text - The text to split into sentences
 * @returns Array of sentences
 */
export function splitIntoSentences(text: string): string[] {
  // Handle empty input
  if (!text || text.trim().length === 0) {
    return []
  }

  // Extract code blocks to protect them from splitting
  const { text: processedText, blocks } = extractCodeBlocks(text)

  // Split on paragraph boundaries
  // Also treat single newline after code block placeholder as paragraph boundary
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional use of NULL character as placeholder delimiter
  const paragraphs = processedText.split(/\n{2,}|\n(?=\S)|(?<=\u0000)\n/)

  const sentences: string[] = []

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim()
    if (!trimmedParagraph) continue

    // Check if it's a markdown heading (treat as single sentence)
    if (/^#{1,6}\s/.test(trimmedParagraph)) {
      sentences.push(trimmedParagraph)
      continue
    }

    // Split the paragraph into sentences
    const paragraphSentences = splitParagraphIntoSentences(trimmedParagraph)
    sentences.push(...paragraphSentences)
  }

  // Restore code blocks
  const restoredSentences = restoreCodeBlocks(sentences, blocks)

  // Filter empty sentences and trim
  return restoredSentences.map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Find the first non-space character index after a given position
 */
function findNextNonSpace(text: string, startIndex: number): number {
  let idx = startIndex
  while (idx < text.length && text[idx] === ' ') {
    idx++
  }
  return idx
}

/**
 * Check if a character indicates a new sentence start
 * Accepts: uppercase letters, non-ASCII characters (Japanese, etc.), placeholders, or end of string
 */
function isNewSentenceStart(char: string | undefined): boolean {
  if (char === undefined) return true
  // Uppercase English letter
  if (/[A-Z]/.test(char)) return true
  // Non-ASCII character (Japanese, Chinese, etc.)
  if (char.charCodeAt(0) > 127) return true
  // Code block placeholder
  if (char === '\u0000') return true
  return false
}

/**
 * Split a single paragraph into sentences
 */
function splitParagraphIntoSentences(paragraph: string): string[] {
  const sentences: string[] = []
  let currentSentence = ''
  let i = 0

  while (i < paragraph.length) {
    const char = paragraph[i] ?? ''
    currentSentence += char

    // Check for sentence-ending punctuation
    const isEnglishEnd = char === '.' || char === '!' || char === '?'
    const isJapaneseEnd = char === '。' || char === '！' || char === '？'

    if (isEnglishEnd) {
      // Check if it's NOT an abbreviation or decimal
      if (!isAbbreviation(paragraph, i) && !isNumberDecimal(paragraph, i)) {
        const nextChar = paragraph[i + 1]

        // End of string or newline
        if (nextChar === undefined || nextChar === '\n') {
          sentences.push(currentSentence.trim())
          currentSentence = ''
        }
        // Followed by space(s)
        else if (nextChar === ' ') {
          // Find the first non-space character
          const nextNonSpaceIdx = findNextNonSpace(paragraph, i + 1)
          const charAfterSpaces = paragraph[nextNonSpaceIdx]

          if (isNewSentenceStart(charAfterSpaces)) {
            sentences.push(currentSentence.trim())
            currentSentence = ''
            // Skip all spaces
            i = nextNonSpaceIdx - 1
          }
        }
      }
    } else if (isJapaneseEnd) {
      // Japanese punctuation always ends a sentence
      sentences.push(currentSentence.trim())
      currentSentence = ''
    }

    i++
  }

  // Add any remaining text as a sentence
  if (currentSentence.trim()) {
    sentences.push(currentSentence.trim())
  }

  return sentences
}
