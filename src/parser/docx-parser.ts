import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import type { AtomicTextRange } from '../chunker/index.js'

const CORE_TITLE_NAMESPACE = 'http://purl.org/dc/elements/1.1/'
const PROSE_BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'PRE'])
const LIST_TAGS = new Set(['UL', 'OL'])
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])
const IMAGE_MARKER_PREFIX = '\u0000rag-image:'
const IMAGE_MARKER_SUFFIX = '\u0000'
const IMAGE_MARKER_PATTERN = new RegExp(`${IMAGE_MARKER_PREFIX}(\\d+)${IMAGE_MARKER_SUFFIX}`, 'gu')

export interface DocxBodyResult {
  content: string
  atomicRanges: readonly AtomicTextRange[]
  imageAnchors?: readonly { offset: number; imageIndex: number }[]
}

interface EmittedBlock {
  text: string
  atomic: boolean
}

/** DOM element check that narrows a `Node`, replacing a bare `nodeType` test. */
function isElement(node: Node): node is Element {
  return node.nodeType === 1
}

function imageMarker(element: Element): string {
  if (element.tagName !== 'IMG') {
    return ''
  }
  const value = element.getAttribute('data-rag-image-index')
  return value !== null && /^\d+$/.test(value)
    ? `${IMAGE_MARKER_PREFIX}${value}${IMAGE_MARKER_SUFFIX}`
    : ''
}

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** What a DOCX serializer should do with one child node before descending. */
type NodeAction =
  | { kind: 'emit'; text: string }
  | { kind: 'skip' }
  | { kind: 'break' }
  | { kind: 'descend'; element: Element }

/**
 * Classify one node against the rules every DOCX serializer shares: text nodes
 * emit their value, non-elements and skipped tags are dropped, an image
 * placeholder emits its marker, and `<br>` is a line break the caller renders.
 */
function classifyNode(node: Node): NodeAction {
  if (node.nodeType === 3) {
    return { kind: 'emit', text: node.nodeValue ?? '' }
  }
  if (!isElement(node) || SKIPPED_TAGS.has(node.tagName)) {
    return { kind: 'skip' }
  }
  const marker = imageMarker(node)
  if (marker) {
    return { kind: 'emit', text: marker }
  }
  if (node.tagName === 'BR') {
    return { kind: 'break' }
  }
  return { kind: 'descend', element: node }
}

function normalizeTextContent(element: Element): string {
  const parts: string[] = []
  const visit = (node: Node): void => {
    const action = classifyNode(node)
    if (action.kind === 'skip') {
      return
    }
    if (action.kind === 'emit') {
      parts.push(action.text)
      return
    }
    if (action.kind === 'break') {
      parts.push(' ')
      return
    }

    const child = action.element
    const ownsTextBoundary =
      PROSE_BLOCK_TAGS.has(child.tagName) || LIST_TAGS.has(child.tagName) || child.tagName === 'LI'
    if (ownsTextBoundary) {
      parts.push(' ')
    }
    for (const descendant of child.childNodes) {
      visit(descendant)
    }
    if (ownsTextBoundary) {
      parts.push(' ')
    }
  }

  for (const child of element.childNodes) {
    visit(child)
  }
  return normalizeSingleLine(parts.join(''))
}

function serializeInlineText(element: Element): string {
  const parts: string[] = []

  const visit = (node: Node): void => {
    const action = classifyNode(node)
    if (action.kind === 'skip') {
      return
    }
    if (action.kind === 'emit') {
      parts.push(action.text)
      return
    }
    if (action.kind === 'break') {
      parts.push('\n')
      return
    }
    for (const descendant of action.element.childNodes) {
      visit(descendant)
    }
  }

  for (const child of element.childNodes) {
    visit(child)
  }

  const lines = parts.join('').split('\n').map(normalizeSingleLine)
  while (lines[0] === '') {
    lines.shift()
  }
  while (lines.at(-1) === '') {
    lines.pop()
  }
  return lines.join('\n')
}

