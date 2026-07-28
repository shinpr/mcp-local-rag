/**
 * Indivisible UTF-16 text range in the source passed to semantic chunking.
 */
export interface AtomicTextRange {
  /** Inclusive UTF-16 offset. */
  start: number
  /** Exclusive UTF-16 offset. */
  end: number
}

/**
 * Text chunk
 */
export interface TextChunk {
  /** Chunk text */
  text: string
  /** Chunk index (zero-based) */
  index: number
}

export { DEFAULT_MIN_CHUNK_LENGTH, SemanticChunker } from './semantic-chunker.js'
