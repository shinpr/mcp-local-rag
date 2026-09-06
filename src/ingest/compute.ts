// Shared chunk + embed computation for the ingest pipeline.
//
// Lifts the duplicated `chunker.chunkText -> embedder.embedBatch` sequence
// out of `handleIngestFile` and `ingestSingleFile` into this single shared
// function. Persistence (delete + insert + rollback + optimize) stays in each
// caller because the rollback semantics differ between the MCP path and the
// CLI path.
//
// The function is dispatch-agnostic: it takes already-extracted `text`
// and `title` and does not touch `vectorStore`. It is the single
// chunker call site for any ingest path.

import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { AtomicTextRange, SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { ParseResult } from '../parser/index.js'
import type { ImageRendition } from '../pdf-visual/types.js'
import { MAX_VISUAL_RENDITION_BYTES } from '../utils/limits.js'
import type { VectorChunk, VisualAttachment } from '../vectordb/index.js'

/** Distance from `offset` to a chunk's source span; 0 when it falls inside. */
function distanceToSpan(offset: number, chunk: TextChunk): number {
  if (offset < chunk.sourceStart) {
    return chunk.sourceStart - offset
  }
  if (offset > chunk.sourceEnd) {
    return offset - chunk.sourceEnd
  }
  return 0
}

/**
 * Result of the shared chunk + embed computation.
 *
 * - `chunks` is the result of a single `chunker.chunkText` call.
 * - `embeddings` is the result of `embedder.embedBatch(chunks.map(c => c.text))`
 *   and has the same length as `chunks`.
 */
export interface BuildChunksAndEmbeddingsResult {
  chunks: TextChunk[]
  embeddings: number[][]
}

export interface BuildChunksFromParseResultResult extends BuildChunksAndEmbeddingsResult {
  visualAttachments: Map<number, VisualAttachment[]>
  omittedImageCount: number
}

export function findNearestChunk(
  chunks: readonly TextChunk[],
  sourceOffset: number
): TextChunk | undefined {
  let owner: TextChunk | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const chunk of chunks) {
    const distance = distanceToSpan(sourceOffset, chunk)
    if (!owner) {
      owner = chunk
      bestDistance = distance
      continue
    }
    const isPreceding = chunk.sourceEnd <= sourceOffset
    const ownerIsPreceding = owner.sourceEnd <= sourceOffset
    if (
      distance < bestDistance ||
      (distance === bestDistance && isPreceding && !ownerIsPreceding) ||
      (distance === bestDistance && isPreceding === ownerIsPreceding && chunk.index < owner.index)
    ) {
      owner = chunk
      bestDistance = distance
    }
  }
  return owner
}

export function createVisualAttachment(
  imageIndex: number,
  rendition: ImageRendition
): VisualAttachment {
  if (
    !Number.isInteger(imageIndex) ||
    imageIndex < 0 ||
    rendition.bytes.byteLength === 0 ||
    rendition.bytes.byteLength > MAX_VISUAL_RENDITION_BYTES
  ) {
    throw new Error('Invalid bounded image rendition')
  }
  return {
    imageIndex,
    mimeType: rendition.mimeType,
    data: Buffer.from(rendition.bytes).toString('base64'),
  }
}

/**
 * Compute semantic chunks and their embeddings for already-extracted text.
 *
 * Calls `chunker.chunkText` exactly once and then
 * `embedder.embedBatch` on the resulting chunk texts. Does NOT touch
 * `vectorStore`. Does NOT fail-fast on zero chunks — callers decide
 * how to handle an empty result (the MCP handler throws `McpError`;
 * the CLI logs a warning and returns 0).
 *
 * Errors from the chunker or embedder propagate verbatim.
 *
 * @param text  Already-extracted document text (parser output, raw-data
 *              payload, or joined visual-enriched per-page text).
 * @param chunker  Semantic chunker instance (owned by the caller).
 * @param embedder Embedder implementing the structural `EmbedderInterface`
 *                 (only `embedBatch` is required).
 */
export async function buildChunksAndEmbeddings(
  text: string,
  chunker: SemanticChunker,
  embedder: EmbedderInterface,
  atomicRanges?: readonly AtomicTextRange[]
): Promise<BuildChunksAndEmbeddingsResult> {
  const chunks = await chunker.chunkText(text, embedder, atomicRanges)
  // F5: Skip `embedBatch` entirely on zero chunks. `embedBatch` runs
  // `ensureInitialized()` (which triggers the ~90MB MiniLM download on a
  // cold cache) BEFORE checking for the empty-array short-circuit, so an
  // empty file would otherwise pay the model-load cost for no work.
  if (chunks.length === 0) {
    return { chunks: [], embeddings: [] }
  }
  const embeddings = await embedder.embedBatch(chunks.map((chunk) => chunk.text))
  return { chunks, embeddings }
}