function serializeList(list: Element): string {
  const lines: string[] = []

  const serializeListElement = (currentList: Element): void => {
    for (const child of currentList.children) {
      if (child.tagName === 'LI') {
        serializeListItem(child, lines, serializeListElement)
      }
    }
  }

  serializeListElement(list)
  return lines.join('\n')
}

/**
 * Append one `<li>`'s lines. A `<br>` or a nested list ends the current line,
 * and the nested list is serialized in place through `serializeNested`.
 */
function serializeListItem(
  item: Element,
  lines: string[],
  serializeNested: (list: Element) => void
): void {
  let currentLine = ''
  const flush = (): void => {
    const normalized = normalizeSingleLine(currentLine)
    if (normalized) {
      lines.push(normalized)
    }
    currentLine = ''
  }

  const visitItemNode = (node: Node): void => {
    const action = classifyNode(node)
    if (action.kind === 'skip') {
      return
    }
    if (action.kind === 'emit') {
      currentLine += action.text
      return
    }
    if (action.kind === 'break') {
      flush()
      return
    }
    if (LIST_TAGS.has(action.element.tagName)) {
      flush()
      serializeNested(action.element)
      return
    }
    for (const descendant of action.element.childNodes) {
      visitItemNode(descendant)
    }
  }

  for (const itemChild of item.childNodes) {
    visitItemNode(itemChild)
  }
  flush()
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
  if (table.querySelector('table') !== null || rows.length < 2) {
    return false
  }

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
      if (token) {
        tokens.push(token)
      }
      return
    }
    if (!isElement(node)) {
      return
    }

    const child = node
    if (SKIPPED_TAGS.has(child.tagName)) {
      return
    }
    const marker = imageMarker(child)
    if (marker) {
      tokens.push(marker)
      return
    }
    for (const descendant of child.childNodes) {
      visit(descendant)
    }
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
  const headerMarkers: string[] = []
  const headers = directRowCells(headerRow).map((cell, index) => {
    const text = normalizeTextContent(cell)
    headerMarkers.push(...(text.match(IMAGE_MARKER_PATTERN) ?? []))
    return text.replace(IMAGE_MARKER_PATTERN, '') || `Column ${index + 1}`
  })

  const rowBlocks = rows.slice(1).flatMap((row) => {
    const values = directRowCells(row)
    const text = values
      .map(
        (cell, index) => `${headers[index] ?? `Column ${index + 1}`}: ${normalizeTextContent(cell)}`
      )
      .join('\n')
    return text ? [{ text, atomic: true }] : []
  })
  const first = rowBlocks[0]
  if (first && headerMarkers.length > 0) {
    first.text = headerMarkers.join('') + first.text
  }
  return rowBlocks
}

function hasRecognizedBlockDescendant(element: Element): boolean {
  return Array.from(element.querySelectorAll('*')).some(
    (descendant) =>
      PROSE_BLOCK_TAGS.has(descendant.tagName) ||
      LIST_TAGS.has(descendant.tagName) ||
      descendant.tagName === 'TABLE'
  )
}

/** How a recognized block element turns into text, or `null` when it is not one. */
function blockSerializerFor(element: Element): ((element: Element) => string) | null {
  if (PROSE_BLOCK_TAGS.has(element.tagName)) {
    return serializeInlineText
  }
  if (LIST_TAGS.has(element.tagName)) {
    return serializeList
  }
  return null
}

