// Sentence Splitter for Semantic Chunking
// Created: 2025-12-27
// Purpose: Split text into sentences using Intl.Segmenter (Unicode standard)

// ============================================
// Constants
// ============================================

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

// ============================================
// Intl.Segmenter-based splitting
// ============================================

// Create segmenters for supported languages
// Using 'und' (undetermined) as fallback for general Unicode support
const segmenter = new Intl.Segmenter('und', { granularity: 'sentence' })

/**
 * Split text into sentences using Intl.Segmenter
 *
 * Uses the Unicode Text Segmentation standard (UAX #29) via Intl.Segmenter.
 * This provides multilingual support for sentence boundary detection.
 *
 * Note: Intl.Segmenter may split on abbreviations like "Mr." or "e.g."
 * These edge cases are acceptable for semantic chunking as:
 * 1. Short fragments will be grouped with adjacent sentences by similarity
 * 2. Fragments below minChunkLength are filtered out
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

  // Split on paragraph boundaries first
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

    // Use Intl.Segmenter for sentence splitting
    const segments = segmenter.segment(trimmedParagraph)
    for (const segment of segments) {
      const trimmed = segment.segment.trim()
      if (trimmed) {
        sentences.push(trimmed)
      }
    }
  }

  // Restore code blocks
  const restoredSentences = restoreCodeBlocks(sentences, blocks)

  // Filter empty sentences and trim
  return restoredSentences.map((s) => s.trim()).filter((s) => s.length > 0)
}
