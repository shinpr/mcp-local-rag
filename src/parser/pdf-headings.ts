import type { Document } from 'mupdf'
import type { HeadingAnchor } from '../utils/source-context.js'
import type { FilteredPageLayout, PageData } from './pdf-filter.js'

type Outline = NonNullable<ReturnType<Document['loadOutline']>>
type PdfLine = PageData['items'][number]
type SourceLine = PdfLine & { origins: PdfLine[] }
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')

/** Match headings after the existing filter has joined lines or removed page furniture. */
function searchableText(text: string): { value: string; offsets: number[] } {
  let value = ''
  const offsets: number[] = []
  for (let i = 0; i < text.length; i++) {
    const normalized = normalize(text[i] ?? '')
    value += normalized
    offsets.push(...Array<number>(normalized.length).fill(i))
  }
  return { value, offsets }
}

function locate(text: ReturnType<typeof searchableText>, title: string): number | undefined {
  const needle = normalize(title)
  if (!needle) {
    return undefined
  }
  const index = text.value.indexOf(needle)
  // Repeated text cannot identify the source line reliably; omit it.
  return index < 0 || text.value.indexOf(needle, index + 1) >= 0 ? undefined : text.offsets[index]
}

/** Combine fragments from one native line without merging adjacent columns. */
function pageLines(page: PageData): SourceLine[] {
  const lines: SourceLine[] = []
  for (const item of page.items) {
    const last = lines.at(-1)
    const hasNativeLine =
      last !== undefined &&
      last.blockOrdinal !== undefined &&
      last.lineOrdinal !== undefined &&
      item.blockOrdinal !== undefined &&
      item.lineOrdinal !== undefined
    const sameNativeLine =
      last !== undefined &&
      hasNativeLine &&
      last.blockOrdinal === item.blockOrdinal &&
      last.lineOrdinal === item.lineOrdinal
    const adjacentUnnumberedFragment =
      last !== undefined &&
      !hasNativeLine &&
      Math.abs(last.y - item.y) < 1 &&
      Math.abs(last.fontSize - item.fontSize) < 0.5 &&
      item.x >= last.x &&
      item.x - last.x <= Math.max(1, item.fontSize * 2.5)
    if (last && (sameNativeLine || adjacentUnnumberedFragment)) {
      last.text += ` ${item.text}`
      last.origins.push(item)
    } else {
      lines.push({ ...item, origins: [item] })
    }
  }
  return lines
}

/** Match the surviving source fragments, not unrelated mentions elsewhere on the page. */
function locateLine(layout: FilteredPageLayout, line: SourceLine): number | undefined {
  const fragments = layout.textFragments.filter((fragment) =>
    line.origins.some(
      (origin) =>
        origin.blockOrdinal !== undefined &&
        origin.lineOrdinal !== undefined &&
        origin.blockOrdinal === fragment.blockOrdinal &&
        origin.lineOrdinal === fragment.lineOrdinal
    )
  )
  if (fragments.length) {
    const start = Math.min(...fragments.map((fragment) => fragment.pageTextStart))
    const end = Math.max(...fragments.map((fragment) => fragment.pageTextEnd))
    const source = searchableText(layout.text.slice(start, end))
    return source.value.startsWith(normalize(line.text)) && source.offsets[0] !== undefined
      ? start + source.offsets[0]
      : undefined
  }
  if (
    layout.textFragments.length &&
    line.origins.every(
      (origin) => origin.blockOrdinal !== undefined && origin.lineOrdinal !== undefined
    )
  ) {
    return undefined
  }
  // Without fragment provenance, accept only a unique complete line.
  let offset = 0
  const matches: number[] = []
  for (const text of layout.text.split('\n')) {
    if (normalize(text) === normalize(line.text)) {
      matches.push(offset + text.length - text.trimStart().length)
    }
    offset += text.length + 1
  }
  return matches.length === 1 ? matches[0] : undefined
}

