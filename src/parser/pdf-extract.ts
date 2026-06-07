// Shared per-page PDF extraction for the parser module.
//
// Lifts the per-page `toStructuredText` + header/footer-filtering loop out of
// `DocumentParser` so both `parsePdf` and `parsePdfPages` consume one helper.
// The two callers differ ONLY in the `stextOptions` they pass:
//   - `parsePdf` passes `'preserve-whitespace'`;
//   - `parsePdfPages` passes `'preserve-whitespace,preserve-images'` so mupdf
//     emits `block.type === 'image'` entries for the downstream
//     visual-candidate detector.

import type { Document as MupdfDocument } from 'mupdf'
import { type EmbedderInterface, filterPageBoundarySentences, type PageData } from './pdf-filter.js'

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
 * `'preserve-whitespace'`;
 * `parsePdfPages` passes `'preserve-whitespace,preserve-images'` so mupdf
 * emits `block.type === 'image'` entries for the downstream visual-candidate
 * detector.
 *
 * Lifecycle: this helper does NOT call `doc.destroy()` — disposal stays
 * with the caller.
 */
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
