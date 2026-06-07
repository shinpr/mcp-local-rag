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

import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { VectorChunk } from '../vectordb/index.js'

/**
 * Result of the shared chunk + embed computation.
 *
 * - `chunks` is the result of a single `chunker.chunkText` call.
 * - `embeddings` is the result of `embedder.embedBatch(chunks.map(c => c.text))`
 *   and has the same length as `chunks`.
 * - `title` is passed through unchanged when non-null. When the caller
 *   passes `null`, the caller is responsible for deriving the title from
 *   `chunks[0]?.text` after this function returns (used by the visual
 *   PDF path in later phases).
 */
export interface BuildChunksAndEmbeddingsResult {
  chunks: TextChunk[]
  embeddings: number[][]
  title: string | null
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
 * @param title Display-only document title. Pass-through when non-null;
 *              `null` signals that the caller will derive the title
 *              from `chunks[0]?.text` after this function returns.
 * @param chunker  Semantic chunker instance (owned by the caller).
 * @param embedder Embedder implementing the structural `EmbedderInterface`
 *                 (only `embedBatch` is required).
 */
export async function buildChunksAndEmbeddings(
  text: string,
  title: string | null,
  chunker: SemanticChunker,
  embedder: EmbedderInterface
): Promise<BuildChunksAndEmbeddingsResult> {
  const chunks = await chunker.chunkText(text, embedder)
  // F5: Skip `embedBatch` entirely on zero chunks. `embedBatch` runs
  // `ensureInitialized()` (which triggers the ~90MB MiniLM download on a
  // cold cache) BEFORE checking for the empty-array short-circuit, so an
  // empty file would otherwise pay the model-load cost for no work.
  if (chunks.length === 0) {
    return { chunks: [], embeddings: [], title }
  }
  const embeddings = await embedder.embedBatch(chunks.map((chunk) => chunk.text))
  return { chunks, embeddings, title }
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
 */
export function buildVectorChunks(params: {
  filePath: string
  chunks: TextChunk[]
  embeddings: number[][]
  fileSize: number
  fileTitle: string | null
}): VectorChunk[] {
  const { filePath, chunks, embeddings, fileSize, fileTitle } = params
  const timestamp = new Date().toISOString()
  return chunks.map((chunk, index) => {
    const embedding = embeddings[index]
    if (!embedding) {
      throw new Error(`Missing embedding for chunk ${index}`)
    }
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
      timestamp,
    }
  })
}
