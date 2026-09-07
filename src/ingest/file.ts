import { readFile } from 'node:fs/promises'

import type { SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { DocumentParser } from '../parser/index.js'
import type { QualityProfile } from '../utils/visual-profile.js'
import type { VectorChunk, VisualAttachment } from '../vectordb/index.js'
import { buildChunksFromParseResult, buildVectorChunks, computeContentHash } from './compute.js'
import {
  type CaptionerConfig,
  type PrepareVisualPdfChunksOptions,
  prepareVisualPdfChunks,
} from './visual.js'

/** Collaborators one file ingest run needs, injected as a unit. */
export interface FileIngestCollaborators {
  parser: DocumentParser
  chunker: SemanticChunker
  embedder: EmbedderInterface
}

export interface PrepareFileForIngestOptions {
  images: boolean
  captioner?: CaptionerConfig
}

export interface PreparedFileIngest {
  filePath: string
  chunks: TextChunk[]
  embeddings: number[][]
  textLength: number
  title: string | null
  contentHash: string
  /** Requested visual intent of this run: a profile for a captioned PDF, `null` otherwise. */
  visualProfile: QualityProfile | null
  visualAttachments: Map<number, VisualAttachment[]>
  omittedImageCount: number
}

export function buildPreparedFileVectorChunks(prepared: PreparedFileIngest): VectorChunk[] {
  return buildVectorChunks({
    filePath: prepared.filePath,
    chunks: prepared.chunks,
    embeddings: prepared.embeddings,
    fileSize: prepared.textLength,
    fileTitle: prepared.title,
    contentHash: prepared.contentHash,
    visualProfile: prepared.visualProfile,
    visualAttachments: prepared.visualAttachments,
  })
}

async function readPreParseContentHash(filePath: string, parser: DocumentParser): Promise<string> {
  await parser.validateFilePath(filePath)
  parser.validateFileSize(filePath)
  return computeContentHash(await readFile(filePath))
}

/**
 * Prepare one validated source file for persistence without touching storage or
 * process output. The source hash is read before parsing so a concurrent rewrite
 * remains visible to the next sync instead of being paired with stale chunks.
 *
 * The visual profile is resolved from the request before any caption outcome is
 * known, so it records what was asked for: a run with no qualifying region or a
 * tolerated caption failure still carries the requested profile.
 */
export async function prepareFileForIngest(
  filePath: string,
  collaborators: FileIngestCollaborators,
  options: PrepareFileForIngestOptions
): Promise<PreparedFileIngest> {
  const { parser, chunker, embedder } = collaborators
  const contentHash = await readPreParseContentHash(filePath, parser)
  const isPdf = filePath.toLowerCase().endsWith('.pdf')

  let text: string
  let title: string | null
  let chunks: Awaited<ReturnType<typeof buildChunksFromParseResult>>['chunks']
  let embeddings: Awaited<ReturnType<typeof buildChunksFromParseResult>>['embeddings']
  let visualAttachments: Awaited<ReturnType<typeof buildChunksFromParseResult>>['visualAttachments']
  let omittedImageCount: number

  if (isPdf && (options.captioner !== undefined || options.images)) {
    const visualOptions: PrepareVisualPdfChunksOptions = {
      images: options.images,
      ...(options.captioner === undefined ? {} : { captioner: options.captioner }),
    }
    const result = await prepareVisualPdfChunks(filePath, collaborators, visualOptions)
    text = result.text
    title = result.title
    chunks = result.chunks
    embeddings = result.embeddings
    visualAttachments = result.visualAttachments
    omittedImageCount = result.omittedImageCount
  } else {
    const result = isPdf
      ? await parser.parsePdf(filePath, embedder)
      : await parser.parseFile(filePath, { images: options.images })
    text = result.content
    title = result.title || null
    ;({ chunks, embeddings, visualAttachments, omittedImageCount } =
      await buildChunksFromParseResult(result, chunker, embedder))
  }

  return {
    filePath,
    chunks,
    embeddings,
    textLength: text.length,
    title,
    contentHash,
    visualProfile: isPdf ? (options.captioner?.profile ?? null) : null,
    visualAttachments,
    omittedImageCount,
  }
}
