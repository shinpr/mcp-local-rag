import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../utils/type-guards.js'
import type { PersistentEmbeddingProvider } from '../embedding-snapshot.js'
import {
  DocumentEmbeddingSession,
  embeddingSnapshotPath,
  MAX_EMBEDDING_SNAPSHOT_BYTES,
  removeEmbeddingSnapshot,
} from '../embedding-snapshot.js'
import type { EmbeddingComputationIdentity, EmbeddingRole } from '../index.js'

const TEST_ROOT = resolve('./tmp/test-embedding-snapshot')
const IDENTITY: EmbeddingComputationIdentity = {
  fingerprint: 'a'.repeat(64),
  dimension: 3,
}

function createEmbedder(identity: EmbeddingComputationIdentity | null = IDENTITY): {
  embedder: PersistentEmbeddingProvider
  calls: { role: 'document' | 'query' | undefined; texts: string[] }[]
} {
  const calls: { role: 'document' | 'query' | undefined; texts: string[] }[] = []
  const embedder: PersistentEmbeddingProvider = {
    getComputationIdentity: async () => identity,
    embedBatch: async (texts: string[], role?: EmbeddingRole) => {
      calls.push({ role, texts: [...texts] })
      return texts.map((text) => [text.length, role === 'document' ? 2 : 1, 3])
    },
    getTokenLimit: async () => 512,
    countTokens: async (texts: string[]) => texts.map((text) => text.length),
    getDocumentPrompt: async () => 'D: ',
    titlePrefix: true,
    headingPrefix: false,
  }
  return { embedder, calls }
}

function readSnapshotEnvelope(path: string): Record<string, unknown> {
  const value: unknown = deserialize(readFileSync(path))
  if (!isRecord(value)) {
    throw new Error('Expected a serialized snapshot object')
  }
  return value
}

function replaceFirstSnapshotVector(envelope: Record<string, unknown>, vector: Float32Array): void {
  const entries = envelope['entries']
  const firstEntry = Array.isArray(entries) ? entries[0] : undefined
  if (!Array.isArray(firstEntry)) {
    throw new Error('Expected a serialized snapshot entry')
  }
  firstEntry[1] = vector
}

