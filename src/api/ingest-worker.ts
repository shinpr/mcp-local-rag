// Background file ingestion worker — reuses core RAGServer/CLI logic

import { extname } from 'node:path'
import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import { buildChunksAndEmbeddings, buildVectorChunks } from '../ingest/compute.js'
import { DocumentParser } from '../parser/index.js'
import { computeContentHash } from '../utils/file-hash.js'
import type { VectorStore } from '../vectordb/index.js'
import type { ApiConfig } from './config.js'
import { resolveStoredFilePath } from './upload-utils.js'

interface IngestFileParams {
  filePath: string
  projectId: number
  storedFilename: string
  projectName: string
  vectorStore: VectorStore
  embedder: Embedder
  config: ApiConfig
}

/**
 * Ingest a single file: parse → chunk → embed → delete old → insert new.
 * Returns the number of chunks inserted.
 *
 * Reuses the same pipeline as CLI `ingestSingleFile` and RAGServer `handleIngestFile`.
 */
export async function ingestFile(params: IngestFileParams): Promise<number> {
  const {
    filePath: storedPath,
    projectId,
    storedFilename,
    projectName,
    vectorStore,
    embedder,
    config,
  } = params
  const filePath = resolveStoredFilePath(storedPath, config.uploadDir, {
    projectId,
    storedFilename,
  })

  // Compute file content hash
  const fileHash = await computeContentHash(filePath)

  // Parse document — PDF uses parsePdf (needs embedder), others use parseFile
  const parser = new DocumentParser({
    baseDirs: [config.uploadDir],
    maxFileSize: config.maxUploadSizeBytes,
  })

  const isPdf = extname(filePath).toLowerCase() === '.pdf'
  let text: string
  let title: string | null = null

  if (isPdf) {
    const result = await parser.parsePdf(filePath, embedder)
    text = result.content
    title = result.title || null
  } else {
    const result = await parser.parseFile(filePath)
    text = result.content
    title = result.title || null
  }

  // Chunk text + generate embeddings
  const chunker = new SemanticChunker()
  const { chunks, embeddings } = await buildChunksAndEmbeddings(text, title, chunker, embedder)

  if (chunks.length === 0) {
    return 0
  }

  // Delete existing chunks for this file+project
  await vectorStore.deleteChunks(filePath, projectName)

  // Build vector chunks
  const vectorChunks = buildVectorChunks({
    filePath,
    chunks,
    embeddings,
    fileSize: text.length,
    fileTitle: title,
    projectName,
    fileHash,
  })

  // Insert
  await vectorStore.insertChunks(vectorChunks)

  return vectorChunks.length
}
