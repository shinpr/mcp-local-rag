// Sentence Splitter for Semantic Chunking
// Created: 2025-12-27
// Purpose: Split text into sentences using Intl.Segmenter (Unicode standard)

import type { AtomicTextRange } from './index.js'

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

export interface SentenceUnit {
  text: string
  atomic: boolean
  sourceStart: number
  sourceEnd: number
}

interface MappedText {
  text: string
  boundaries: number[]
}

// ============================================
// Helper Functions
// ============================================

function replaceMappedMatches(
  input: MappedText,
  pattern: RegExp,
  placeholderPrefix: string,
  blocks: CodeBlockInfo[],
  firstIndex: number
): { mapped: MappedText; nextIndex: number } {
  const matches = [...input.text.matchAll(pattern)]
  if (matches.length === 0) return { mapped: input, nextIndex: firstIndex }

  let text = ''
  const boundaries = [input.boundaries[0] ?? 0]
  let cursor = 0
  let index = firstIndex
  const appendSource = (start: number, end: number): void => {
    text += input.text.slice(start, end)
    for (let offset = start; offset < end; offset++) {
      boundaries.push(input.boundaries[offset + 1] ?? input.boundaries[offset] ?? 0)
    }
  }

  for (const match of matches) {
    const matchStart = match.index
    const content = match[0]
    if (matchStart === undefined || content.length === 0) continue
    appendSource(cursor, matchStart)

    const matchEnd = matchStart + content.length
    const sourceStart = input.boundaries[matchStart] ?? 0
    const sourceEnd = input.boundaries[matchEnd] ?? sourceStart
    const placeholder = `${placeholderPrefix}${index}${placeholderPrefix}`
    blocks.push({ placeholder, content })
    text += placeholder
    for (let offset = 0; offset < placeholder.length; offset++) {
      boundaries.push(offset === placeholder.length - 1 ? sourceEnd : sourceStart)
    }
    cursor = matchEnd
    index++
  }
  appendSource(cursor, input.text.length)
  return { mapped: { text, boundaries }, nextIndex: index }
}

function maskCode(
  text: string,
  sourceStart: number
): { mapped: MappedText; blocks: CodeBlockInfo[] } {
  const blocks: CodeBlockInfo[] = []
  const initial: MappedText = {
    text,
    boundaries: Array.from({ length: text.length + 1 }, (_, index) => sourceStart + index),
  }
  const fenced = replaceMappedMatches(initial, /```[\s\S]*?```/g, CODE_BLOCK_PLACEHOLDER, blocks, 0)
  const inline = replaceMappedMatches(
    fenced.mapped,
    /`[^`]+`/g,
    INLINE_CODE_PLACEHOLDER,
    blocks,
    fenced.nextIndex
  )
  return { mapped: inline.mapped, blocks }
}

function restoreCode(text: string, blocks: CodeBlockInfo[]): string {
  let restored = text
  for (const block of blocks) {
    restored = restored.replace(block.placeholder, block.content)
  }
  return restored
}

function trimmedRange(text: string, start: number, end: number): [number, number] | null {
  const value = text.slice(start, end)
  const trimmedStart = start + (value.length - value.trimStart().length)
  const trimmedEnd = start + value.trimEnd().length
  return trimmedStart < trimmedEnd ? [trimmedStart, trimmedEnd] : null
}

function splitOrdinaryRange(text: string, sourceStart: number, sourceEnd: number): SentenceUnit[] {
  if (sourceStart >= sourceEnd) return []
  const { mapped, blocks } = maskCode(text.slice(sourceStart, sourceEnd), sourceStart)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL delimiters identify masked code placeholders.
  const paragraphSeparator = /\n{2,}|\n(?=\S)|(?<=\u0000)\n/g
  const paragraphRanges: Array<[number, number]> = []
  let cursor = 0
  for (const match of mapped.text.matchAll(paragraphSeparator)) {
    const separatorStart = match.index
    if (separatorStart === undefined) continue
    paragraphRanges.push([cursor, separatorStart])
    cursor = separatorStart + match[0].length
  }
  paragraphRanges.push([cursor, mapped.text.length])

  const units: SentenceUnit[] = []
  const appendUnit = (start: number, end: number): void => {
    const range = trimmedRange(mapped.text, start, end)
    if (!range) return
    const [trimmedStart, trimmedEnd] = range
    const restored = restoreCode(mapped.text.slice(trimmedStart, trimmedEnd), blocks).trim()
    if (!restored) return
    units.push({
      text: restored,
      atomic: false,
      sourceStart: mapped.boundaries[trimmedStart] ?? sourceStart,
      sourceEnd: mapped.boundaries[trimmedEnd] ?? sourceEnd,
    })
  }

  for (const [paragraphStart, paragraphEnd] of paragraphRanges) {
    const range = trimmedRange(mapped.text, paragraphStart, paragraphEnd)
    if (!range) continue
    const [trimmedStart, trimmedEnd] = range
    const paragraph = mapped.text.slice(trimmedStart, trimmedEnd)
    if (/^#{1,6}\s/.test(paragraph)) {
      appendUnit(trimmedStart, trimmedEnd)
      continue
    }
    for (const segment of segmenter.segment(paragraph)) {
      appendUnit(
        trimmedStart + segment.index,
        trimmedStart + segment.index + segment.segment.length
      )
    }
  }
  return units
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
  if (!text || text.trim().length === 0) {
    return []
  }
  return splitOrdinaryRange(text, 0, text.length).map((unit) => unit.text)
}

function validateAtomicRanges(text: string, atomicRanges: readonly AtomicTextRange[]): void {
  let previousEnd = 0

  for (const range of atomicRanges) {
    const validOffsets =
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.start < range.end &&
      range.end <= text.length
    const orderedAndNonOverlapping = range.start >= previousEnd

    if (!validOffsets || !orderedAndNonOverlapping) {
      throw new Error(
        `Invalid atomic range [${range.start}, ${range.end}) for text length ${text.length}`
      )
    }
    previousEnd = range.end
  }
}

/**
 * Split ordinary text while preserving the supplied positional ranges as
 * indivisible sentence units.
 */
export function splitIntoSentenceUnits(
  text: string,
  atomicRanges: readonly AtomicTextRange[] = []
): SentenceUnit[] {
  validateAtomicRanges(text, atomicRanges)
  if (atomicRanges.length === 0) {
    return splitOrdinaryRange(text, 0, text.length)
  }

  const units: SentenceUnit[] = []
  let cursor = 0

  for (const range of atomicRanges) {
    units.push(...splitOrdinaryRange(text, cursor, range.start))
    const atomicText = text.slice(range.start, range.end).trim()
    if (!atomicText) {
      throw new Error(`Invalid atomic range [${range.start}, ${range.end}): empty text`)
    }
    units.push({
      text: atomicText,
      atomic: true,
      sourceStart: range.start,
      sourceEnd: range.end,
    })
    cursor = range.end
  }
  units.push(...splitOrdinaryRange(text, cursor, text.length))

  return units
}
