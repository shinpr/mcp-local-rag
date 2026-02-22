import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type RawDataMeta,
  generateMetaJsonPath,
  loadMetaJson,
  saveMetaJson,
} from '../raw-data-utils.js'

describe('meta.json utilities', () => {
  describe('generateMetaJsonPath', () => {
    it('should convert .md path to .meta.json path', () => {
      const result = generateMetaJsonPath('/path/to/abc.md')
      expect(result).toBe('/path/to/abc.meta.json')
    })

    it('should handle paths with multiple dots', () => {
      const result = generateMetaJsonPath('/path/to/my.file.md')
      expect(result).toBe('/path/to/my.file.meta.json')
    })

    it('should only replace trailing .md extension', () => {
      const result = generateMetaJsonPath('/path/md/file.md')
      expect(result).toBe('/path/md/file.meta.json')
    })
  })

  describe('saveMetaJson and loadMetaJson', () => {
    let testDir: string

    beforeEach(async () => {
      testDir = join(tmpdir(), `raw-data-utils-test-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
    })

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true })
    })

    it('should write valid JSON file at derived path', async () => {
      const mdPath = join(testDir, 'test.md')
      const meta: RawDataMeta = {
        title: 'Test Title',
        source: 'https://example.com',
        format: 'html',
      }

      await saveMetaJson(mdPath, meta)

      const metaJsonPath = generateMetaJsonPath(mdPath)
      const content = await readFile(metaJsonPath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed).toEqual(meta)
    })

    it('should read existing .meta.json and return parsed data', async () => {
      const mdPath = join(testDir, 'test.md')
      const meta: RawDataMeta = {
        title: 'Test Title',
        source: 'https://example.com',
        format: 'markdown',
      }

      await saveMetaJson(mdPath, meta)
      const result = await loadMetaJson(mdPath)

      expect(result).toEqual(meta)
    })

    it('should return null for non-existent .meta.json (ENOENT)', async () => {
      const mdPath = join(testDir, 'nonexistent.md')
      const result = await loadMetaJson(mdPath)
      expect(result).toBeNull()
    })

    it('should round-trip: saveMetaJson -> loadMetaJson returns identical data', async () => {
      const mdPath = join(testDir, 'roundtrip.md')
      const meta: RawDataMeta = {
        title: null,
        source: 'clipboard://paste',
        format: 'text',
      }

      await saveMetaJson(mdPath, meta)
      const loaded = await loadMetaJson(mdPath)

      expect(loaded).toEqual(meta)
    })

    it('should re-throw non-ENOENT errors from loadMetaJson', async () => {
      // Use a directory path as the "file" to trigger EISDIR or similar error
      const dirAsFile = join(testDir, 'adir')
      await mkdir(dirAsFile, { recursive: true })
      const mdPath = join(dirAsFile, '') // dirAsFile itself is a directory

      // Reading a directory as a file should throw a non-ENOENT error
      // We need the .meta.json path to point to the directory
      // Create a scenario: mdPath -> metaJsonPath points to something that isn't a normal file
      const fakeMdPath = `${dirAsFile}.md`
      // Create the meta.json path as a directory so readFile fails with EISDIR
      const metaJsonDirPath = generateMetaJsonPath(fakeMdPath)
      await mkdir(metaJsonDirPath, { recursive: true })

      await expect(loadMetaJson(fakeMdPath)).rejects.toThrow()
    })
  })
})
