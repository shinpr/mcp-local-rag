// DocumentParser implementation with PDF/DOCX/TXT/MD support

import { statSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import mammoth from 'mammoth'
import type { Document as MupdfDocument } from 'mupdf'
import { SemanticChunker } from '../chunker/index.js'
import { type EmbedderInterface, filterPageBoundarySentences, type PageData } from './pdf-filter.js'
import {
  extractDocxTitle,
  extractMarkdownTitle,
  extractPdfTitle,
  extractTxtTitle,
} from './title-extractor.js'

// ============================================
// Supported Extensions
// ============================================

/**
 * File extensions supported by the parser module (parseFile + parsePdf).
 * Exported so other modules (e.g. list_files) stay in sync automatically
 * when new formats are added here.
 */
export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md'])

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

    // Hold `doc` outside the try so the `finally` block can dispose it after
    // either a successful return or an error from `extractPdfPages` / the
    // post-processing steps. `doc` stays `undefined` if `openDocument` itself
    // throws — in that case there is no handle to destroy.
    let doc: MupdfDocument | undefined
    try {
      const buffer = await readFile(filePath)
      const mupdf = await import('mupdf')
      doc = mupdf.Document.openDocument(buffer, 'application/pdf') as MupdfDocument

      const { pages, metadataTitle, page1FontHint } = await extractPdfPages(
        doc,
        embedder,
        'preserve-whitespace'
      )
      const text = pages
        .map((p) => p.text)
        .filter((t) => t.length > 0)
        .join('\n\n')

      // Extract title from filtered page 1 via semantic chunking
      // Isolated try-catch: title extraction failure should not abort PDF ingestion
      const fileName = basename(filePath)
      let firstPageChunkText: string | undefined
      try {
        const filteredPage1 = pages[0]?.text
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

      const titleResult = extractPdfTitle(
        metadataTitle,
        firstPageChunkText,
        fileName,
        page1FontHint
      )

      console.error(`Parsed PDF: ${filePath} (${text.length} characters, ${pages.length} pages)`)

      return { content: text, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse PDF: ${filePath}`, error as Error)
    } finally {
      // Release the native WASM handle exactly once per invocation, on both
      // success and error paths (AC-013). Pre-existing leak fix bundled into
      // Phase 2 per DD § Adopted Trade-offs.
      doc?.destroy()
    }
  }

  /**
   * Per-page PDF parsing for the visual-enrichment path.
   *
   * Opens a mupdf `Document`, delegates per-page extraction to the shared
   * `extractPdfPages` helper with the `'preserve-whitespace,preserve-images'`
   * stext option string so mupdf emits `block.type === 'image'` blocks for
   * the downstream visual-candidate detector (Phase 1 probe finding).
   *
   * Returns the open `Document` handle alongside the per-page records and
   * title-resolution materials so the caller can:
   *   - run the renderer (`page.toPixmap()`) on the same handle,
   *   - feed `metadataTitle` + `pages[0].page1FontHint` into `extractPdfTitle`
   *     after `buildChunksAndEmbeddings` returns.
   *
   * Caller owns disposal — wrap call sites in
   * `try { ... } finally { doc.destroy() }`. This method does NOT call
   * `doc.destroy()`. See DD § `parser.parsePdfPages` contract.
   *
   * This method does NOT compute the final title and does NOT decide visual
   * candidates — those are the dispatch site's and `pdf-visual/detector`'s
   * responsibilities, respectively.
   *
   * @param filePath - PDF file path (validated against BASE_DIR and size limit)
   * @param embedder - Embedder for semantic header/footer detection
   * @returns Open mupdf `Document`, `metadataTitle`, and per-page records.
   *          `page1FontHint` (largest-font line on page 1) is present only on `pages[0]`.
   * @throws ValidationError - Path traversal, size exceeded
   * @throws FileOperationError - File read or parse failed
   */
  async parsePdfPages(
    filePath: string,
    embedder: EmbedderInterface
  ): Promise<{
    doc: MupdfDocument
    metadataTitle: string | undefined
    pages: Array<{
      pageNum: number
      text: string
      stextJson: unknown
      page1FontHint?: { text: string; fontSize: number }
    }>
  }> {
    // Validation (mirrors parsePdf's entry-point contract so the visual path
    // does not bypass BASE_DIR / size checks).
    await this.validateFilePath(filePath)
    this.validateFileSize(filePath)

    // Open the doc and run per-page extraction. Per the task scope boundary
    // and AC-013, `parsePdfPages` does NOT call `doc.destroy()` — disposal is
    // the caller's responsibility on the success path. On the error path
    // before the caller receives the handle, disposal is intentionally left
    // out of scope here (the DD's caller-owned-disposal contract is for the
    // success path; an error-path safeguard is not in T2.2 scope).
    let extracted: ExtractedPdf
    let doc: MupdfDocument
    try {
      const buffer = await readFile(filePath)
      const mupdf = await import('mupdf')
      doc = mupdf.Document.openDocument(buffer, 'application/pdf') as MupdfDocument
      extracted = await extractPdfPages(doc, embedder, 'preserve-whitespace,preserve-images')
    } catch (error) {
      throw new FileOperationError(`Failed to parse PDF pages: ${filePath}`, error as Error)
    }

    const { pages: helperPages, metadataTitle, page1FontHint } = extracted

    // Adapt the helper's top-level `page1FontHint` onto `pages[0]` per the
    // public contract (DD § Component `parser.parsePdfPages`).
    const pages = helperPages.map((p, idx) =>
      idx === 0 && page1FontHint !== undefined
        ? {
            pageNum: p.pageNum,
            text: p.text,
            stextJson: p.stextJson as unknown,
            page1FontHint,
          }
        : {
            pageNum: p.pageNum,
            text: p.text,
            stextJson: p.stextJson as unknown,
          }
    )

    console.error(`Parsed PDF pages: ${filePath} (${pages.length} pages; caller owns doc disposal)`)

    return { doc, metadataTitle, pages }
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

// ============================================
// Private PDF helpers
// ============================================

/**
 * Shape of mupdf's structured-text JSON used by the per-page loop.
 * Captured here so both the items-extraction step and the raw `stextJson`
 * we return remain typed.
 */
interface StextJson {
  blocks: Array<{
    type: string
    lines: Array<{
      text: string
      x: number
      y: number
      font: { size: number; name: string; weight: string }
    }>
  }>
}

/**
 * Per-page record produced by `extractPdfPages`. `text` is the page's text
 * AFTER `filterPageBoundarySentences` has removed semantically-similar
 * header/footer lines; `stextJson` is the raw mupdf structured-text JSON
 * for the page (preserved so downstream callers — e.g. the visual-candidate
 * detector — can inspect block-level structure).
 */
interface ExtractedPage {
  pageNum: number
  text: string
  stextJson: StextJson
}

/**
 * Result returned by `extractPdfPages`. The helper lifts three concerns
 * out of the legacy `parsePdf` body:
 *   1. the per-page `toStructuredText` + `block.type === 'text'` loop;
 *   2. `filterPageBoundarySentences` for header/footer removal;
 *   3. title-resolution materials (`metadataTitle` and `page1FontHint`).
 *
 * Both `parsePdf` and `parsePdfPages` consume this helper; they differ only
 * in the `stextOptions` argument they pass to `page.toStructuredText(...)`.
 */
interface ExtractedPdf {
  pages: ExtractedPage[]
  metadataTitle: string | undefined
  page1FontHint: { text: string; fontSize: number } | undefined
}

/**
 * Per-page extraction shared by `parsePdf` and `parsePdfPages`.
 *
 * Takes an already-open mupdf `Document` and:
 *   - reads `info:Title` once,
 *   - iterates pages calling `toStructuredText(stextOptions)`,
 *   - builds `PageData` items (only `block.type === 'text'` lines),
 *   - runs `filterPageBoundarySentences` to drop semantic headers/footers,
 *   - derives `page1FontHint` from page 1's largest-font lines.
 *
 * The two callers differ ONLY in `stextOptions`: `parsePdf` passes
 * `'preserve-whitespace'` (default-mode invariance — AC-001 / NFR-1);
 * `parsePdfPages` passes `'preserve-whitespace,preserve-images'` so mupdf
 * emits `block.type === 'image'` entries for the downstream visual-candidate
 * detector (probe-verified — see DD §Probe Results).
 *
 * Lifecycle: this helper does NOT call `doc.destroy()` — disposal stays
 * with the caller (T2.3 will add a `try/finally` in `parsePdf`).
 */
async function extractPdfPages(
  doc: MupdfDocument,
  embedder: EmbedderInterface,
  stextOptions: string
): Promise<ExtractedPdf> {
  const numPages = doc.countPages()
  const metadataTitle = doc.getMetaData('info:Title') || undefined

  const pageDataList: PageData[] = []
  const stextJsonList: StextJson[] = []
  for (let i = 0; i < numPages; i++) {
    const page = doc.loadPage(i)
    const bounds = page.getBounds() // [x0, y0, x1, y1]
    const pageHeight = bounds[3] - bounds[1]
    const stext = page.toStructuredText(stextOptions)
    const json = JSON.parse(stext.asJSON()) as StextJson

    const items: Array<{
      text: string
      x: number
      y: number
      fontSize: number
      hasEOL: boolean
      fontName?: string
      fontWeight?: string
    }> = []
    for (const block of json.blocks) {
      if (block.type !== 'text') continue
      for (const line of block.lines) {
        items.push({
          text: line.text.replace(/\t/g, ' '),
          x: line.x,
          // Invert Y: mupdf uses top-down (0=top), downstream code expects bottom-up (large Y = top)
          y: pageHeight - line.y,
          fontSize: line.font.size,
          hasEOL: true,
          fontName: line.font.name,
          fontWeight: line.font.weight,
        })
      }
    }

    pageDataList.push({ pageNum: i + 1, items, pageHeight })
    stextJsonList.push(json)
  }

  // Apply sentence-level header/footer filtering (returns per-page filtered text).
  // This handles variable content like page numbers ("7 of 75") using semantic similarity.
  const filteredPages = await filterPageBoundarySentences(pageDataList, embedder)

  // Extract largest-font lines from page 1 for title hint.
  // Concatenate all consecutive lines with the largest font size (covers multi-line titles).
  const page1Items = pageDataList[0]?.items ?? []
  const maxFontSize = page1Items.reduce((max, item) => Math.max(max, item.fontSize), 0)
  const titleLines: string[] = []
  if (maxFontSize > 0) {
    for (const item of page1Items) {
      if (item.fontSize === maxFontSize) {
        titleLines.push(item.text.trim())
      } else if (titleLines.length > 0) {
        break
      }
    }
  }
  const page1FontHint =
    titleLines.length > 0 ? { text: titleLines.join(' '), fontSize: maxFontSize } : undefined

  const pages: ExtractedPage[] = pageDataList.map((p, idx) => ({
    pageNum: p.pageNum,
    text: filteredPages[idx] ?? '',
    stextJson: stextJsonList[idx] as StextJson,
  }))

  return { pages, metadataTitle, page1FontHint }
}
