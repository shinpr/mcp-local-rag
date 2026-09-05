// Sentence Splitter Unit Test
// Created: 2025-12-27
// Purpose: Verify sentence boundary detection using Intl.Segmenter

import { describe, expect, it } from 'vitest'
import { splitIntoSentences, splitIntoSentenceUnits } from '../sentence-splitter.js'

describe('splitIntoSentences', () => {
  // --------------------------------------------
  // Basic sentence splitting (Intl.Segmenter)
  // --------------------------------------------
  describe('Basic splitting', () => {
    it('should split simple sentences', () => {
      const text = 'This is the first sentence. This is the second sentence.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('This is the first sentence.')
      expect(sentences[1]).toBe('This is the second sentence.')
    })

    it('should handle question marks', () => {
      const text = 'What is this? It is a test.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('What is this?')
      expect(sentences[1]).toBe('It is a test.')
    })

    it('should handle exclamation marks', () => {
      const text = 'Hello world! This is exciting.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('Hello world!')
      expect(sentences[1]).toBe('This is exciting.')
    })

    it('should handle decimal numbers correctly', () => {
      const text = 'The value is 3.14 approximately. This is important.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('The value is 3.14 approximately.')
      expect(sentences[1]).toBe('This is important.')
    })
  })

  // --------------------------------------------
  // Intl.Segmenter known limitations
  // --------------------------------------------
  describe('Intl.Segmenter behavior', () => {
    it('may split on abbreviations (known limitation)', () => {
      // Intl.Segmenter follows Unicode rules which may split on abbreviations
      // This is acceptable for semantic chunking as fragments get grouped by similarity
      const text = 'Mr. Smith went to the store. He bought apples.'
      const sentences = splitIntoSentences(text)

      // Intl.Segmenter splits "Mr." as separate segment
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      // All content should be preserved
      expect(sentences.join(' ')).toContain('Mr.')
      expect(sentences.join(' ')).toContain('Smith')
      expect(sentences.join(' ')).toContain('He bought apples.')
    })
  })

  // --------------------------------------------
  // Non-ASCII and multilingual support
  // --------------------------------------------
  describe('Non-ASCII and multilingual support', () => {
    it('should handle non-ASCII text with different punctuation', () => {
      // Tests CJK full-width punctuation (。？) vs ASCII (. ?)
      const text = 'こんにちは。元気ですか？'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('こんにちは。')
      expect(sentences[1]).toBe('元気ですか？')
    })

    it('should handle mixed-script text with language transitions', () => {
      // Tests that Intl.Segmenter handles script changes correctly
      const text = 'This is English. これは日本語です。And back!'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(3)
      expect(sentences[0]).toBe('This is English.')
      expect(sentences[1]).toBe('これは日本語です。')
      expect(sentences[2]).toBe('And back!')
    })
  })

  // --------------------------------------------
  // Code block protection
  // --------------------------------------------
  describe('Code block handling', () => {
    it('should not split inside code blocks', () => {
      const text = `Here is some code:
\`\`\`typescript
const x = 1. This looks like a sentence. But it is code.
\`\`\`
This is after the code block.`
      const sentences = splitIntoSentences(text)

      // Should treat code block as single unit
      expect(sentences.some((s) => s.includes('const x = 1.'))).toBe(true)
      expect(sentences[sentences.length - 1]).toBe('This is after the code block.')
    })

    it('should handle inline code without splitting', () => {
      const text = 'Use `console.log()` for debugging. It prints output.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('Use `console.log()` for debugging.')
      expect(sentences[1]).toBe('It prints output.')
    })

    it('preserves replacement-pattern characters in fenced code', () => {
      const code = 'const replacement = "$& $` $1";'
      const sentences = splitIntoSentences(`Before.\n\n\`\`\`js\n${code}\n\`\`\`\n\nAfter.`)

      expect(sentences.join('\n')).toContain(code)
    })
  })

  // --------------------------------------------
  // Paragraph boundaries
  // --------------------------------------------
  describe('Paragraph handling', () => {
    it('should split on paragraph boundaries', () => {
      const text = 'First paragraph.\n\nSecond paragraph.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('First paragraph.')
      expect(sentences[1]).toBe('Second paragraph.')
    })

    it('should handle multiple newlines', () => {
      const text = 'First paragraph.\n\n\nSecond paragraph.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
    })
  })

  // --------------------------------------------
  // Edge cases
  // --------------------------------------------
  describe('Edge cases', () => {
    it('should return empty array for empty string', () => {
      const sentences = splitIntoSentences('')
      expect(sentences).toEqual([])
    })

    it('should return empty array for whitespace only', () => {
      const sentences = splitIntoSentences('   \n\n   ')
      expect(sentences).toEqual([])
    })

    it('should handle single sentence without period', () => {
      const text = 'This is a sentence without ending punctuation'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(1)
      expect(sentences[0]).toBe('This is a sentence without ending punctuation')
    })

    it('should trim whitespace from sentences', () => {
      const text = '  First sentence.   Second sentence.  '
      const sentences = splitIntoSentences(text)

      expect(sentences[0]).toBe('First sentence.')
      expect(sentences[1]).toBe('Second sentence.')
    })

    it('should filter out empty sentences', () => {
      const text = 'First. . Second.'
      const sentences = splitIntoSentences(text)

      // Should not include empty string from ". ."
      expect(sentences.every((s) => s.length > 0)).toBe(true)
    })
  })

  // --------------------------------------------
  // Markdown heading handling
  // --------------------------------------------
  describe('Markdown headings', () => {
    it('should treat headings as separate sentences', () => {
      const text = '## Section Title\n\nThis is the content.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('## Section Title')
      expect(sentences[1]).toBe('This is the content.')
    })
  })
})

