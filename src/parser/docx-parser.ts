import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import type { AtomicTextRange } from '../chunker/index.js'

const CORE_TITLE_NAMESPACE = 'http://purl.org/dc/elements/1.1/'
const PROSE_BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'PRE'])
const LIST_TAGS = new Set(['UL', 'OL'])
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

export interface DocxBodyResult {
  content: string
  atomicRanges: readonly AtomicTextRange[]
}

interface EmittedBlock {
  text: string
  atomic: boolean
}

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeTextContent(element: Element): string {
  const parts: string[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '')
      return
    }
    if (node.nodeType !== 1) return

    const child = node as Element
    if (SKIPPED_TAGS.has(child.tagName)) return
    if (child.tagName === 'BR') {
      parts.push(' ')
      return
    }

    const ownsTextBoundary =
      PROSE_BLOCK_TAGS.has(child.tagName) || LIST_TAGS.has(child.tagName) || child.tagName === 'LI'
    if (ownsTextBoundary) parts.push(' ')
    for (const descendant of child.childNodes) visit(descendant)
    if (ownsTextBoundary) parts.push(' ')
  }

  for (const child of element.childNodes) visit(child)
  return normalizeSingleLine(parts.join(''))
}

function serializeInlineText(element: Element): string {
  const parts: string[] = []

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '')
      return
    }
    if (node.nodeType !== 1) return

    const child = node as Element
    if (SKIPPED_TAGS.has(child.tagName)) return
    if (child.tagName === 'BR') {
      parts.push('\n')
      return
    }
    for (const descendant of child.childNodes) visit(descendant)
  }

  for (const child of element.childNodes) visit(child)

  const lines = parts.join('').split('\n').map(normalizeSingleLine)
  while (lines[0] === '') lines.shift()
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

function serializeList(list: Element): string {
  const lines: string[] = []

  const serializeListElement = (currentList: Element): void => {
    for (const child of currentList.children) {
      if (child.tagName !== 'LI') continue

      let currentLine = ''
      const flush = (): void => {
        const normalized = normalizeSingleLine(currentLine)
        if (normalized) lines.push(normalized)
        currentLine = ''
      }
      const visitItemNode = (node: Node): void => {
        if (node.nodeType === 3) {
          currentLine += node.nodeValue ?? ''
          return
        }
        if (node.nodeType !== 1) return

        const element = node as Element
        if (SKIPPED_TAGS.has(element.tagName)) return
        if (element.tagName === 'BR') {
          flush()
          return
        }
        if (LIST_TAGS.has(element.tagName)) {
          flush()
          serializeListElement(element)
          return
        }
        for (const descendant of element.childNodes) visitItemNode(descendant)
      }

      for (const itemChild of child.childNodes) visitItemNode(itemChild)
      flush()
    }
  }

  serializeListElement(list)
  return lines.join('\n')
}

function directTableRows(table: Element): Element[] {
  return Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table)
}

function directRowCells(row: Element): Element[] {
  return Array.from(row.children).filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
}

function hasSpanningCell(cells: readonly Element[]): boolean {
  return cells.some((cell) => {
    const rowSpan = Number.parseInt(cell.getAttribute('rowspan') ?? '1', 10)
    const columnSpan = Number.parseInt(cell.getAttribute('colspan') ?? '1', 10)
    return rowSpan > 1 || columnSpan > 1
  })
}

function isSupportedTable(table: Element, rows: readonly Element[]): boolean {
  if (table.querySelector('table') !== null || rows.length < 2) return false

  const rowCells = rows.map(directRowCells)
  const columnCount = rowCells[0]?.length ?? 0
  return (
    columnCount > 0 &&
    rowCells.every((cells) => cells.length === columnCount && !hasSpanningCell(cells))
  )
}

function collectTextTokens(element: Element): string {
  const tokens: string[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const token = normalizeSingleLine(node.nodeValue ?? '')
      if (token) tokens.push(token)
      return
    }
    if (node.nodeType !== 1) return

    const child = node as Element
    if (SKIPPED_TAGS.has(child.tagName)) return
    for (const descendant of child.childNodes) visit(descendant)
  }
  visit(element)
  return tokens.join(' ')
}

function emitTable(table: Element): EmittedBlock[] {
  const rows = directTableRows(table)
  const headerRow = rows[0]
  if (!isSupportedTable(table, rows) || headerRow === undefined) {
    const text = collectTextTokens(table)
    return text ? [{ text, atomic: false }] : []
  }

  // Ordinary Word tables often contain only td cells, so the approved contract
  // deliberately treats the first physical row as labels even without th markup.
  const headers = directRowCells(headerRow).map((cell, index) => {
    const text = normalizeTextContent(cell)
    return text || `Column ${index + 1}`
  })

  return rows.slice(1).flatMap((row) => {
    const values = directRowCells(row)
    const text = values
      .map(
        (cell, index) => `${headers[index] ?? `Column ${index + 1}`}: ${normalizeTextContent(cell)}`
      )
      .join('\n')
    return text ? [{ text, atomic: true }] : []
  })
}

function hasRecognizedBlockDescendant(element: Element): boolean {
  return Array.from(element.querySelectorAll('*')).some(
    (descendant) =>
      PROSE_BLOCK_TAGS.has(descendant.tagName) ||
      LIST_TAGS.has(descendant.tagName) ||
      descendant.tagName === 'TABLE'
  )
}

function emitDocumentBlocks(document: Document): EmittedBlock[] {
  const blocks: EmittedBlock[] = []

  const emitElement = (element: Element): void => {
    if (SKIPPED_TAGS.has(element.tagName)) return
    if (PROSE_BLOCK_TAGS.has(element.tagName)) {
      const text = serializeInlineText(element)
      if (text) blocks.push({ text, atomic: false })
      return
    }
    if (LIST_TAGS.has(element.tagName)) {
      const text = serializeList(element)
      if (text) blocks.push({ text, atomic: false })
      return
    }
    if (element.tagName === 'TABLE') {
      blocks.push(...emitTable(element))
      return
    }
    if (!hasRecognizedBlockDescendant(element)) {
      const text = normalizeTextContent(element)
      if (text) blocks.push({ text, atomic: false })
      return
    }
    for (const child of element.childNodes) emitNode(child)
  }

  const emitNode = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = normalizeSingleLine(node.nodeValue ?? '')
      if (text) blocks.push({ text, atomic: false })
      return
    }
    if (node.nodeType === 1) emitElement(node as Element)
  }

  for (const node of document.body.childNodes) emitNode(node)
  return blocks
}

export async function extractDocxCoreTitle(buffer: Buffer): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(buffer)
  const coreProperties = zip.file('docProps/core.xml')
  if (!coreProperties) return undefined

  const xml = await coreProperties.async('string')
  try {
    const document = new JSDOM(xml, { contentType: 'text/xml' }).window.document
    if (document.querySelector('parsererror')) return undefined

    const title = document.getElementsByTagNameNS(CORE_TITLE_NAMESPACE, 'title').item(0)
    const normalized = normalizeSingleLine(title?.textContent ?? '')
    return normalized || undefined
  } catch {
    // Core properties are optional display metadata; malformed XML falls
    // through to the heading/filename chain without rejecting readable body text.
    return undefined
  }
}

export function convertDocxDocumentToText(document: Document): DocxBodyResult {
  const blocks = emitDocumentBlocks(document)
  let content = ''
  const atomicRanges: AtomicTextRange[] = []

  for (const block of blocks) {
    if (content) content += '\n\n'
    const start = content.length
    content += block.text
    if (block.atomic) atomicRanges.push({ start, end: content.length })
  }

  return { content, atomicRanges }
}
