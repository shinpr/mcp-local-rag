// JSON Parser Unit Test

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DocumentParser, FileOperationError } from '../index'

describe('JSON Parser', () => {
  let parser: DocumentParser
  const testDir = join(process.cwd(), 'tmp', 'test-json-parser')
  const maxFileSize = 100 * 1024 * 1024 // 100MB

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    parser = new DocumentParser({
      baseDir: testDir,
      maxFileSize,
    })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('parseFile with .json extension', () => {
    it('should parse simple flat JSON', async () => {
      const filePath = join(testDir, 'simple.json')
      const content = { name: 'John', age: 30, active: true }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('name: John')
      expect(result).toContain('age: 30')
      expect(result).toContain('active: true')
    })

    it('should parse nested objects with dot notation', async () => {
      const filePath = join(testDir, 'nested.json')
      const content = {
        user: {
          name: 'Alice',
          address: {
            city: 'Seattle',
            zip: '98101',
          },
        },
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('user.name: Alice')
      expect(result).toContain('user.address.city: Seattle')
      expect(result).toContain('user.address.zip: 98101')
    })

    it('should parse arrays of primitives as comma-separated values', async () => {
      const filePath = join(testDir, 'array-primitives.json')
      const content = {
        name: 'John',
        traits: ['brave', 'kind', 'loyal'],
        scores: [95, 87, 92],
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('name: John')
      expect(result).toContain('traits: brave, kind, loyal')
      expect(result).toContain('scores: 95, 87, 92')
    })

    it('should parse arrays of objects with indices', async () => {
      const filePath = join(testDir, 'array-objects.json')
      const content = {
        characters: [
          { name: 'Alice', role: 'protagonist' },
          { name: 'Bob', role: 'antagonist' },
        ],
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('characters[0].name: Alice')
      expect(result).toContain('characters[0].role: protagonist')
      expect(result).toContain('characters[1].name: Bob')
      expect(result).toContain('characters[1].role: antagonist')
    })

    it('should handle null values', async () => {
      const filePath = join(testDir, 'null-values.json')
      const content = {
        name: 'Test',
        value: null,
        nested: { inner: null },
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('name: Test')
      expect(result).toContain('value: null')
      expect(result).toContain('nested.inner: null')
    })

    it('should handle empty arrays', async () => {
      const filePath = join(testDir, 'empty-array.json')
      const content = {
        name: 'Test',
        items: [],
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('name: Test')
      expect(result).toContain('items: []')
    })

    it('should handle empty objects', async () => {
      const filePath = join(testDir, 'empty-object.json')
      const content = {}
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toBe('')
    })

    it('should handle special characters in values', async () => {
      const filePath = join(testDir, 'special-chars.json')
      const content = {
        description: 'Line 1\nLine 2',
        quote: 'He said "Hello"',
        path: '/usr/local/bin',
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('description: Line 1\nLine 2')
      expect(result).toContain('quote: He said "Hello"')
      expect(result).toContain('path: /usr/local/bin')
    })

    it('should handle deeply nested structures', async () => {
      const filePath = join(testDir, 'deep-nested.json')
      const content = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
              },
            },
          },
        },
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('level1.level2.level3.level4.value: deep')
    })

    it('should handle mixed content (objects and arrays)', async () => {
      const filePath = join(testDir, 'mixed.json')
      const content = {
        title: 'Book',
        chapters: [
          {
            number: 1,
            scenes: ['opening', 'conflict'],
          },
          {
            number: 2,
            scenes: ['resolution'],
          },
        ],
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('title: Book')
      expect(result).toContain('chapters[0].number: 1')
      expect(result).toContain('chapters[0].scenes: opening, conflict')
      expect(result).toContain('chapters[1].number: 2')
      expect(result).toContain('chapters[1].scenes: resolution')
    })

    it('should handle boolean values', async () => {
      const filePath = join(testDir, 'booleans.json')
      const content = {
        active: true,
        deleted: false,
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('active: true')
      expect(result).toContain('deleted: false')
    })

    it('should handle numeric values including zero', async () => {
      const filePath = join(testDir, 'numbers.json')
      const content = {
        count: 0,
        price: 19.99,
        negative: -5,
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('count: 0')
      expect(result).toContain('price: 19.99')
      expect(result).toContain('negative: -5')
    })
  })

  describe('error handling', () => {
    it('should throw FileOperationError for invalid JSON syntax', async () => {
      const filePath = join(testDir, 'invalid.json')
      await writeFile(filePath, '{ invalid json }', 'utf-8')

      await expect(parser.parseFile(filePath)).rejects.toThrow(
        expect.objectContaining({
          name: 'FileOperationError',
          message: expect.stringMatching(/invalid syntax/),
        })
      )
    })

    it('should throw FileOperationError for non-existent JSON file', async () => {
      const filePath = join(testDir, 'nonexistent.json')

      await expect(parser.parseFile(filePath)).rejects.toThrow(FileOperationError)
    })

    it('should handle JSON with only a primitive value at root', async () => {
      const filePath = join(testDir, 'primitive-root.json')
      await writeFile(filePath, '"just a string"', 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toBe('just a string')
    })

    it('should handle JSON array at root level', async () => {
      const filePath = join(testDir, 'array-root.json')
      await writeFile(filePath, '[1, 2, 3]', 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toBe('1, 2, 3')
    })

    it('should handle JSON array of objects at root level', async () => {
      const filePath = join(testDir, 'array-objects-root.json')
      const content = [
        { id: 1, name: 'First' },
        { id: 2, name: 'Second' },
      ]
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('[0].id: 1')
      expect(result).toContain('[0].name: First')
      expect(result).toContain('[1].id: 2')
      expect(result).toContain('[1].name: Second')
    })
  })

  describe('large JSON handling', () => {
    it('should handle JSON with many keys', async () => {
      const filePath = join(testDir, 'many-keys.json')
      const content: Record<string, number> = {}
      for (let i = 0; i < 100; i++) {
        content[`key${i}`] = i
      }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain('key0: 0')
      expect(result).toContain('key50: 50')
      expect(result).toContain('key99: 99')
    })

    it('should handle JSON with long string values', async () => {
      const filePath = join(testDir, 'long-string.json')
      const longValue = 'x'.repeat(10000)
      const content = { description: longValue }
      await writeFile(filePath, JSON.stringify(content), 'utf-8')

      const result = await parser.parseFile(filePath)

      expect(result).toContain(`description: ${longValue}`)
      expect(result.length).toBeGreaterThan(10000)
    })
  })
})
