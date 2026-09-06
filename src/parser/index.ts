// DocumentParser implementation with PDF/DOCX/TXT/MD support

import { statSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import mammoth from 'mammoth'
import type { Document as MupdfDocument } from 'mupdf'
import { type AtomicTextRange, SemanticChunker } from '../chunker/index.js'
import { withTrailingSeparator } from '../utils/base-dirs.js'
import { AppError, isAppError, toError } from '../utils/errors.js'
import { errorCode } from '../utils/type-guards.js'
import { convertDocxDocumentToText, extractDocxCoreTitle } from './docx-parser.js'
import { extractPdfPages } from './pdf-extract.js'
import type { EmbedderInterface, FilteredTextFragment } from './pdf-filter.js'
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
  atomicRanges?: readonly AtomicTextRange[]
  imageAnchors?: readonly ParsedImageAnchor[]
}

export interface ParsedImageAnchor {
  offset: number
  imageIndex: number
  mimeType: 'image/png' | 'image/jpeg'
  bytes: Uint8Array
}

export interface ParseFileOptions {
  images?: boolean
}

/** Title candidates a PDF carries before its text is chunked. */
interface PdfTitleHints {
  metadataTitle: string | undefined
  page1FontHint: { text: string; fontSize: number } | undefined
}

async function resolvePdfTitle(
  filePath: string,
  pages: readonly { text: string }[],
  hints: PdfTitleHints,
  embedder: EmbedderInterface
): Promise<string> {
  const { metadataTitle, page1FontHint } = hints
  const fileName = basename(filePath)
  let firstPageChunkText: string | undefined
  try {
    const filteredPage1 = pages[0]?.text
    if (filteredPage1 && filteredPage1.trim().length > 0) {
      const page1Chunks = await new SemanticChunker().chunkText(filteredPage1, embedder)
      firstPageChunkText = page1Chunks[0]?.text
    }
  } catch (titleError) {
    if (isAppError(titleError)) {
      throw titleError
    }
    console.error(`Title extraction failed, falling back to filename: ${titleError}`)
  }
  return extractPdfTitle(metadataTitle, firstPageChunkText, fileName, page1FontHint).title
}

/**
 * DocumentParser configuration. Exactly one of `baseDir` (legacy single root)
 * or `baseDirs` must be supplied; the constructor rejects both, so a
 * misconfiguration cannot silently pick one.
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
export class ValidationError extends AppError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, 'parser', 'validation', options)
    this.name = 'ValidationError'
  }
}

/**
 * File operation error (equivalent to 500)
 */
export class FileOperationError extends AppError {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, 'parser', 'io', options)
    this.name = 'FileOperationError'
  }
}

// ============================================
// DocumentParser Class
// ============================================

/** Path and size validation plus PDF/DOCX/TXT/MD parsing. */
export class DocumentParser {
  private readonly config: ParserConfig
  /** Raw allowed roots in input order (pre-realpath). Always non-empty. */
  private readonly rawBaseDirs: readonly string[]
  /**
   * Realpath-normalized allowed roots, each with a trailing separator so the
   * `startsWith` check cannot match a sibling (`/foo/bar/` vs `/foo/barista/`).
   * Cached for the process lifetime.
   */
  private resolvedBaseDirs: string[] | null = null

  constructor(config: ParserConfig) {
    this.config = config
    // `baseDirs` wins so a future relaxation of the type cannot fall back to
    // the legacy field. An empty list is accepted only so the parser is
    // constructible in the server's degraded mode; `validateFilePath` then
    // fails closed, accepting nothing.
    if (config.baseDirs !== undefined) {
      this.rawBaseDirs = config.baseDirs
    } else {
      this.rawBaseDirs = [config.baseDir]
    }
  }

