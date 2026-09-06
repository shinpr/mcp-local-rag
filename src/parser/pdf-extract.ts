// Shared per-page PDF extraction for the parser module.
//
// Lifts the per-page `toStructuredText` + header/footer-filtering loop out of
// `DocumentParser` so both `parsePdf` and `parsePdfPages` consume one helper.
// The two callers differ ONLY in the `stextOptions` they pass:
//   - `parsePdf` passes `'preserve-whitespace'`;
//   - `parsePdfPages` passes `'preserve-whitespace,preserve-images'` so mupdf
//     emits `block.type === 'image'` entries for the downstream
//     visual-candidate detector.

import type { Document as MupdfDocument, Page as MupdfPage } from 'mupdf'

import {
  type EmbedderInterface,
  type FilteredTextFragment,
  filterPageBoundaryLayouts,
  type PageData,
} from './pdf-filter.js'

interface StextBbox {
  x: number
  y: number
  w: number
  h: number
}

/** The part of mupdf's structured-text JSON this module reads. */
interface StextJson {
  blocks: Array<{
    type: string
    /** Present on image blocks; the visual detector reads it to locate rasters. */
    bbox?: StextBbox
    lines?: Array<{
      text: string
      x: number
      y: number
      bbox?: StextBbox
      font: { size: number; name?: string; weight?: string }
    }>
  }>
}

/**
 * `text` is post-header/footer-filtering; `stextJson` is the raw mupdf JSON,
 * kept for the downstream visual detector.
 */
interface ExtractedPage {
  pageNum: number
  text: string
  textFragments: FilteredTextFragment[]
  stextJson: StextJson
}

/** Result returned by `extractPdfPages`. */
interface ExtractedPdf {
  pages: ExtractedPage[]
  metadataTitle: string | undefined
  page1FontHint: { text: string; fontSize: number } | undefined
}

/**
 * Per-page extraction shared by `parsePdf` and `parsePdfPages`, which differ
 * only in `stextOptions`: `parsePdfPages` adds `preserve-images` so mupdf
 * emits the image blocks the visual detector needs.
 *
 * Disposal of `doc` stays with the caller.
 */
/**
 * Read one page's structured text, releasing the native handle either way.
 *
 * `asJSON()` is typed `string`, so this is where MuPDF's documented output
 * contract meets {@link StextJson}. Dropping malformed elements instead would
 * shift the `blockOrdinal`/`lineOrdinal` provenance recorded downstream.
 *
 * @see https://mupdf.readthedocs.io/en/1.28.0/reference/javascript/types/StructuredText.html
 */
function readPageStext(page: MupdfPage, stextOptions: string): StextJson {
  const stext = page.toStructuredText(stextOptions)
  try {
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: connects MuPDF's documented asJSON() contract to StextJson
    return JSON.parse(stext.asJSON()) as StextJson
  } finally {
    stext.destroy()
  }
}

/** Flatten a page's text blocks into the layout items the filters consume. */
type StextLine = NonNullable<StextJson['blocks'][number]['lines']>[number]

/** One structured-text line as the layout filters consume it. */
function toLineItem(
  line: StextLine,
  pageHeight: number,
  blockOrdinal: number,
  lineOrdinal: number
): PageData['items'][number] {
  const bbox = line.bbox
  return {
    text: line.text.replace(/\t/g, ' '),
    x: line.x,
    // Invert Y only for the legacy boundary detector; bbox remains in MuPDF coordinates.
    y: pageHeight - line.y,
    fontSize: line.font.size,
    hasEOL: true,
    ...(line.font.name !== undefined ? { fontName: line.font.name } : {}),
    ...(line.font.weight !== undefined ? { fontWeight: line.font.weight } : {}),
    blockOrdinal,
    lineOrdinal,
    bbox: bbox
      ? [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h]
      : [line.x, line.y, line.x, line.y],
  }
}

function collectLineItems(json: StextJson, pageHeight: number): PageData['items'] {
  const items: PageData['items'] = []
  json.blocks.forEach((block, blockOrdinal) => {
    if (block.type !== 'text' || !block.lines) {
      return
    }
    block.lines.forEach((line, lineOrdinal) => {
      items.push(toLineItem(line, pageHeight, blockOrdinal, lineOrdinal))
    })
  })
  return items
}

/** Concatenate page 1's consecutive largest-font lines as a title hint. */
function largestFontTitleHint(
  page1Items: PageData['items']
): { text: string; fontSize: number } | undefined {
  const maxFontSize = page1Items.reduce((max, item) => Math.max(max, item.fontSize), 0)
  if (maxFontSize <= 0) {
    return undefined
  }
  const titleLines: string[] = []
  for (const item of page1Items) {
    if (item.fontSize === maxFontSize) {
      titleLines.push(item.text.trim())
    } else if (titleLines.length > 0) {
      break
    }
  }
  return titleLines.length > 0 ? { text: titleLines.join(' '), fontSize: maxFontSize } : undefined
}

export async function extractPdfPages(
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
    try {
      const bounds = page.getBounds() // [x0, y0, x1, y1]
      const pageHeight = bounds[3] - bounds[1]
      const json = readPageStext(page, stextOptions)
      pageDataList.push({ pageNum: i + 1, items: collectLineItems(json, pageHeight), pageHeight })
      stextJsonList.push(json)
    } finally {
      page.destroy()
    }
  }

  // Apply sentence-level header/footer filtering while retaining each survivor's layout data.
  const filteredPages = await filterPageBoundaryLayouts(pageDataList, embedder)

  const page1FontHint = largestFontTitleHint(pageDataList[0]?.items ?? [])

  const pages: ExtractedPage[] = pageDataList.map((p, idx) => ({
    pageNum: p.pageNum,
    text: filteredPages[idx]?.text ?? '',
    textFragments: filteredPages[idx]?.textFragments ?? [],
    stextJson: stextJsonList[idx] ?? { blocks: [] },
  }))

  return { pages, metadataTitle, page1FontHint }
}
