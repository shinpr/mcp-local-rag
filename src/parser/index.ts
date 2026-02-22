// DocumentParser implementation with PDF/DOCX/TXT/MD support

import { statSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { SemanticChunker } from '../chunker/index.js'
import { type EmbedderInterface, type PageData, filterPageBoundarySentences } from './pdf-filter.js'
import {
  extractDocxTitle,
  extractMarkdownTitle,
  extractPdfTitle,
  extractTxtTitle,
} from './title-extractor.js'

// ============================================
// Type Definitions
// ============================================

/**
 * Result from parsing a document, containing both content and extracted title.
 * Title is display-only metadata (NOT used for search scoring).
 */
export interface ParseResult {
  content: string
  title: string
}

/**
 * DocumentParser configuration
 */
interface ParserConfig {
  /** Security: allowed base directory */
  baseDir: string
  /** Maximum file size (100MB) */
  maxFileSize: number
}

/**
 * Validation error (equivalent to 400)
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * File operation error (equivalent to 500)
 */
export class FileOperationError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'FileOperationError'
  }
}

// ============================================
// DocumentParser Class
// ============================================

/**
 * Document parser class (PDF/DOCX/TXT/MD support)
 *
 * Responsibilities:
 * - File path validation (path traversal prevention)
 * - File size validation (100MB limit)
 * - Parse 4 formats (PDF/DOCX/TXT/MD)
 */
export class DocumentParser {
  private readonly config: ParserConfig
  /** Lazily cached realpath of baseDir. Assumes baseDir is stable for the process lifetime. */
  private resolvedBaseDir: string | null = null

  constructor(config: ParserConfig) {
    this.config = config
  }

  /**
   * File path validation (Absolute path requirement + Path traversal prevention)
   *
   * @param filePath - File path to validate (must be absolute)
   * @throws ValidationError - When path is not absolute or outside BASE_DIR
   */
  async validateFilePath(filePath: string): Promise<void> {
    // Check if path is absolute (fast-fail without syscall)
    if (!isAbsolute(filePath)) {
      throw new ValidationError(
        `File path must be absolute path (received: ${filePath}). Please provide an absolute path within BASE_DIR.`
      )
    }

    // Lazily resolve and cache the real baseDir path (follows symlinks)
    if (!this.resolvedBaseDir) {
      const resolved = await realpath(resolve(this.config.baseDir))
      // Ensure trailing separator for safe prefix comparison
      this.resolvedBaseDir = resolved.endsWith(sep) ? resolved : resolved + sep
    }

    // Resolve the real path of the file (follows symlinks)
    let resolvedPath: string
    try {
      resolvedPath = await realpath(filePath)
    } catch (error) {
      // realpath fails if path doesn't exist on filesystem.
      // Distinguish broken symlinks from genuinely non-existent paths:
      // - Broken symlink: lstat succeeds (symlink entry exists) -> reject
      // - Non-existent path: lstat fails -> fall back to resolve() for validation
      const isSymlink = await lstat(filePath)
        .then((stats) => stats.isSymbolicLink())
        .catch(() => false)

      if (isSymlink) {
        throw new ValidationError(
          `Cannot resolve file path: ${filePath}. The file may not exist or is a broken symlink.`,
          error as Error
        )
      }

      // File doesn't exist at all - fall back to resolve() for path validation.
      // Note: resolve() is string-based and cannot detect symlinked parent directories.
      // This is acceptable because non-existent files will fail at subsequent readFile/statSync.
      resolvedPath = resolve(filePath)
    }

    // Check if resolved path is within BASE_DIR
    if (!resolvedPath.startsWith(this.resolvedBaseDir)) {
      throw new ValidationError(
        `File path must be within BASE_DIR (${this.resolvedBaseDir}). Received path outside BASE_DIR: ${filePath}`
      )
    }
  }

  /**
   * File size validation (100MB limit)
   *
   * @param filePath - File path to validate
   * @throws ValidationError - When file size exceeds limit
   * @throws FileOperationError - When file read fails
   */
  validateFileSize(filePath: string): void {
    try {
      const stats = statSync(filePath)
      if (stats.size > this.config.maxFileSize) {
        throw new ValidationError(
          `File size exceeds limit: ${stats.size} > ${this.config.maxFileSize}`
        )
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error
      }
      throw new FileOperationError(`Failed to check file size: ${filePath}`, error as Error)
    }
  }

  /**
   * File parsing (auto format detection)
   *
   * @param filePath - File path to parse
   * @returns ParseResult with content and extracted title
   * @throws ValidationError - Path traversal, size exceeded, unsupported format
   * @throws FileOperationError - File read failed, parse failed
   */
  async parseFile(filePath: string): Promise<ParseResult> {
    // Validation
    await this.validateFilePath(filePath)
    this.validateFileSize(filePath)

    // Format detection (PDF uses parsePdf directly)
    const ext = extname(filePath).toLowerCase()
    switch (ext) {
      case '.docx':
        return await this.parseDocx(filePath)
      case '.txt':
        return await this.parseTxt(filePath)
      case '.md':
        return await this.parseMd(filePath)
      default:
        throw new ValidationError(`Unsupported file format: ${ext}`)
    }
  }

