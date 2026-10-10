import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { EmbeddingComputationIdentity, EmbeddingRole } from './index.js'

export const MAX_EMBEDDING_SNAPSHOT_BYTES = 16 * 1024 * 1024
const SNAPSHOT_FORMAT_VERSION = 1
const ENTRY_OVERHEAD_BYTES = 96

interface SnapshotEnvelope {
  formatVersion: number
  fingerprint: string
  dimension: number
  entries: [string, Float32Array][]
}

type SnapshotVector = Float32Array | number[]

interface EmbeddingBatchRequest {
  texts: string[]
  role: EmbeddingRole | undefined
  results: (number[] | undefined)[]
  requestedKeys: string[]
  missingInputs: Map<string, string>
}

export interface PersistentEmbeddingProvider extends EmbedderInterface {
  embedBatch(texts: string[], role?: EmbeddingRole): Promise<number[][]>
  getComputationIdentity(): Promise<EmbeddingComputationIdentity | null>
}

/** Exact indexed path identity is shared by CLI and MCP for the same DB key. */
export function embeddingSnapshotPath(dbPath: string, filePath: string): string {
  const digest = createHash('sha256').update(filePath).digest('hex')
  return join(resolve(dbPath), 'embedding-cache', `${digest}.bin`)
}

/** Best-effort cleanup: a missing or inaccessible acceleration file is harmless. */
export async function removeEmbeddingSnapshot(dbPath: string, filePath: string): Promise<void> {
  try {
    await unlink(embeddingSnapshotPath(dbPath, filePath))
  } catch {
    // Snapshot cleanup must not change the adapter's deletion result.
  }
}

/**
 * One ingestion's read/collect/publish state. It owns no shared Embedder state
 * and is discarded by the composition root after that file's DB mutation.
 */
export class DocumentEmbeddingSession implements EmbedderInterface {
  private readonly snapshotPath: string
  private readonly embedder: PersistentEmbeddingProvider
  private identity: EmbeddingComputationIdentity | null = null
  private loaded: boolean = false
  private collecting: boolean = true
  private disposed: boolean = false
  private collectedBytes = 0
  private readonly previous = new Map<string, Float32Array>()
  private readonly collected = new Map<string, Float32Array>()

  constructor(dbPath: string, filePath: string, embedder: PersistentEmbeddingProvider) {
    this.snapshotPath = embeddingSnapshotPath(dbPath, filePath)
    this.embedder = embedder
  }

  get titlePrefix(): boolean {
    return this.embedder.titlePrefix ?? false
  }

  get headingPrefix(): boolean {
    return this.embedder.headingPrefix ?? false
  }

  async getTokenLimit(): Promise<number | null> {
    return (await this.embedder.getTokenLimit?.()) ?? null
  }

  async countTokens(texts: string[], role?: 'document'): Promise<number[]> {
    if (!this.embedder.countTokens) {
      return []
    }
    return await this.embedder.countTokens(texts, role)
  }

  async getDocumentPrompt(): Promise<string> {
    return (await this.embedder.getDocumentPrompt?.()) ?? ''
  }

  async embedBatch(texts: string[], role?: EmbeddingRole): Promise<number[][]> {
    if (this.disposed || texts.length === 0) {
      return await this.embedder.embedBatch(texts, role)
    }

    const identity = await this.loadPreviousIfPresent()
    if (!identity) {
      return await this.embedAndCollectWithoutPrevious(texts, role)
    }

    return await this.embedWithPrevious(texts, role, identity)
  }

  private async embedWithPrevious(
    texts: string[],
    role: EmbeddingRole | undefined,
    identity: EmbeddingComputationIdentity
  ): Promise<number[][]> {
    const request = createEmbeddingBatchRequest(texts, role)
    this.collectPreviousInputs(request, identity.dimension)
    const inferred = await this.inferMissingWithIdentity(request, identity)
    if (inferred === null) {
      return await this.embedder.embedBatch(texts, role)
    }
    return await this.completeResults(request, inferred)
  }

  private collectPreviousInputs(request: EmbeddingBatchRequest, dimension: number): void {
    for (const [index, text] of request.texts.entries()) {
      const key = inputDigest(request.role, text)
      request.requestedKeys.push(key)
      const vector = this.collected.get(key) ?? this.previous.get(key)
      if (!vector || vector.length !== dimension || !isFiniteVector(vector)) {
        if (!request.missingInputs.has(key)) {
          request.missingInputs.set(key, text)
        }
        continue
      }
      request.results[index] = Array.from(vector)
      if (this.previous.has(key)) {
        this.remember(key, vector)
      }
    }
  }

