// Sentence Splitter Unit Test
// Created: 2024-12-27
// Purpose: Verify sentence boundary detection for Max-Min Semantic Chunking

import { describe, expect, it } from 'vitest'
import { splitIntoSentences } from '../sentence-splitter.js'

describe('splitIntoSentences', () => {
  // --------------------------------------------
  // English sentence splitting
  // --------------------------------------------
  describe('English text', () => {
    it('should split simple English sentences', () => {
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

    it('should not split on abbreviations like Mr. or Dr.', () => {
      const text = 'Mr. Smith went to the store. He bought apples.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('Mr. Smith went to the store.')
      expect(sentences[1]).toBe('He bought apples.')
    })

    it('should not split on decimal numbers', () => {
      const text = 'The value is 3.14 approximately. This is important.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('The value is 3.14 approximately.')
      expect(sentences[1]).toBe('This is important.')
    })
  })

  // --------------------------------------------
  // Japanese sentence splitting
  // --------------------------------------------
  describe('Japanese text', () => {
    it('should split on Japanese period', () => {
      const text = 'これは最初の文です。これは二番目の文です。'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('これは最初の文です。')
      expect(sentences[1]).toBe('これは二番目の文です。')
    })

    it('should handle Japanese question marks', () => {
      const text = 'これは何ですか？テストです。'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('これは何ですか？')
      expect(sentences[1]).toBe('テストです。')
    })

    it('should handle Japanese exclamation marks', () => {
      const text = 'すごい！これは素晴らしい。'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(2)
      expect(sentences[0]).toBe('すごい！')
      expect(sentences[1]).toBe('これは素晴らしい。')
    })
  })

  // --------------------------------------------
  // Mixed language text
  // --------------------------------------------
  describe('Mixed language text', () => {
    it('should handle mixed English and Japanese', () => {
      const text = 'This is English. これは日本語です。Back to English.'
      const sentences = splitIntoSentences(text)

      expect(sentences).toHaveLength(3)
      expect(sentences[0]).toBe('This is English.')
      expect(sentences[1]).toBe('これは日本語です。')
      expect(sentences[2]).toBe('Back to English.')
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