function fontHeading(line: PdfLine, bodySize: number): Omit<HeadingAnchor, 'offset'> | undefined {
  const text = line.text.trim().replace(/\s+/g, ' ')
  const numbered = /^(\d+(?:\.\d+)*)(?:[.)]?\s+)\S/.exec(text.normalize('NFKC'))
  const bold = /bold|heavy|black|demi/i.test(`${line.fontName ?? ''} ${line.fontWeight ?? ''}`)
  const stepNumber = /^\d+[.)]\s/.test(text.normalize('NFKC'))
  const size = Math.round(line.fontSize * 2) / 2
  const box = line.bbox
  if (box && box[3] - box[1] > line.fontSize * 2 && box[2] - box[0] < line.fontSize * 2) {
    return undefined
  }
  if (!numbered && text.length > 70) {
    return undefined
  }
  if (
    text.length < 3 ||
    text.length > 120 ||
    text.split(/\s+/).length > 16 ||
    /[.!?。；;:]$/.test(text)
  ) {
    return undefined
  }
  if (/^(?:figure|fig\.|table)\s+\d/i.test(text) || /^\W*\d[\d.]*\W*$/.test(text)) {
    return undefined
  }
  if (!(size > bodySize * 1.12 || (bold && numbered && !stepNumber))) {
    return undefined
  }
  const level = numbered ? (numbered[1]?.split('.').length ?? 1) : 1
  return { text, level }
}

function flattenOutline(items: Outline, level = 1): { item: Outline[number]; level: number }[] {
  return items.flatMap((item) => [{ item, level }, ...flattenOutline(item.down ?? [], level + 1)])
}

/** Use located outline entries alone; fall back to font inference if none can be located. */
function preferOutline(
  doc: Document,
  texts: ReturnType<typeof searchableText>[],
  result: HeadingAnchor[][],
  lines: Pick<HeadingAnchor, 'text' | 'offset'>[][]
): HeadingAnchor[][] {
  let outline: Outline
  try {
    outline = doc.loadOutline() ?? []
  } catch {
    return result
  }
  const located: HeadingAnchor[][] = result.map(() => [])
  for (const { item, level } of flattenOutline(outline)) {
    const title = item.title?.trim()
    const page = item.page
    if (!title || page === undefined || !texts[page]) {
      continue
    }
    const anchors = lines[page]
    if (!anchors) {
      continue
    }
    const existing = anchors.filter((anchor) => {
      const withoutNumber = anchor.text.normalize('NFKC').replace(/^\d+(?:\.\d+)*[.)]?\s+/, '')
      return (
        normalize(anchor.text) === normalize(title) || normalize(withoutNumber) === normalize(title)
      )
    })
    const offset = existing.length === 1 ? existing[0]?.offset : locate(texts[page], title)
    if (offset === undefined) {
      continue
    }
    located[page]?.push({ offset, level, text: title })
  }
  return located.some((anchors) => anchors.length) ? located : result
}

/** Best-effort structure from data already extracted by MuPDF; no OCR or extra model calls. */
export function pdfHeadings(
  doc: Document,
  pages: readonly PageData[],
  layouts: readonly FilteredPageLayout[]
): HeadingAnchor[][] {
  const weights = new Map<number, number>()
  for (const page of pages) {
    for (const item of page.items) {
      const size = Math.round(item.fontSize * 2) / 2
      weights.set(size, (weights.get(size) ?? 0) + item.text.trim().length)
    }
  }
  const bodySize = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12
  const texts = layouts.map((layout) => searchableText(layout.text))
  const lines = pages.map((page, index) =>
    pageLines(page).flatMap((line) => {
      const layout = layouts[index]
      const offset = layout ? locateLine(layout, line) : undefined
      return offset === undefined ? [] : [{ ...line, offset }]
    })
  )
  const result = lines.map((page) =>
    page.flatMap((line) => {
      const heading = fontHeading(line, bodySize)
      return heading ? [{ ...heading, offset: line.offset }] : []
    })
  )
  return preferOutline(doc, texts, result, lines).map((anchors) =>
    anchors.sort((a, b) => a.offset - b.offset)
  )
}