  private async inferMissingWithIdentity(
    request: EmbeddingBatchRequest,
    identity: EmbeddingComputationIdentity
  ): Promise<Map<string, SnapshotVector> | null> {
    const inferred = new Map<string, SnapshotVector>()
    const missedKeys = [...request.missingInputs.keys()]
    if (missedKeys.length === 0) {
      return inferred
    }

    const missedVectors = await this.embedder.embedBatch(
      [...request.missingInputs.values()],
      request.role
    )
    if (missedVectors.length !== missedKeys.length) {
      this.discardUntrustedVectors()
      return null
    }
    for (const [index, key] of missedKeys.entries()) {
      const vector = missedVectors[index]
      if (!vector || !isValidInference(vector, identity.dimension)) {
        this.discardUntrustedVectors()
        return null
      }
      const stored = Float32Array.from(vector)
      this.previous.delete(key)
      inferred.set(key, stored)
      this.remember(key, stored)
    }
    return inferred
  }

  private async completeResults(
    request: EmbeddingBatchRequest,
    inferred: Map<string, SnapshotVector>
  ): Promise<number[][]> {
    for (const [index, key] of request.requestedKeys.entries()) {
      if (request.results[index] === undefined) {
        const vector = inferred.get(key) ?? this.collected.get(key) ?? this.previous.get(key)
        if (vector) {
          request.results[index] = Array.from(vector)
        }
      }
    }

    if (!hasOnlyVectors(request.results)) {
      return await this.embedder.embedBatch(request.texts, request.role)
    }
    return request.results
  }

  private discardUntrustedVectors(): void {
    // A mismatch means identity discovery did not describe the actual output.
    // Drop both caches and avoid publishing values from this session.
    this.previous.clear()
    this.collected.clear()
    this.collecting = false
  }

  /** Publish only after the adapter's per-file insertion has succeeded. */
  async publish(): Promise<void> {
    if (this.disposed) {
      return
    }
    try {
      await this.resolvePublicationIdentity()
      if (!this.identity) {
        return
      }
      if (!this.collecting) {
        await removeSnapshotPath(this.snapshotPath)
        return
      }
      await this.writeSnapshot()
    } catch (error) {
      console.warn(`Warning: unable to save embedding snapshot: ${messageOf(error)}`)
    } finally {
      this.dispose()
    }
  }

  private async resolvePublicationIdentity(): Promise<void> {
    if (this.identity || !this.collecting || this.collected.size === 0) {
      return
    }
    let identity: EmbeddingComputationIdentity | null
    try {
      identity = await this.embedder.getComputationIdentity()
    } catch {
      identity = null
    }
    if (!identity || !isValidIdentity(identity)) {
      return
    }
    this.identity = identity
    for (const [key, vector] of this.collected) {
      if (vector.length !== identity.dimension || !isFiniteVector(vector)) {
        this.collected.delete(key)
      }
    }
  }

  private async writeSnapshot(): Promise<void> {
    const identity = this.identity
    if (!identity) {
      return
    }
    const envelope: SnapshotEnvelope = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      fingerprint: identity.fingerprint,
      dimension: identity.dimension,
      entries: [...this.collected.entries()],
    }
    const bytes = serialize(envelope)
    if (bytes.byteLength > MAX_EMBEDDING_SNAPSHOT_BYTES) {
      await removeSnapshotPath(this.snapshotPath)
      return
    }

