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
  segments: MappingSegment[]
}

interface MappingSegment {
  mappedStart: number
  mappedEnd: number
  sourceStart: number
  sourceEnd: number
  linear: boolean
}

// ============================================
// Helper Functions
// ============================================

function maskCode(
  text: string,
  sourceStart: number
): { mapped: MappedText; blocks: CodeBlockInfo[] } {
  const blocks: CodeBlockInfo[] = []
  const fenced = [...text.matchAll(/```[\s\S]*?```/g)].flatMap((match) =>
    match.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }]
  )
  const matchedRanges = [...fenced]
  let gapStart = 0
  for (const fencedRange of [...fenced, { start: text.length, end: text.length }]) {
    const gap = text.slice(gapStart, fencedRange.start)
    for (const match of gap.matchAll(/`[^`]+`/g)) {
      if (match.index === undefined) continue
      matchedRanges.push({
        start: gapStart + match.index,
        end: gapStart + match.index + match[0].length,
      })
    }
    gapStart = fencedRange.end
  }
  matchedRanges.sort((left, right) => left.start - right.start)

  let mappedText = ''
  let cursor = 0
  const segments: MappingSegment[] = []
  const append = (value: string, start: number, end: number, linear: boolean): void => {
    const mappedStart = mappedText.length
    mappedText += value
    segments.push({
      mappedStart,
      mappedEnd: mappedText.length,
      sourceStart: sourceStart + start,
      sourceEnd: sourceStart + end,
      linear,
    })
  }
  for (const [index, range] of matchedRanges.entries()) {
    if (range.start > cursor) append(text.slice(cursor, range.start), cursor, range.start, true)
    const content = text.slice(range.start, range.end)
    const placeholderPrefix = content.startsWith('```')
      ? CODE_BLOCK_PLACEHOLDER
      : INLINE_CODE_PLACEHOLDER
    const placeholder = `${placeholderPrefix}${index}${placeholderPrefix}`
    blocks.push({ placeholder, content })
    append(placeholder, range.start, range.end, false)
    cursor = range.end
  }
  if (cursor < text.length) append(text.slice(cursor), cursor, text.length, true)
  return { mapped: { text: mappedText, segments }, blocks }
}

function sourceOffsetAt(mapped: MappedText, offset: number, fallback: number): number {
  let low = 0
  let high = mapped.segments.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const segment = mapped.segments[middle] as MappingSegment
    if (offset < segment.mappedStart) {
      high = middle - 1
    } else if (offset > segment.mappedEnd) {
      low = middle + 1
    } else if (offset === segment.mappedEnd) {
      return segment.sourceEnd
    } else {
      return segment.linear
        ? segment.sourceStart + (offset - segment.mappedStart)
        : segment.sourceStart
    }
  }
  return fallback
}

function restoreCode(text: string, blocks: CodeBlockInfo[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL delimiters identify masked code placeholders.
  const placeholderPattern = /(\u0000(?:CODE_BLOCK|INLINE_CODE)\u0000)(\d+)\1/g
  return text.replace(placeholderPattern, (placeholder, _prefix, index: string) => {
    const block = blocks[Number(index)]
    return block?.placeholder === placeholder ? block.content : placeholder
  })
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
      sourceStart: sourceOffsetAt(mapped, trimmedStart, sourceStart),
      sourceEnd: sourceOffsetAt(mapped, trimmedEnd, sourceEnd),
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