  /**
   * PDF parsing with header/footer filtering
   *
   * Features:
   * - Extracts text with position information (x, y, fontSize)
   * - Semantic header/footer detection using embedding similarity
   * - Uses hasEOL for proper line break handling
   * - Extracts document title from PDF metadata and first page font heuristic
   *
   * @param filePath - PDF file path
   * @param embedder - Embedder for semantic header/footer detection
   * @returns ParseResult with content and extracted title
   * @throws FileOperationError - File read failed, parse failed
   */
  async parsePdf(filePath: string, embedder: EmbedderInterface): Promise<ParseResult> {
    // Validation
    await this.validateFilePath(filePath)
    this.validateFileSize(filePath)

    try {
      const buffer = await readFile(filePath)
      const pdf = await getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise

      // Extract metadata for title extraction
      const metadata = await pdf.getMetadata()
      const metadataTitle = (metadata?.info as Record<string, unknown>)?.['Title'] as
        | string
        | undefined

      // Extract text with position information from each page
      const pages: PageData[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const textContent = await page.getTextContent()

        const items = textContent.items
          .filter((item): item is TextItem => 'str' in item)
          .map((item) => ({
            text: item.str,
            x: item.transform[4],
            y: item.transform[5],
            fontSize: Math.abs(item.transform[0]),
            hasEOL: item.hasEOL ?? false,
          }))

        pages.push({ pageNum: i, items })
      }

      // Apply sentence-level header/footer filtering (returns per-page filtered text)
      // This handles variable content like page numbers ("7 of 75") using semantic similarity
      const filteredPages = await filterPageBoundarySentences(pages, embedder)
      const text = filteredPages.filter((t) => t.length > 0).join('\n\n')

      // Extract title from filtered page 1 via semantic chunking
      // Isolated try-catch: title extraction failure should not abort PDF ingestion
      const fileName = basename(filePath)
      let firstPageChunkText: string | undefined
      try {
        const filteredPage1 = filteredPages[0]
        if (filteredPage1 && filteredPage1.trim().length > 0) {
          const chunker = new SemanticChunker()
          const page1Chunks = await chunker.chunkText(filteredPage1, embedder)
          if (page1Chunks.length > 0) {
            firstPageChunkText = (page1Chunks[0] as { text: string }).text
          }
        }
      } catch (titleError) {
        console.error(`Title extraction failed, falling back to filename: ${titleError}`)
      }
      const titleResult = extractPdfTitle(metadataTitle, firstPageChunkText, fileName)

      console.error(`Parsed PDF: ${filePath} (${text.length} characters, ${pdf.numPages} pages)`)

      return { content: text, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse PDF: ${filePath}`, error as Error)
    }
  }

  /**
   * DOCX parsing (using mammoth)
   *
   * Uses extractRawText for content and convertToHtml additionally for title detection.
   *
   * @param filePath - DOCX file path
   * @returns ParseResult with content and extracted title
   * @throws FileOperationError - File read failed, parse failed
   */
  private async parseDocx(filePath: string): Promise<ParseResult> {
    try {
      // Read file once and pass buffer to both mammoth calls
      const buffer = await readFile(filePath)

      // Use extractRawText for content (unchanged behavior)
      const result = await mammoth.extractRawText({ buffer })
      const rawText = result.value

      // Use convertToHtml additionally for title extraction (first <h1>)
      const htmlResult = await mammoth.convertToHtml({ buffer })
      const fileName = basename(filePath)
      const titleResult = extractDocxTitle(htmlResult.value, fileName)

      console.error(`Parsed DOCX: ${filePath} (${rawText.length} characters)`)
      return { content: rawText, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse DOCX: ${filePath}`, error as Error)
    }
  }

  /**
   * TXT parsing (using fs.readFile)
   *
   * @param filePath - TXT file path
   * @returns ParseResult with content and extracted title
   * @throws FileOperationError - File read failed
   */
  private async parseTxt(filePath: string): Promise<ParseResult> {
    try {
      const text = await readFile(filePath, 'utf-8')
      const fileName = basename(filePath)
      const titleResult = extractTxtTitle(text, fileName)
      console.error(`Parsed TXT: ${filePath} (${text.length} characters)`)
      return { content: text, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse TXT: ${filePath}`, error as Error)
    }
  }

  /**
   * MD parsing (using fs.readFile)
   *
   * @param filePath - MD file path
   * @returns ParseResult with content and extracted title
   * @throws FileOperationError - File read failed
   */
  private async parseMd(filePath: string): Promise<ParseResult> {
    try {
      const text = await readFile(filePath, 'utf-8')
      const fileName = basename(filePath)
      const titleResult = extractMarkdownTitle(text, fileName)
      console.error(`Parsed MD: ${filePath} (${text.length} characters)`)
      return { content: text, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse MD: ${filePath}`, error as Error)
    }
  }
}
