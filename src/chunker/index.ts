/**
 * Text chunk
 */
export interface TextChunk {
  /** Chunk text */
  text: string
  /** Chunk index (zero-based) */
  index: number
}

export { SemanticChunker } from './semantic-chunker.js'
