import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testModelCacheDir, withTestDevice } from '../../__tests__/test-device.js'
import type { VectorChunk, VectorStore } from '../../vectordb/index.js'
import { RAGServer } from '../index.js'

function createTestRagServer(config: ConstructorParameters<typeof RAGServer>[0]): RAGServer {
  return new RAGServer(withTestDevice(config))
}

function getVectorStore(server: RAGServer): VectorStore {
  return (server as unknown as { vectorStore: VectorStore }).vectorStore
}

describe('read_chunk_neighbors performance', () => {
  let ragServer: RAGServer
  const testDbPath = resolve('./tmp/test-lancedb-read-neighbors-perf')
  const testDataDir = resolve('./tmp/test-data-read-neighbors-perf')
  const syntheticFilePath = resolve(testDataDir, 'read-neighbors-perf.txt')

  beforeAll(async () => {
    mkdirSync(testDbPath, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    writeFileSync(syntheticFilePath, 'placeholder')
    ragServer = createTestRagServer({
      dbPath: testDbPath,
      modelName: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: testModelCacheDir(),
      baseDir: testDataDir,
      maxFileSize: 100 * 1024 * 1024,
    })
    await ragServer.initialize()

    const vectorStore = getVectorStore(ragServer)
    const timestamp = new Date().toISOString()
    const vector = new Array(384).fill(0.01)
    for (let start = 0; start < 10_000; start += 1_000) {
      const batch: VectorChunk[] = []
      for (let index = start; index < start + 1_000; index++) {
        batch.push({
          id: randomUUID(),
          filePath: syntheticFilePath,
          chunkIndex: index,
          text: `synthetic chunk ${index}`,
          vector,
          metadata: { fileName: 'read-neighbors-perf.txt', fileSize: 0, fileType: 'txt' },
          fileTitle: null,
          timestamp,
        })
      }
      await vectorStore.insertChunks(batch)
    }
    await vectorStore.optimize()
  }, 120_000)

  afterAll(async () => {
    await ragServer.close()
    rmSync(testDbPath, { recursive: true, force: true })
    rmSync(testDataDir, { recursive: true, force: true })
  })

  it('keeps P95 below 100 ms for a 10,000-chunk document', async () => {
    for (const chunkIndex of [100, 5_000, 9_500]) {
      await ragServer.handleReadChunkNeighbors({ filePath: syntheticFilePath, chunkIndex })
    }

    const timings: number[] = []
    for (let iteration = 0; iteration < 4; iteration++) {
      for (const chunkIndex of [50, 2_500, 5_000, 7_500, 9_950]) {
        const start = performance.now()
        await ragServer.handleReadChunkNeighbors({ filePath: syntheticFilePath, chunkIndex })
        timings.push(performance.now() - start)
      }
    }

    const p95 = [...timings].sort((a, b) => a - b)[18] ?? Number.NaN
    console.error(`P95: ${p95.toFixed(2)} ms`)
    expect(Number.isFinite(p95)).toBe(true)
    expect(
      p95,
      `P95 latency ${p95.toFixed(2)} ms exceeds 100 ms. Timings: ${JSON.stringify(timings)}`
    ).toBeLessThan(100)
  })
})
