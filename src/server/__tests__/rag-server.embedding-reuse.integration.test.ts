import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { privateMembers } from '../../__tests__/test-doubles.js'
import type { PersistentEmbeddingProvider } from '../../embedder/embedding-snapshot.js'
import { embeddingSnapshotPath } from '../../embedder/embedding-snapshot.js'
import type { Embedder, EmbeddingRole } from '../../embedder/index.js'
import { generateRawDataPath } from '../../utils/raw-data-utils.js'
import { RAGServer } from '../index.js'
import type { RAGServerConfig } from '../types.js'

const TEST_ROOT = resolve('./tmp/test-rag-server-embedding-reuse')
const IDENTITY = { fingerprint: 'c'.repeat(64), dimension: 3 }
const STABLE_SENTENCE =
  'Stable unchanged sentence about ingestion settings and storage boundaries remains exactly the same.'
const ORIGINAL_SENTENCE =
  'Original sentence explains the previous revision and its indexing workflow in careful detail.'
const UPDATED_SENTENCE =
  'Updated sentence explains the replacement revision and its indexing workflow in careful detail.'

type EmbedCall = { role: 'document' | 'query' | undefined; texts: string[] }

function makeEmbedder(
  calls: EmbedCall[]
): PersistentEmbeddingProvider & Pick<Embedder, 'embed' | 'dispose'> {
  return {
    async getComputationIdentity() {
      return IDENTITY
    },
    async embedBatch(texts: string[], role?: EmbeddingRole) {
      calls.push({ role, texts: [...texts] })
      return texts.map((text) => {
        const digest = createHash('sha256')
          .update(`${role ?? 'default'}:${text}`)
          .digest()
        const vector = [0, 1, 2].map((index) => digest.readUInt8(index) / 127.5 - 1)
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
        return vector.map((value) => value / norm)
      })
    },
    async embed(text: string, role?: 'query' | 'document') {
      const [vector] = await this.embedBatch([text], role)
      return vector ?? []
    },
    async dispose() {},
    async getTokenLimit() {
      return null
    },
    async countTokens(texts: string[]) {
      return texts.map((text) => text.length)
    },
    async getDocumentPrompt() {
      return ''
    },
  }
}

async function makeServer(dbPath: string, baseDir: string, calls: EmbedCall[]): Promise<RAGServer> {
  const config: RAGServerConfig = {
    dbPath,
    modelName: 'Xenova/all-MiniLM-L6-v2',
    cacheDir: join(TEST_ROOT, 'model-cache'),
    maxFileSize: 10 * 1024 * 1024,
    baseDir,
    device: 'cpu',
  }
  const server = new RAGServer(config)
  Object.assign(privateMembers<{ embedder: Embedder }>(server).embedder, makeEmbedder(calls))
  await server.initialize()
  return server
}

describe('MCP ingestion embedding reuse across server restarts', () => {
  afterAll(async () => await rm(TEST_ROOT, { recursive: true, force: true }))

  it.each(['file', 'raw-data'] as const)(
    'reuses unchanged inputs for %s ingestion after a server restart',
    async (kind) => {
      const caseRoot = join(TEST_ROOT, kind)
      const dbPath = join(caseRoot, 'db')
      const baseDir = join(caseRoot, 'docs')
      const filePath = join(baseDir, 'reuse.txt')
      await rm(caseRoot, { recursive: true, force: true })
      await mkdir(baseDir, { recursive: true })

      const firstCalls: EmbedCall[] = []
      const firstServer = await makeServer(dbPath, baseDir, firstCalls)
      try {
        if (kind === 'file') {
          await writeFile(filePath, `${STABLE_SENTENCE} ${ORIGINAL_SENTENCE}`)
          await firstServer.handleIngestFile({ filePath })
        } else {
          await firstServer.handleIngestData({
            content: `${STABLE_SENTENCE} ${ORIGINAL_SENTENCE}`,
            metadata: { source: 'https://example.com/embedding-reuse', format: 'text' },
          })
        }
      } finally {
        await firstServer.close()
      }

      const indexedPath =
        kind === 'file'
          ? filePath
          : generateRawDataPath(dbPath, 'https://example.com/embedding-reuse')
      const snapshotPath = embeddingSnapshotPath(dbPath, indexedPath)
      expect(
        firstCalls.some((call) => call.texts.some((text) => text.includes(STABLE_SENTENCE)))
      ).toBe(true)

      const secondCalls: EmbedCall[] = []
      const secondServer = await makeServer(dbPath, baseDir, secondCalls)
      try {
        if (kind === 'file') {
          await writeFile(filePath, `${STABLE_SENTENCE} ${UPDATED_SENTENCE}`)
          await secondServer.handleIngestFile({ filePath })
        } else {
          await secondServer.handleIngestData({
            content: `${STABLE_SENTENCE} ${UPDATED_SENTENCE}`,
            metadata: { source: 'https://example.com/embedding-reuse', format: 'text' },
          })
        }
      } finally {
        await secondServer.close()
      }

      expect(
        secondCalls.some(
          (call) =>
            call.role === undefined && call.texts.some((text) => text.includes(STABLE_SENTENCE))
        )
      ).toBe(false)
      expect(
        secondCalls.some(
          (call) =>
            call.role === undefined && call.texts.some((text) => text.includes(UPDATED_SENTENCE))
        )
      ).toBe(true)
      expect(secondCalls.some((call) => call.role === 'document')).toBe(true)
      expect(existsSync(snapshotPath)).toBe(true)
    }
  )
})