describe('DocumentEmbeddingSession', () => {
  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('reuses exact inputs after a process-style session boundary and preserves order and duplicates', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'docs', 'guide.md')
    mkdirSync(join(TEST_ROOT, 'docs'), { recursive: true })
    writeFileSync(filePath, 'source')
    const first = createEmbedder()
    const firstSession = new DocumentEmbeddingSession(dbPath, filePath, first.embedder)

    const original = await firstSession.embedBatch(
      ['unchanged', 'old sentence', 'unchanged'],
      'document'
    )
    await firstSession.publish()
    firstSession.dispose()

    const restarted = createEmbedder()
    const secondSession = new DocumentEmbeddingSession(dbPath, filePath, restarted.embedder)
    const edited = await secondSession.embedBatch(
      ['old sentence', 'changed sentence', 'unchanged', 'old sentence'],
      'document'
    )

    expect(original).toEqual([
      [9, 2, 3],
      [12, 2, 3],
      [9, 2, 3],
    ])
    expect(edited).toEqual([
      [12, 2, 3],
      [16, 2, 3],
      [9, 2, 3],
      [12, 2, 3],
    ])
    expect(restarted.calls).toEqual([{ role: 'document', texts: ['changed sentence'] }])
    expect(readFileSync(embeddingSnapshotPath(dbPath, filePath)).byteLength).toBeGreaterThan(0)

    await secondSession.publish()
    secondSession.dispose()
  })

  it('isolates role and computation-fingerprint changes', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'same.md')
    const first = createEmbedder()
    const firstSession = new DocumentEmbeddingSession(dbPath, filePath, first.embedder)
    await firstSession.embedBatch(['same text'], 'document')
    await firstSession.publish()
    firstSession.dispose()

    const changedIdentity = createEmbedder({ fingerprint: 'b'.repeat(64), dimension: 3 })
    const changedSession = new DocumentEmbeddingSession(dbPath, filePath, changedIdentity.embedder)
    await changedSession.embedBatch(['same text'], 'document')
    expect(changedIdentity.calls).toEqual([{ role: 'document', texts: ['same text'] }])
    changedSession.dispose()

    const changedRole = createEmbedder()
    const roleSession = new DocumentEmbeddingSession(dbPath, filePath, changedRole.embedder)
    await roleSession.embedBatch(['same text'])
    expect(changedRole.calls).toEqual([{ role: undefined, texts: ['same text'] }])
    roleSession.dispose()
  })

  it('removes only the exact indexed path snapshot', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const firstPath = join(TEST_ROOT, 'one.md')
    const otherPath = join(TEST_ROOT, 'two.md')
    const first = new DocumentEmbeddingSession(dbPath, firstPath, createEmbedder().embedder)
    const second = new DocumentEmbeddingSession(dbPath, otherPath, createEmbedder().embedder)
    await first.embedBatch(['one'])
    await second.embedBatch(['two'])
    await Promise.all([first.publish(), second.publish()])

    await removeEmbeddingSnapshot(dbPath, firstPath)

    expect(() => readFileSync(embeddingSnapshotPath(dbPath, firstPath))).toThrow()
    expect(readFileSync(embeddingSnapshotPath(dbPath, otherPath)).byteLength).toBeGreaterThan(0)
    first.dispose()
    second.dispose()
  })

  it.each(['truncated', 'incompatible', 'oversized'] as const)(
    'treats a %s snapshot as a miss and recomputes current output',
    async (kind) => {
      const dbPath = join(TEST_ROOT, 'db')
      const filePath = join(TEST_ROOT, 'document.md')
      const path = embeddingSnapshotPath(dbPath, filePath)
      mkdirSync(join(path, '..'), { recursive: true })
      let contents: Buffer
      if (kind === 'truncated') {
        contents = Buffer.from([0, 1, 2])
      } else if (kind === 'incompatible') {
        contents = serialize({ formatVersion: 99, fingerprint: IDENTITY.fingerprint })
      } else {
        contents = Buffer.alloc(MAX_EMBEDDING_SNAPSHOT_BYTES + 1)
      }
      writeFileSync(path, contents)

      const current = createEmbedder()
      const session = new DocumentEmbeddingSession(dbPath, filePath, current.embedder)
      await expect(session.embedBatch(['current input'])).resolves.toEqual([[13, 1, 3]])
      expect(current.calls).toEqual([{ role: undefined, texts: ['current input'] }])
      session.dispose()
    }
  )

  it('skips persistence when identity is unavailable and propagates genuine inference errors', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'same.md')
    const original = createEmbedder()
    const first = new DocumentEmbeddingSession(dbPath, filePath, original.embedder)
    await first.embedBatch(['same input'])
    await first.publish()
    const previous = readFileSync(embeddingSnapshotPath(dbPath, filePath))

    const unavailable = createEmbedder(null)
    const noIdentity = new DocumentEmbeddingSession(dbPath, filePath, unavailable.embedder)
    await expect(noIdentity.embedBatch(['same input'])).resolves.toEqual([[10, 1, 3]])
    await noIdentity.publish()
    expect(readFileSync(embeddingSnapshotPath(dbPath, filePath))).toEqual(previous)

    const failing = createEmbedder()
    failing.embedder.embedBatch = async () => {
      throw new Error('model inference failed')
    }
    const failureSession = new DocumentEmbeddingSession(dbPath, filePath, failing.embedder)
    await expect(failureSession.embedBatch(['unavailable input'])).rejects.toThrow(
      'model inference failed'
    )
    failureSession.dispose()
  })

  it('does not wait for asset identity hashing when the document has no previous snapshot', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'cold.md')
    const current = createEmbedder()
    let settleIdentity: (value: EmbeddingComputationIdentity) => void = () => {}
    const identityPromise = new Promise<EmbeddingComputationIdentity>((settle) => {
      settleIdentity = settle
    })
    const getComputationIdentity = vi.fn(() => identityPromise)
    current.embedder.getComputationIdentity = getComputationIdentity

    const session = new DocumentEmbeddingSession(dbPath, filePath, current.embedder)
    await expect(session.embedBatch(['cold input'])).resolves.toEqual([[10, 1, 3]])
    expect(getComputationIdentity).not.toHaveBeenCalled()
    expect(current.calls).toEqual([{ role: undefined, texts: ['cold input'] }])

    settleIdentity(IDENTITY)
    await session.publish()
    expect(getComputationIdentity).toHaveBeenCalledOnce()
    expect(readFileSync(embeddingSnapshotPath(dbPath, filePath)).byteLength).toBeGreaterThan(0)
    session.dispose()
  })

  it('treats an unreadable snapshot as a miss and keeps the computed result', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'unreadable.md')
    const path = embeddingSnapshotPath(dbPath, filePath)
    mkdirSync(path, { recursive: true })
    const current = createEmbedder()
    const session = new DocumentEmbeddingSession(dbPath, filePath, current.embedder)
    await expect(session.embedBatch(['current input'])).resolves.toEqual([[13, 1, 3]])
    expect(current.calls).toEqual([{ role: undefined, texts: ['current input'] }])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(session.publish()).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalled()
    warning.mockRestore()
  })

  it('reloads complete current output after competing publishers replace one snapshot', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'concurrent.md')
    const firstText = 'first publisher input'
    const secondText = 'second publisher input'
    const first = createEmbedder()
    const second = createEmbedder()
    const firstSession = new DocumentEmbeddingSession(dbPath, filePath, first.embedder)
    const secondSession = new DocumentEmbeddingSession(dbPath, filePath, second.embedder)

    await expect(firstSession.embedBatch([firstText])).resolves.toEqual([[firstText.length, 1, 3]])
    await expect(secondSession.embedBatch([secondText])).resolves.toEqual([
      [secondText.length, 1, 3],
    ])
    await Promise.all([firstSession.publish(), secondSession.publish()])

    const envelope = readSnapshotEnvelope(embeddingSnapshotPath(dbPath, filePath))
    expect(envelope['entries']).toHaveLength(1)

    const restarted = createEmbedder()
    const reader = new DocumentEmbeddingSession(dbPath, filePath, restarted.embedder)
    await expect(reader.embedBatch([firstText, secondText])).resolves.toEqual([
      [firstText.length, 1, 3],
      [secondText.length, 1, 3],
    ])
    expect(restarted.calls).toHaveLength(1)
    expect(restarted.calls[0]?.texts).toHaveLength(1)

    firstSession.dispose()
    secondSession.dispose()
    reader.dispose()
  })

  it.each(['wrong dimension', 'non-finite'] as const)(
    'rejects a stored vector with %s and recomputes current output',
    async (corruption) => {
      const dbPath = join(TEST_ROOT, 'db')
      const filePath = join(TEST_ROOT, `corrupt-${corruption}.md`)
      const original = createEmbedder()
      const writer = new DocumentEmbeddingSession(dbPath, filePath, original.embedder)
      await writer.embedBatch(['current value'])
      await writer.publish()

      const path = embeddingSnapshotPath(dbPath, filePath)
      const envelope = readSnapshotEnvelope(path)
      replaceFirstSnapshotVector(
        envelope,
        corruption === 'wrong dimension'
          ? new Float32Array([8, 9])
          : new Float32Array([8, 9, Number.NaN])
      )
      writeFileSync(path, serialize(envelope))

      const current = createEmbedder()
      const reader = new DocumentEmbeddingSession(dbPath, filePath, current.embedder)
      await expect(reader.embedBatch(['current value'])).resolves.toEqual([[13, 1, 3]])
      expect(current.calls).toEqual([{ role: undefined, texts: ['current value'] }])

      writer.dispose()
      reader.dispose()
    }
  )

  it('returns all current outputs when a document exceeds the persistence bound', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'oversized.md')
    const dimension = 2_200_000
    const texts = ['large first vector', 'large second vector']
    const calls: string[][] = []
    const oversized: PersistentEmbeddingProvider = {
      getComputationIdentity: async () => ({ fingerprint: 'c'.repeat(64), dimension }),
      embedBatch: async (requested) => {
        calls.push([...requested])
        return requested.map((text) => Array<number>(dimension).fill(text.length))
      },
    }
    const session = new DocumentEmbeddingSession(dbPath, filePath, oversized)

    const result = await session.embedBatch(texts)

    expect(result).toHaveLength(texts.length)
    expect(result.map((vector) => vector.length)).toEqual([dimension, dimension])
    expect(result.map((vector) => [vector[0], vector.at(-1)])).toEqual(
      texts.map((text) => [text.length, text.length])
    )
    expect(calls).toEqual([texts])
    await session.publish()
    expect(() => readFileSync(embeddingSnapshotPath(dbPath, filePath))).toThrow()
    session.dispose()
  })

  it('replaces the snapshot with only the current request set', async () => {
    const dbPath = join(TEST_ROOT, 'db')
    const filePath = join(TEST_ROOT, 'latest-only.md')
    const previous = createEmbedder()
    const first = new DocumentEmbeddingSession(dbPath, filePath, previous.embedder)
    await first.embedBatch(['old input', 'still old input'])
    await first.publish()

    const current = createEmbedder()
    const latest = new DocumentEmbeddingSession(dbPath, filePath, current.embedder)
    await expect(latest.embedBatch(['latest input'])).resolves.toEqual([[12, 1, 3]])
    expect(current.calls).toEqual([{ role: undefined, texts: ['latest input'] }])
    await latest.publish()

    const path = embeddingSnapshotPath(dbPath, filePath)
    expect(readSnapshotEnvelope(path)['entries']).toHaveLength(1)

    const restarted = createEmbedder()
    const verifyLatest = new DocumentEmbeddingSession(dbPath, filePath, restarted.embedder)
    await expect(verifyLatest.embedBatch(['latest input'])).resolves.toEqual([[12, 1, 3]])
    expect(restarted.calls).toEqual([])
    await expect(verifyLatest.embedBatch(['old input'])).resolves.toEqual([[9, 1, 3]])
    expect(restarted.calls).toEqual([{ role: undefined, texts: ['old input'] }])

    first.dispose()
    latest.dispose()
    verifyLatest.dispose()
  })
})