function emitDocumentBlocks(document: Document): EmittedBlock[] {
  const blocks: EmittedBlock[] = []

  /** Push one non-empty prose block. */
  const pushText = (text: string): void => {
    if (text) {
      blocks.push({ text, atomic: false })
    }
  }

  const emitElement = (element: Element): void => {
    if (SKIPPED_TAGS.has(element.tagName)) {
      return
    }
    const serialize = blockSerializerFor(element)
    if (serialize !== null) {
      pushText(serialize(element))
      return
    }
    if (element.tagName === 'TABLE') {
      blocks.push(...emitTable(element))
      return
    }
    if (!hasRecognizedBlockDescendant(element)) {
      pushText(normalizeTextContent(element))
      return
    }
    for (const child of element.childNodes) {
      emitNode(child)
    }
  }

  const emitNode = (node: Node): void => {
    if (node.nodeType === 3) {
      pushText(normalizeSingleLine(node.nodeValue ?? ''))
      return
    }
    if (isElement(node)) {
      emitElement(node)
    }
  }

  for (const node of document.body.childNodes) {
    emitNode(node)
  }
  return blocks
}

export async function extractDocxCoreTitle(buffer: Buffer): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(buffer)
  const coreProperties = zip.file('docProps/core.xml')
  if (!coreProperties) {
    return undefined
  }

  const xml = await coreProperties.async('string')
  try {
    const document = new JSDOM(xml, { contentType: 'text/xml' }).window.document
    if (document.querySelector('parsererror')) {
      return undefined
    }

    const title = document.getElementsByTagNameNS(CORE_TITLE_NAMESPACE, 'title').item(0)
    const normalized = normalizeSingleLine(title?.textContent ?? '')
    return normalized || undefined
  } catch {
    // Core properties are optional display metadata; malformed XML falls
    // through to the heading/filename chain without rejecting readable body text.
    return undefined
  }
}

/** Marker-free text, with each line normalized as the body text is. */
function stripImageMarkers(text: string): string {
  return text.replace(IMAGE_MARKER_PATTERN, '').split('\n').map(normalizeSingleLine).join('\n')
}

/** Where each of a block's image markers lands once markers are stripped. */
function anchorsWithinBlock(
  blockText: string,
  matches: readonly RegExpExecArray[],
  start: number
): ImageAnchor[] {
  return matches.map((match) => ({
    offset: start + stripImageMarkers(blockText.slice(0, match.index ?? 0)).length,
    imageIndex: Number(match[1]),
  }))
}

/** Keep the first anchor per image index, in image order. */
function dedupeAnchors(imageAnchors: readonly ImageAnchor[]): ImageAnchor[] {
  const seen = new Set<number>()
  return [...imageAnchors]
    .sort((left, right) => left.imageIndex - right.imageIndex)
    .filter((anchor) => {
      if (seen.has(anchor.imageIndex)) {
        return false
      }
      seen.add(anchor.imageIndex)
      return true
    })
}

interface ImageAnchor {
  offset: number
  imageIndex: number
}

export function convertDocxDocumentToText(document: Document): DocxBodyResult {
  let content = ''
  const atomicRanges: AtomicTextRange[] = []
  const imageAnchors: ImageAnchor[] = []

  for (const block of emitDocumentBlocks(document)) {
    const matches = [...block.text.matchAll(IMAGE_MARKER_PATTERN)]
    const blockText = matches.length === 0 ? block.text : stripImageMarkers(block.text)

    // A block that is nothing but markers contributes no text: its images
    // anchor at the current end of the document instead.
    if (matches.length > 0 && !blockText) {
      imageAnchors.push(
        ...matches.map((match) => ({ offset: content.length, imageIndex: Number(match[1]) }))
      )
      continue
    }

    if (content) {
      content += '\n\n'
    }
    const start = content.length
    imageAnchors.push(...anchorsWithinBlock(block.text, matches, start))
    content += blockText
    if (block.atomic) {
      atomicRanges.push({ start, end: content.length })
    }
  }

  const uniqueImageAnchors = dedupeAnchors(imageAnchors)
  return {
    content,
    atomicRanges,
    ...(uniqueImageAnchors.length === 0 ? {} : { imageAnchors: uniqueImageAnchors }),
  }
}