/**
 * Preserve the parser content/range mapping at one shared boundary. Display
 * title handling stays in each dispatch root because it does not affect chunks.
 */
export async function buildChunksFromParseResult(
  result: ParseResult,
  chunker: SemanticChunker,
  embedder: EmbedderInterface
): Promise<BuildChunksFromParseResultResult> {
  const computed = await buildChunksAndEmbeddings(
    result.content,
    chunker,
    embedder,
    result.atomicRanges
  )
  const visualAttachments = new Map<number, VisualAttachment[]>()
  if (!result.imageAnchors?.length || computed.chunks.length === 0) {
    return { ...computed, visualAttachments, omittedImageCount: 0 }
  }

  const { renderImageRendition } = await import('../pdf-visual/renderer.js')
  let omittedCount = 0
  for (const anchor of [...result.imageAnchors].sort(
    (left, right) => left.imageIndex - right.imageIndex
  )) {
    const owner = findNearestChunk(computed.chunks, anchor.offset)
    if (!owner) {
      throw new Error(`Image ${anchor.imageIndex} has no owning chunk`)
    }

    try {
      const rendition = renderImageRendition(anchor.bytes, anchor.mimeType)
      const attachment = createVisualAttachment(anchor.imageIndex, rendition)
      const owned = visualAttachments.get(owner.index) ?? []
      owned.push(attachment)
      visualAttachments.set(owner.index, owned)
    } catch {
      omittedCount += 1
    }
  }
  return { ...computed, visualAttachments, omittedImageCount: omittedCount }
}

/**
 * Content identity of a source file: the lowercase SHA-256 hex digest of its
 * raw bytes.
 *
 * Hashing the bytes (not the parsed or normalized text) keeps the value
 * reproducible by any caller that can read the file, which is what lets a later
 * sync pass decide "unchanged" without re-parsing. Pure: the caller reads the
 * file and passes the bytes in.
 */
export function computeContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Build persistable `VectorChunk`s from computed chunks + embeddings.
 *
 * Single source of truth for the chunk→VectorChunk mapping shared by the MCP
 * ingest handler (`handleIngestFile`) and both CLI ingest paths (default +
 * visual). Assigns one shared `timestamp` to every chunk, a fresh `id`, and
 * derives `fileName`/`fileType` from `filePath` via `node:path` (cross-platform).
 * Does NOT touch `vectorStore` — persistence stays in each caller.
 *
 * Throws when a chunk has no corresponding embedding (index mismatch);
 * `embeddings` must align 1:1 with `chunks`.
 *
 * @param fileSize Length value recorded in `metadata.fileSize`. The caller
 *   chooses the source: the default path passes parsed text length; the visual
 *   path passes the joined enriched-page text length (pre-chunking).
 * @param contentHash {@link computeContentHash} of the source file bytes,
 *   shared by every chunk of that file exactly like `timestamp`. `null` for a
 *   chunk set with no source file; the key is then omitted rather than stored
 *   empty, so a hashless row is never mistaken for a hash of nothing. Required
 *   (not optional) so a new call site cannot silently write hashless rows.
 */
export function buildVectorChunks(params: {
  filePath: string
  chunks: TextChunk[]
  embeddings: number[][]
  fileSize: number
  fileTitle: string | null
  contentHash: string | null
  visualAttachments?: ReadonlyMap<number, readonly VisualAttachment[]>
}): VectorChunk[] {
  const {
    filePath,
    chunks,
    embeddings,
    fileSize,
    fileTitle,
    contentHash,
    visualAttachments = new Map(),
  } = params
  const timestamp = new Date().toISOString()
  return chunks.map((chunk, index) => {
    const embedding = embeddings[index]
    if (!embedding) {
      throw new Error(`Missing embedding for chunk ${index}`)
    }
    const attachments = [...(visualAttachments.get(chunk.index) ?? [])]
      .sort((left, right) => left.imageIndex - right.imageIndex)
      .map(({ imageIndex, mimeType, data }) => ({
        imageIndex,
        mimeType,
        data,
      }))
    return {
      id: randomUUID(),
      filePath,
      chunkIndex: chunk.index,
      text: chunk.text,
      vector: embedding,
      metadata: {
        fileName: basename(filePath),
        fileSize,
        fileType: extname(filePath).slice(1),
      },
      fileTitle,
      ...(contentHash === null ? {} : { contentHash }),
      visualAttachments: JSON.stringify(attachments),
      timestamp,
    }
  })
}