  /**
   * THE place realpath is used: following symlinks here is what makes prefix
   * containment unforgeable. Everything else stores and looks up resolve()
   * paths — see {@link BaseDirsConfig}.
   *
   * A file is accepted iff its realpath — or, for a not-yet-existing
   * non-symlink, its resolve()d path — sits under any allowed root. A broken
   * symlink is rejected outright.
   */
  async validateFilePath(filePath: string): Promise<void> {
    // Fail closed in degraded mode: an empty allow-list must reject every
    // path, not run a prefix check against no roots. `assertConfigOk` should
    // fire first; this covers paths that bypass it.
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
          { cause: toError(error) }
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

  /** @throws ValidationError when the file exceeds the configured size limit. */
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
      if (errorCode(error) === 'ENOENT') {
        throw new ValidationError(`File not found: ${filePath}`)
      }
      throw new FileOperationError(`Failed to check file size: ${filePath}`, {
        cause: toError(error),
      })
    }
  }

  /** Parse a file, detecting the format from its extension. */
  async parseFile(filePath: string, options: ParseFileOptions = {}): Promise<ParseResult> {
    // Validation
    await this.validateFilePath(filePath)
    this.validateFileSize(filePath)

    // Format detection (PDF uses parsePdf directly)
    const ext = extname(filePath).toLowerCase()
    switch (ext) {
      case '.docx':
        return await this.parseDocx(filePath, options.images === true)
      case '.txt':
        return await this.parseTxt(filePath)
      case '.md':
        return await this.parseMd(filePath)
      default:
        throw new ValidationError(`Unsupported file format: ${ext}`)
    }
  }

  /**
   * PDF parsing. Headers and footers are detected semantically by embedding
   * similarity across pages, not by position alone, and the title comes from
   * PDF metadata with a first-page largest-font fallback.
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
      doc = mupdf.Document.openDocument(buffer, 'application/pdf')

      const { pages, metadataTitle, page1FontHint } = await extractPdfPages(
        doc,
        embedder,
        'preserve-whitespace'
      )
      const text = pages
        .map((p) => p.text)
        .filter((t) => t.length > 0)
        .join('\n\n')

      const title = await resolvePdfTitle(
        filePath,
        pages,
        { metadataTitle, page1FontHint },
        embedder
      )

      console.error(`Parsed PDF: ${filePath} (${text.length} characters, ${pages.length} pages)`)

      return { content: text, title }
    } catch (error) {
      // A foreign domain error (an `EmbeddingError` raised while the parser
      // used the embedder) keeps its identity rather than being relabelled a
      // PDF failure. Only a genuine non-`AppError` wraps as `FileOperationError`.
      if (isAppError(error)) {
        throw error
      }
      throw new FileOperationError(`Failed to parse PDF: ${filePath}`, { cause: toError(error) })
    } finally {
      // Release the native WASM handle exactly once per invocation, on both
      // success and error paths.
      doc?.destroy()
    }
  }

  /**
   * Per-page PDF parsing for the visual path. Adds `preserve-images` so mupdf
   * emits the image blocks the visual detector needs, and returns the open
   * `Document` so the renderer can work on the same handle.
   *
   * Disposal is asymmetric: on success the CALLER owns `doc` and must
   * `finally { doc.destroy() }`; on throw `doc` is already destroyed here, so
   * the caller must NOT destroy it.
   */
  async parsePdfPages(
    filePath: string,
    embedder: EmbedderInterface
  ): Promise<{
    doc: MupdfDocument
    title: string
    pages: Array<{
      pageNum: number
      text: string
      textFragments: FilteredTextFragment[]
      stextJson: unknown
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
      doc = mupdf.Document.openDocument(buffer, 'application/pdf')
      const extracted = await extractPdfPages(doc, embedder, 'preserve-whitespace,preserve-images')

      const { pages: helperPages, metadataTitle, page1FontHint } = extracted
      const pages = helperPages.map((page) => ({
        pageNum: page.pageNum,
        text: page.text,
        textFragments: page.textFragments,
        stextJson: page.stextJson,
      }))
      const title = await resolvePdfTitle(
        filePath,
        helperPages,
        { metadataTitle, page1FontHint },
        embedder
      )

      console.error(
        `Parsed PDF pages: ${filePath} (${pages.length} pages; caller owns doc disposal)`
      )

      return { doc, title, pages }
    } catch (error) {
      // `doc` is undefined when `openDocument` itself threw — nothing to free.
      // When it is defined, dispose before re-throwing (on BOTH the foreign and
      // the genuine error paths) so the caller never receives the handle and
      // cannot be expected to clean it up.
      doc?.destroy()
      // A foreign domain error (e.g. `EmbeddingError`) keeps its identity —
      // rethrow it unchanged. Only a genuine non-`AppError` IO/mupdf failure
      // wraps as `FileOperationError` with its `.cause` set.
      if (isAppError(error)) {
        throw error
      }
      throw new FileOperationError(`Failed to parse PDF pages: ${filePath}`, {
        cause: toError(error),
      })
    }
  }

  /**
   * DOCX parsing. One Mammoth HTML conversion serves both title and body, so
   * the document is not converted twice.
   */
  private async parseDocx(filePath: string, includeImages: boolean): Promise<ParseResult> {
    try {
      const buffer = await readFile(filePath)
      const capturedImages = new Map<
        number,
        { mimeType: ParsedImageAnchor['mimeType']; bytes: Uint8Array }
      >()
      let nextImageIndex = 0
      let skippedImageCount = 0
      const htmlResult = includeImages
        ? await mammoth.convertToHtml(
            { buffer },
            {
              convertImage: mammoth.images.imgElement(async (image) => {
                const imageIndex = nextImageIndex++
                if (image.contentType !== 'image/png' && image.contentType !== 'image/jpeg') {
                  skippedImageCount += 1
                  return { src: `data:${image.contentType};base64,` }
                }
                const bytes = await image.readAsBuffer().catch(() => null)
                if (bytes === null) {
                  skippedImageCount += 1
                  return { src: `data:${image.contentType};base64,` }
                }
                capturedImages.set(imageIndex, { mimeType: image.contentType, bytes })
                return {
                  src: `data:${image.contentType};base64,`,
                  'data-rag-image-index': String(imageIndex),
                }
              }),
            }
          )
        : await mammoth.convertToHtml({ buffer })
      const htmlDocument = new JSDOM(htmlResult.value).window.document
      const coreTitle = await extractDocxCoreTitle(buffer)
      const body = convertDocxDocumentToText(htmlDocument)
      const fileName = basename(filePath)
      const titleResult = extractDocxTitle(htmlDocument, fileName, coreTitle)

      console.error(`Parsed DOCX: ${filePath} (${body.content.length} characters)`)
      if (skippedImageCount > 0) {
        console.warn(
          `Skipped ${skippedImageCount} unsupported or unreadable DOCX image(s) in ${filePath}; only embedded PNG and JPEG are supported`
        )
      }
      const imageAnchors = (body.imageAnchors ?? []).flatMap((anchor) => {
        const captured = capturedImages.get(anchor.imageIndex)
        return captured ? [{ ...anchor, ...captured }] : []
      })
      return {
        content: body.content,
        title: titleResult.title,
        ...(body.atomicRanges.length === 0 ? {} : { atomicRanges: body.atomicRanges }),
        ...(imageAnchors.length === 0 ? {} : { imageAnchors }),
      }
    } catch (error) {
      throw new FileOperationError(`Failed to parse DOCX: ${filePath}`, { cause: toError(error) })
    }
  }

  /** TXT parsing. */
  private async parseTxt(filePath: string): Promise<ParseResult> {
    try {
      const text = await readFile(filePath, 'utf-8')
      const fileName = basename(filePath)
      const titleResult = extractTxtTitle(text, fileName)
      console.error(`Parsed TXT: ${filePath} (${text.length} characters)`)
      return { content: text, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse TXT: ${filePath}`, { cause: toError(error) })
    }
  }

  /** MD parsing. */
  private async parseMd(filePath: string): Promise<ParseResult> {
    try {
      const text = await readFile(filePath, 'utf-8')
      const fileName = basename(filePath)
      const titleResult = extractMarkdownTitle(text, fileName)
      console.error(`Parsed MD: ${filePath} (${text.length} characters)`)
      return { content: text, title: titleResult.title }
    } catch (error) {
      throw new FileOperationError(`Failed to parse MD: ${filePath}`, { cause: toError(error) })
    }
  }
}