describe('splitIntoSentenceUnits', () => {
  it('keeps a multi-sentence atomic range indivisible and ordered', () => {
    const row = 'Field: 42\nDescription: First sentence. Second sentence.'
    const text = `Before.\n\n${row}\n\nAfter.`
    const start = 'Before.\n\n'.length

    expect(splitIntoSentenceUnits(text, [{ start, end: start + row.length }])).toEqual([
      { text: 'Before.', atomic: false, sourceStart: 0, sourceEnd: 7 },
      { text: row, atomic: true, sourceStart: start, sourceEnd: start + row.length },
      {
        text: 'After.',
        atomic: false,
        sourceStart: start + row.length + 2,
        sourceEnd: text.length,
      },
    ])
  })

  it('preserves repeated atomic text as separate positional units', () => {
    const row = 'Code: 42'
    const text = `${row}\n\n${row}`
    const secondStart = row.length + 2

    expect(
      splitIntoSentenceUnits(text, [
        { start: 0, end: row.length },
        { start: secondStart, end: secondStart + row.length },
      ])
    ).toEqual([
      { text: row, atomic: true, sourceStart: 0, sourceEnd: row.length },
      {
        text: row,
        atomic: true,
        sourceStart: secondStart,
        sourceEnd: secondStart + row.length,
      },
    ])
  })

  it('uses JavaScript UTF-16 offsets for ranges', () => {
    const prefix = '😀 prefix.\n\n'
    const row = '項目: 値。説明: 続き。'
    const text = `${prefix}${row}`

    expect(
      splitIntoSentenceUnits(text, [{ start: prefix.length, end: prefix.length + row.length }])
    ).toEqual([
      { text: '😀 prefix.', atomic: false, sourceStart: 0, sourceEnd: '😀 prefix.'.length },
      {
        text: row,
        atomic: true,
        sourceStart: prefix.length,
        sourceEnd: prefix.length + row.length,
      },
    ])
  })

  it('preserves exact UTF-16 envelopes through repeated inline code, trimming, and whitespace', () => {
    const sentence = 'Repeat `x. y` now.'
    const text = `  ${sentence}  \n\n${sentence} 😀  `
    const units = splitIntoSentenceUnits(text)

    expect(units).toEqual([
      {
        text: sentence,
        atomic: false,
        sourceStart: 2,
        sourceEnd: 2 + sentence.length,
      },
      {
        text: sentence,
        atomic: false,
        sourceStart: text.lastIndexOf(sentence),
        sourceEnd: text.lastIndexOf(sentence) + sentence.length,
      },
      {
        text: '😀',
        atomic: false,
        sourceStart: text.indexOf('😀'),
        sourceEnd: text.indexOf('😀') + '😀'.length,
      },
    ])
    for (const unit of units) {
      expect(text.slice(unit.sourceStart, unit.sourceEnd)).toBe(unit.text)
    }
  })

  it('maps a restored fenced-code sentence to the original range instead of placeholder length', () => {
    const fenced = '```ts\nconst value = "same. same."\n```'
    const text = `  Before code.\n${fenced}\nAfter code.  `
    const units = splitIntoSentenceUnits(text)
    const codeUnit = units.find((unit) => unit.text.includes('const value'))

    expect(codeUnit).toBeDefined()
    expect(codeUnit && text.slice(codeUnit.sourceStart, codeUnit.sourceEnd)).toBe(codeUnit?.text)
    expect(codeUnit?.sourceStart).toBe(text.indexOf(fenced))
    expect(codeUnit?.sourceEnd).toBe(text.indexOf(fenced) + fenced.length)
  })

  it.each([
    ['empty', [{ start: 1, end: 1 }]],
    ['negative', [{ start: -1, end: 2 }]],
    ['non-integer', [{ start: 0.5, end: 2 }]],
    ['out of bounds', [{ start: 0, end: 99 }]],
    [
      'overlapping',
      [
        { start: 0, end: 3 },
        { start: 2, end: 4 },
      ],
    ],
    [
      'unsorted',
      [
        { start: 3, end: 4 },
        { start: 0, end: 2 },
      ],
    ],
  ])('rejects %s atomic ranges before splitting', (_label, ranges) => {
    expect(() => splitIntoSentenceUnits('valid text', ranges)).toThrow(/atomic range/i)
  })
})

it('preserves code and source offsets across many placeholders', () => {
  const lines = Array.from({ length: 64 }, (_, i) => `Use \`symbol_${i}\` with \`$&\` and \`$$\`.`)
  lines.splice(32, 0, '```js\nconst value = "$`";\n```')
  const source = lines.join('\n')
  const units = splitIntoSentenceUnits(source)
  expect(units.map((unit) => unit.text)).toEqual(lines)
  for (const unit of units) {
    expect(source.slice(unit.sourceStart, unit.sourceEnd)).toBe(unit.text)
  }
})
