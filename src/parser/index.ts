// DocumentParser implementation with PDF/DOCX/TXT/MD support

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'

// ============================================
// Type Definitions
// ============================================

/**
 * DocumentParser configuration
 */
export interface ParserConfig {
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

  constructor(config: ParserConfig) {
    this.config = config
  }

  /**
   * File path validation (Absolute path requirement + Path traversal prevention)
   *
   * @param filePath - File path to validate (must be absolute)
   * @throws ValidationError - When path is not absolute or outside BASE_DIR
   */
  validateFilePath(filePath: string): void {
    // Check if path is absolute
    if (!isAbsolute(filePath)) {
      throw new ValidationError(
        `File path must be absolute path (received: ${filePath}). Please provide an absolute path within BASE_DIR.`
      )
    }

    // Check if path is within BASE_DIR
    const baseDir = resolve(this.config.baseDir)
    const normalizedPath = resolve(filePath)

    if (!normalizedPath.startsWith(baseDir)) {
      throw new ValidationError(
        `File path must be within BASE_DIR (${baseDir}). Received path outside BASE_DIR: ${filePath}`
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
   * @returns Parsed text
   * @throws ValidationError - Path traversal, size exceeded, unsupported format
   * @throws FileOperationError - File read failed, parse failed
   */
  async parseFile(filePath: string): Promise<string> {
    // Validation
    this.validateFilePath(filePath)
    this.validateFileSize(filePath)

    // Format detection
    const ext = extname(filePath).toLowerCase()
    switch (ext) {
      case '.pdf':
        return await this.parsePdf(filePath)
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
   * PDF parsing (using unpdf with PDF.js engine)
   *
   * @param filePath - PDF file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed, parse failed
   */
  private async parsePdf(filePath: string): Promise<string> {
    try {
      const buffer = await readFile(filePath)
      const pdf = await getDocumentProxy(new Uint8Array(buffer))
      // Use mergePages: false to preserve line breaks for better sentence detection
      const { text: pages } = await extractText(pdf, { mergePages: false })
      const text = (pages as string[]).join('\n\n')
      console.error(`Parsed PDF: ${filePath} (${text.length} characters, ${pdf.numPages} pages)`)
      return text
    } catch (error) {
      throw new FileOperationError(`Failed to parse PDF: ${filePath}`, error as Error)
    }
  }

  /**
   * DOCX parsing (using mammoth)
   *
   * @param filePath - DOCX file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed, parse failed
   */
  private async parseDocx(filePath: string): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ path: filePath })
      console.error(`Parsed DOCX: ${filePath} (${result.value.length} characters)`)
      return result.value
    } catch (error) {
      throw new FileOperationError(`Failed to parse DOCX: ${filePath}`, error as Error)
    }
  }

  /**
   * TXT parsing (using fs.readFile)
   *
   * @param filePath - TXT file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed
   */
  private async parseTxt(filePath: string): Promise<string> {
    try {
      const text = await readFile(filePath, 'utf-8')
      console.error(`Parsed TXT: ${filePath} (${text.length} characters)`)
      return text
    } catch (error) {
      throw new FileOperationError(`Failed to parse TXT: ${filePath}`, error as Error)
    }
  }

  /**
   * MD parsing (using fs.readFile)
   *
   * @param filePath - MD file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed
   */
  private async parseMd(filePath: string): Promise<string> {
    try {
      const text = await readFile(filePath, 'utf-8')
      console.error(`Parsed MD: ${filePath} (${text.length} characters)`)
      return text
    } catch (error) {
      throw new FileOperationError(`Failed to parse MD: ${filePath}`, error as Error)
    }
  }
}
