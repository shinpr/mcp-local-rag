// DocumentParser implementation with PDF/DOCX/TXT/MD support

import { statSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import mammoth from 'mammoth'
import type { Document as MupdfDocument } from 'mupdf'
import { SemanticChunker } from '../chunker/index.js'
import { withTrailingSeparator } from '../utils/base-dirs.js'
import { extractPdfPages } from './pdf-extract.js'
import type { EmbedderInterface } from './pdf-filter.js'
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
 * DocumentParser configuration.
 *
 * Accepts either a single `baseDir` (legacy single-root shape — preserved for
 * backward compatibility with downstream callers that have not yet migrated
 * to the multi-root model) or a `baseDirs` array (multi-root shape produced
 * by `resolveBaseDirs`). Exactly one of the two MUST be supplied; supplying
 * both is rejected by the constructor so misconfiguration cannot silently
 * pick one source over the other.
 *
 * Behavior under a single allowed root (`{ baseDir }` or
 * `{ baseDirs: [oneRoot] }`) is byte-identical to the previous single-root
 * implementation — see `validateFilePath` for the iteration contract under
 * multiple roots.
 */
export type ParserConfig =
  | {
      /** Security: single allowed base directory (legacy shape). */
      baseDir: string
      baseDirs?: undefined
      /** Maximum file size (100MB). */
      maxFileSize: number
    }
  | {
      /** Security: one or more allowed base directories (multi-root shape). */
      baseDirs: readonly string[]
      baseDir?: undefined
      /** Maximum file size (100MB). */
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
  /** Raw allowed roots in input order (pre-realpath). Always non-empty. */
  private readonly rawBaseDirs: readonly string[]
  /**
   * Lazily cached realpath-normalized allowed roots, each with a trailing
   * path separator so the `startsWith` check is sibling-prefix safe (e.g.
   * `/foo/bar/` must not match `/foo/barista/x.txt`). Order is preserved
   * from `rawBaseDirs` so the legacy single-root rejection message keeps
   * referencing the user-configured first root. Assumes the allowed roots
   * are stable for the process lifetime.
   */
  private resolvedBaseDirs: string[] | null = null

  constructor(config: ParserConfig) {
    this.config = config
    // Normalize the two accepted shapes into one internal raw-root list.
    // The type system already rejects supplying both fields simultaneously,
    // but defensively pick `baseDirs` first so a future relaxation does not
    // accidentally fall back to the legacy single-root field.
    //
    // Empty `baseDirs` is accepted here so the parser can be constructed in
    // the MCP server's degraded mode (configError present); `validateFilePath`
    // fails closed in that case so no file is accepted while the empty root
    // list stands. This is the only legitimate way to reach empty
    // `rawBaseDirs`; production wiring always supplies a non-empty list when
    // `configError` is absent.
    if (config.baseDirs !== undefined) {
      this.rawBaseDirs = config.baseDirs
    } else {
      this.rawBaseDirs = [config.baseDir]
    }
  }

  /**
   * File path validation (Absolute path requirement + Path traversal prevention).
   *
   * This is THE place realpath is used (with the base-dir resolver): the
   * security/containment boundary. Following symlinks here makes prefix
   * containment unforgeable. Stored/scanned/looked-up paths elsewhere use
   * resolve() — see {@link BaseDirsConfig} for the path policy.
   *
   * Multi-root semantics: a file is accepted iff its realpath (or, for a
   * non-symlink path that does not yet exist, its `resolve()`-normalized
   * absolute path) is under ANY realpath-normalized allowed root using a
   * trailing-separator prefix check. Broken symlinks are still rejected
   * outright — the lstat-based detection mirrors the previous single-root
   * behavior.
   *
   * Under a single allowed root the behavior is identical to the previous
   * single-root implementation.
   *
   * @param filePath - File path to validate (must be absolute)
   * @throws ValidationError - When path is not absolute or outside all allowed roots
   */
  async validateFilePath(filePath: string): Promise<void> {
    // Fail-closed in degraded mode: when the parser was constructed with an
    // empty allow-list (only legitimate when the MCP server is in degraded
    // mode with a configError set), reject every path with a structured
    // error rather than performing the realpath check against an empty
    // surviving-roots set. Server-level `assertConfigOk` should have fired
    // first; this is a defense-in-depth fallback for code paths that
    // bypass that gate.
    if (this.rawBaseDirs.length === 0) {
      throw new ValidationError(
        'No configured base directory: file access is disabled. Resolve the BASE_DIR / BASE_DIRS configuration error reported by the `status` tool before retrying.'
      )
    }

    // Check if path is absolute (fast-fail without syscall)
    if (!isAbsolute(filePath)) {
      throw new ValidationError(
        `File path must be absolute path (received: ${filePath}). Please provide an absolute path within a configured base directory (BASE_DIR/BASE_DIRS/--base-dir).`
      )
    }

    // Lazily resolve and cache the real path of each allowed root (follows
    // symlinks). Each entry gets a trailing separator so subsequent
    // `startsWith` checks are sibling-prefix safe.
    if (!this.resolvedBaseDirs) {
      const resolvedList: string[] = []
      for (const raw of this.rawBaseDirs) {
        const resolved = await realpath(resolve(raw))
        resolvedList.push(withTrailingSeparator(resolved))
      }
      this.resolvedBaseDirs = resolvedList
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

    // Check if resolved path is within any allowed root.
    const allowed = this.resolvedBaseDirs.some((root) => resolvedPath.startsWith(root))
    if (!allowed) {
      const rootsDisplay =
        this.resolvedBaseDirs.length === 1
          ? this.resolvedBaseDirs[0]
          : this.resolvedBaseDirs.join(', ')
      throw new ValidationError(
        `File path must be within a configured base directory (BASE_DIR/BASE_DIRS/--base-dir). Allowed roots: ${rootsDisplay}. Received path outside all configured roots: ${filePath}`
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
      // Missing file is an input error, not an I/O fault.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ValidationError(`File not found: ${filePath}`)
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
      // success and error paths.
      doc?.destroy()
    }
  }

  /**
   * Per-page PDF parsing for the visual-enrichment path.
   *
   * Opens a mupdf `Document`, delegates per-page extraction to the shared
   * `extractPdfPages` helper with the `'preserve-whitespace,preserve-images'`
   * stext option string so mupdf emits `block.type === 'image'` blocks for
   * the downstream visual-candidate detector.
   *
   * Returns the open `Document` handle alongside the per-page records and
   * title-resolution materials so the caller can:
   *   - run the renderer (`page.toPixmap()`) on the same handle,
   *   - feed `metadataTitle` + `pages[0].page1FontHint` into `extractPdfTitle`
   *     after `buildChunksAndEmbeddings` returns.
   *
   * Disposal contract (asymmetric — read carefully):
   *   - SUCCESS path: this method returns the open `doc` handle. The caller
   *     owns disposal and MUST wrap the call site in
   *     `try { ... } finally { doc.destroy() }`.
   *   - ERROR path: when this method throws, `doc` has already been destroyed
   *     internally before the exception propagates (so the caller never
   *     receives a handle it would not know to clean up). Callers MUST NOT
   *     call `doc.destroy()` on an error from this method.
   * This method does NOT compute the final title and does NOT decide visual
   * candidates — those are the dispatch site's and `pdf-visual/detector`'s
   * responsibilities, respectively.
   *
   * @param filePath - PDF file path (validated against BASE_DIR and size limit)
   * @param embedder - Embedder for semantic header/footer detection
   * @returns Open mupdf `Document`, `metadataTitle`, and per-page records.
   *          `page1FontHint` (largest-font line on page 1) is present only on `pages[0]`.
   * @throws ValidationError - Path traversal, size exceeded
   * @throws FileOperationError - File read or parse failed (after destroying `doc` internally)
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

    // Open the doc and run per-page extraction. Success-path disposal of
    // `doc` stays with the caller.
    // For the error-path window between `openDocument` and the return below,
    // destroy `doc` here before re-throwing so a failure in `extractPdfPages`
    // (or any future pre-return step) does not leak the mupdf WASM handle.
    let doc: MupdfDocument | undefined
    try {
      const buffer = await readFile(filePath)
      const mupdf = await import('mupdf')
      doc = mupdf.Document.openDocument(buffer, 'application/pdf') as MupdfDocument
      const extracted = await extractPdfPages(doc, embedder, 'preserve-whitespace,preserve-images')

      const { pages: helperPages, metadataTitle, page1FontHint } = extracted

      // Adapt the helper's top-level `page1FontHint` onto `pages[0]` per the
      // public contract.
      const pages = helperPages.map((p, idx) =>
        idx === 0 && page1FontHint !== undefined
          ? {
              pageNum: p.pageNum,
              text: p.text,
              stextJson: p.stextJson,
              page1FontHint,
            }
          : {
              pageNum: p.pageNum,
              text: p.text,
              stextJson: p.stextJson,
            }
      )

      console.error(
        `Parsed PDF pages: ${filePath} (${pages.length} pages; caller owns doc disposal)`
      )

      return { doc, metadataTitle, pages }
    } catch (error) {
      // `doc` is undefined when `openDocument` itself threw — nothing to free.
      // When it is defined, dispose before re-throwing so the caller never
      // receives the handle and cannot be expected to clean it up.
      doc?.destroy()
      throw new FileOperationError(`Failed to parse PDF pages: ${filePath}`, error as Error)
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
