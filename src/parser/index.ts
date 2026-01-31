// DocumentParser implementation with PDF/DOCX/PPTX/XLSX/TXT/MD and text-based config/code support

import { existsSync, statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import * as XLSX from 'xlsx'
import { type EmbedderInterface, type PageData, filterPageBoundarySentences } from './pdf-filter.js'

// ============================================
// Type Definitions
// ============================================

type CustomParser = (filePath: string) => Promise<string>

interface CustomParserSpec {
  module: string
  export?: string
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.rst'])
const CODE_EXTENSIONS = new Set([
  '.py',
  '.pyi',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.hpp',
  '.cpp',
  '.cc',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
  '.lua',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.vue',
  '.svelte',
  '.dart',
  '.r',
  '.m',
  '.mm',
  '.pl',
  '.pm',
  '.t',
])
const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.settings',
  '.env',
])
const CSV_EXTENSIONS = new Set(['.csv', '.tsv'])
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls'])
const POWERPOINT_EXTENSIONS = new Set(['.pptx'])

const DEFAULT_PARSER_CONFIG = resolve(process.cwd(), 'config', 'file_parsers.json')

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
 * Document parser class (PDF/DOCX/PPTX/XLSX/TXT/MD + config/code support)
 *
 * Responsibilities:
 * - File path validation (path traversal prevention)
 * - File size validation (100MB limit)
 * - Parse common formats (PDF/DOCX/PPTX/XLSX/TXT/MD + config/code)
 */
export class DocumentParser {
  private readonly config: ParserConfig
  private readonly customParserConfigPath: string
  private customParsersLoaded = false
  private readonly customParsers = new Map<string, CustomParser>()