    await mkdir(dirname(this.snapshotPath), { recursive: true })
    const temporaryPath = `${this.snapshotPath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx' })
      await rename(temporaryPath, this.snapshotPath)
    } catch (error) {
      await removeSnapshotPath(temporaryPath)
      console.warn(`Warning: unable to save embedding snapshot: ${messageOf(error)}`)
    }
  }

  /** Drop all per-document vectors on success, failure, or zero-chunk return. */
  dispose(): void {
    this.disposed = true
    this.previous.clear()
    this.collected.clear()
    this.collectedBytes = 0
    this.identity = null
  }

  private async loadPrevious(identity: EmbeddingComputationIdentity): Promise<void> {
    this.identity = identity
    try {
      const fileInfo = await stat(this.snapshotPath)
      if (fileInfo.size <= 0 || fileInfo.size > MAX_EMBEDDING_SNAPSHOT_BYTES) {
        return
      }
      const envelope: unknown = deserialize(await readFile(this.snapshotPath))
      if (!isSnapshotEnvelope(envelope, identity)) {
        return
      }
      const seenKeys = new Set<string>()
      for (const [key, vector] of envelope.entries) {
        if (seenKeys.has(key)) {
          this.previous.clear()
          return
        }
        seenKeys.add(key)
        this.previous.set(key, vector)
      }
    } catch {
      // Missing, unreadable, truncated, or incompatible snapshots are misses.
    }
  }

  private async loadPreviousIfPresent(): Promise<EmbeddingComputationIdentity | null> {
    if (this.loaded) {
      return this.identity
    }
    this.loaded = true

    // A cold document has no reusable vectors. Avoid waiting on model-asset
    // hashing before its first inference; initialization already started that
    // work, and publish can await it after parsing and embedding have completed.
    try {
      const fileInfo = await stat(this.snapshotPath)
      if (fileInfo.size <= 0 || fileInfo.size > MAX_EMBEDDING_SNAPSHOT_BYTES) {
        return null
      }
    } catch {
      return null
    }

    let identity: EmbeddingComputationIdentity | null
    try {
      identity = await this.embedder.getComputationIdentity()
    } catch {
      return null
    }
    if (!identity || !isValidIdentity(identity)) {
      return null
    }
    await this.loadPrevious(identity)
    return identity
  }

  private async embedAndCollectWithoutPrevious(
    texts: string[],
    role?: EmbeddingRole
  ): Promise<number[][]> {
    if (!this.collecting) {
      return await this.embedder.embedBatch(texts, role)
    }

    const request = createEmbeddingBatchRequest(texts, role)
    this.collectCurrentInputs(request)
    const inferred = await this.inferWithoutPrevious(request)
    if (inferred === null) {
      return await this.embedder.embedBatch(texts, role)
    }
    return await this.completeResults(request, inferred)
  }

  private collectCurrentInputs(request: EmbeddingBatchRequest): void {
    for (const [index, text] of request.texts.entries()) {
      const key = inputDigest(request.role, text)
      request.requestedKeys.push(key)
      const vector = this.collected.get(key)
      if (vector) {
        request.results[index] = Array.from(vector)
      } else if (!request.missingInputs.has(key)) {
        request.missingInputs.set(key, text)
      }
    }
  }

  private async inferWithoutPrevious(
    request: EmbeddingBatchRequest
  ): Promise<Map<string, SnapshotVector> | null> {
    const inferred = new Map<string, SnapshotVector>()
    const keys = [...request.missingInputs.keys()]
    if (keys.length === 0) {
      return inferred
    }
    const vectors = await this.embedder.embedBatch(
      [...request.missingInputs.values()],
      request.role
    )
    if (vectors.length !== keys.length) {
      this.stopCollecting()
      return null
    }
    for (const [index, key] of keys.entries()) {
      const vector = vectors[index]
      if (!vector) {
        this.stopCollecting()
        return null
      }
      inferred.set(key, vector)
      if (vector.length > 0 && vector.every(Number.isFinite)) {
        this.remember(key, Float32Array.from(vector))
      }
    }
    return inferred
  }

  private remember(key: string, vector: Float32Array): void {
    if (!this.collecting) {
      return
    }
    if (!this.collected.has(key)) {
      const entryBytes = Buffer.byteLength(key, 'utf8') + vector.byteLength + ENTRY_OVERHEAD_BYTES
      if (this.collectedBytes + entryBytes > MAX_EMBEDDING_SNAPSHOT_BYTES) {
        this.collecting = false
        this.collected.clear()
        this.collectedBytes = 0
        return
      }
      this.collectedBytes += entryBytes
    }
    this.collected.set(key, vector)
  }

  private stopCollecting(): void {
    this.collecting = false
    this.collected.clear()
    this.collectedBytes = 0
  }
}

function inputDigest(role: EmbeddingRole | undefined, text: string): string {
  return createHash('sha256')
    .update(serialize([role ?? 'default', text]))
    .digest('hex')
}

function createEmbeddingBatchRequest(
  texts: string[],
  role: EmbeddingRole | undefined
): EmbeddingBatchRequest {
  return {
    texts,
    role,
    results: Array.from({ length: texts.length }),
    requestedKeys: [],
    missingInputs: new Map<string, string>(),
  }
}

function isValidIdentity(value: EmbeddingComputationIdentity): boolean {
  return (
    /^[a-f\d]{64}$/.test(value.fingerprint) &&
    Number.isInteger(value.dimension) &&
    value.dimension > 0
  )
}

function isFiniteVector(vector: Float32Array): boolean {
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      return false
    }
  }
  return true
}

function isValidInference(vector: number[], dimension: number): boolean {
  return vector.length === dimension && vector.every(Number.isFinite)
}

function hasOnlyVectors(values: (number[] | undefined)[]): values is number[][] {
  return values.every((value): value is number[] => value !== undefined)
}

function isSnapshotEnvelope(
  value: unknown,
  identity: EmbeddingComputationIdentity
): value is SnapshotEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (
    !('formatVersion' in value) ||
    value.formatVersion !== SNAPSHOT_FORMAT_VERSION ||
    !('fingerprint' in value) ||
    value.fingerprint !== identity.fingerprint ||
    !('dimension' in value) ||
    value.dimension !== identity.dimension ||
    !('entries' in value) ||
    !Array.isArray(value.entries)
  ) {
    return false
  }
  return value.entries.every((entry) => isSnapshotEntry(entry, identity.dimension))
}

function isSnapshotEntry(value: unknown, dimension: number): value is [string, Float32Array] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    /^[a-f\d]{64}$/.test(value[0]) &&
    value[1] instanceof Float32Array &&
    value[1].length === dimension &&
    isFiniteVector(value[1])
  )
}

async function removeSnapshotPath(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // Deletion and ingestion remain successful when stale acceleration data lingers.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