  constructor(config: ParserConfig) {
    this.config = config
    this.customParserConfigPath = process.env['MCP_LOCAL_RAG_PARSERS'] || DEFAULT_PARSER_CONFIG
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
   * Directory path validation (Absolute path requirement + Path traversal prevention)
   *
   * @param directoryPath - Directory path to validate (must be absolute)
   * @throws ValidationError - When path is not absolute or outside BASE_DIR
   */
  validateDirectoryPath(directoryPath: string): void {
    // Check if path is absolute
    if (!isAbsolute(directoryPath)) {
      throw new ValidationError(
        `Directory path must be absolute path (received: ${directoryPath}). Please provide an absolute path within BASE_DIR.`
      )
    }

    // Check if path is within BASE_DIR
    const baseDir = resolve(this.config.baseDir)
    const normalizedPath = resolve(directoryPath)

    if (!normalizedPath.startsWith(baseDir)) {
      throw new ValidationError(
        `Directory path must be within BASE_DIR (${baseDir}). Received path outside BASE_DIR: ${directoryPath}`
      )
    }
  }

  private normalizeExtension(extension: string): string | null {
    const trimmed = extension.trim()
    if (!trimmed) {
      return null
    }
    return trimmed.startsWith('.') ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`
  }

  private async ensureCustomParsersLoaded(): Promise<void> {
    if (this.customParsersLoaded) {
      return
    }

    this.customParsersLoaded = true

    if (!existsSync(this.customParserConfigPath)) {
      return
    }

    try {
      const raw = await readFile(this.customParserConfigPath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, string | CustomParserSpec>

      for (const [extension, spec] of Object.entries(data)) {
        const normalized = this.normalizeExtension(extension)
        if (!normalized) {
          continue
        }

        const moduleSpec: CustomParserSpec = typeof spec === 'string' ? { module: spec } : spec
        if (!moduleSpec?.module) {
          console.warn(`Custom parser for ${normalized} missing module path`)
          continue
        }

        const isFilePath = moduleSpec.module.startsWith('.') || moduleSpec.module.startsWith('/')
        const resolvedPath = isFilePath
          ? resolve(process.cwd(), moduleSpec.module)
          : moduleSpec.module
        const importTarget = isFilePath ? pathToFileURL(resolvedPath).href : resolvedPath

        try {
          const mod = await import(importTarget)
          const handler =
            (moduleSpec.export && mod[moduleSpec.export]) ||
            mod.default ||
            mod.parseFile ||
            mod.parse

          if (typeof handler !== 'function') {
            console.warn(`Custom parser for ${normalized} did not export a function`)
            continue
          }

          this.customParsers.set(normalized, handler as CustomParser)
        } catch (error) {
          console.warn(`Failed to load custom parser for ${normalized}:`, error)
        }
      }
    } catch (error) {
      console.warn(`Failed to read custom parser config: ${this.customParserConfigPath}`, error)
    }
  }

  async getSupportedExtensions(): Promise<string[]> {
    await this.ensureCustomParsersLoaded()
    const builtIn = new Set<string>([
      '.pdf',
      '.docx',
      ...MARKDOWN_EXTENSIONS,
      ...TEXT_EXTENSIONS,
      ...CODE_EXTENSIONS,
      ...CONFIG_EXTENSIONS,
      ...CSV_EXTENSIONS,
      ...EXCEL_EXTENSIONS,
      ...POWERPOINT_EXTENSIONS,
    ])

    for (const customExt of this.customParsers.keys()) {
      builtIn.add(customExt)
    }

    return Array.from(builtIn).sort()
  }

  async listFilesInDirectory(options: {
    directoryPath: string
    recursive?: boolean
    includeHidden?: boolean
    extensions?: string[]
  }): Promise<string[]> {
    const { directoryPath, recursive = true, includeHidden = false } = options
    this.validateDirectoryPath(directoryPath)

    const stats = await stat(directoryPath)
    if (!stats.isDirectory()) {
      throw new ValidationError(`Path is not a directory: ${directoryPath}`)
    }

    const supported = options.extensions
      ? options.extensions
          .map((ext) => this.normalizeExtension(ext))
          .filter((ext): ext is string => Boolean(ext))
      : await this.getSupportedExtensions()
    const supportedSet = new Set(supported)

    const results: string[] = []
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) {
          continue
        }
        const fullPath = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          if (recursive) {
            await walk(fullPath)
          }
          continue
        }
        if (!entry.isFile()) {
          continue
        }
        const ext = extname(entry.name).toLowerCase()
        if (supportedSet.has(ext)) {
          results.push(fullPath)
        }
      }
    }

    await walk(directoryPath)
    return results
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

    // Format detection (PDF uses parsePdf directly)
    await this.ensureCustomParsersLoaded()
    const ext = extname(filePath).toLowerCase()

    const customParser = this.customParsers.get(ext)
    if (customParser) {
      return await customParser(filePath)
    }

    switch (ext) {
      case '.docx':
        return await this.parseDocx(filePath)
      case '.pptx':
        return await this.parsePptx(filePath)
      case '.xlsx':
      case '.xls':
        return await this.parseXlsx(filePath)
      default:
        if (ext === '.txt') {
          return await this.parseTxt(filePath)
        }
        if (MARKDOWN_EXTENSIONS.has(ext)) {
          return await this.parseMd(filePath)
        }
        if (
          TEXT_EXTENSIONS.has(ext) ||
          CODE_EXTENSIONS.has(ext) ||
          CONFIG_EXTENSIONS.has(ext) ||
          CSV_EXTENSIONS.has(ext)
        ) {
          return await this.parseText(filePath, 'TXT')
        }
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
   *
   * @param filePath - PDF file path
   * @param embedder - Embedder for semantic header/footer detection
   * @returns Parsed text with header/footer removed
   * @throws FileOperationError - File read failed, parse failed
   */
  async parsePdf(filePath: string, embedder: EmbedderInterface): Promise<string> {
    // Validation
    this.validateFilePath(filePath)
    this.validateFileSize(filePath)

    try {
      const buffer = await readFile(filePath)
      const pdf = await getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise

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

      // Apply sentence-level header/footer filtering
      // This handles variable content like page numbers ("7 of 75") using semantic similarity
      const text = await filterPageBoundarySentences(pages, embedder)

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
   * PPTX parsing (slides text)
   *
   * @param filePath - PPTX file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed, parse failed
   */
  private async parsePptx(filePath: string): Promise<string> {
    try {
      const buffer = await readFile(filePath)
      const zip = await JSZip.loadAsync(buffer)
      const slideEntries = Object.keys(zip.files)
        .filter((name) => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

      const notesEntries = Object.keys(zip.files)
        .filter((name) => name.startsWith('ppt/notesSlides/notesSlide') && name.endsWith('.xml'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

      const sections: string[] = []
      for (const name of [...slideEntries, ...notesEntries]) {
        const xml = await zip.files[name]?.async('string')
        if (!xml) {
          continue
        }
        const text = this.extractPptxText(xml)
        if (text.trim()) {
          sections.push(text)
        }
      }

      const combined = sections.join('\n\n')
      console.error(`Parsed PPTX: ${filePath} (${combined.length} characters)`)
      return combined
    } catch (error) {
      throw new FileOperationError(`Failed to parse PPTX: ${filePath}`, error as Error)
    }
  }

  /**
   * XLSX/XLS parsing (sheet text)
   *
   * @param filePath - Excel file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed, parse failed
   */
  private async parseXlsx(filePath: string): Promise<string> {
    try {
      const buffer = await readFile(filePath)
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const sections: string[] = []
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        if (!sheet) {
          continue
        }
        const csv = XLSX.utils.sheet_to_csv(sheet)
        if (csv.trim()) {
          sections.push(`Sheet: ${sheetName}\n${csv}`)
        }
      }
      const combined = sections.join('\n\n')
      console.error(`Parsed XLSX: ${filePath} (${combined.length} characters)`)
      return combined
    } catch (error) {
      throw new FileOperationError(`Failed to parse XLSX: ${filePath}`, error as Error)
    }
  }

  private decodeXmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(Number.parseInt(num, 10)))
  }

  private extractPptxText(xml: string): string {
    const matches = Array.from(xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/g))
    return matches.map((match) => this.decodeXmlEntities(match[1] || '')).join(' ')
  }

  private async parseText(filePath: string, label: string): Promise<string> {
    try {
      const text = await readFile(filePath, 'utf-8')
      console.error(`Parsed ${label}: ${filePath} (${text.length} characters)`)
      return text
    } catch (error) {
      throw new FileOperationError(`Failed to parse ${label}: ${filePath}`, error as Error)
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
    return await this.parseText(filePath, 'TXT')
  }

  /**
   * MD parsing (using fs.readFile)
   *
   * @param filePath - MD file path
   * @returns Parsed text
   * @throws FileOperationError - File read failed
   */
  private async parseMd(filePath: string): Promise<string> {
    return await this.parseText(filePath, 'MD')
  }
}
