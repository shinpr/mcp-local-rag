// `pdf-visual` package — orchestrator + intermediate barrel.
//
// `enrichPagesWithCaptions` glues `renderPdfPage` (T3.1) and the `Captioner`
// (T3.3) together for every page flagged as a visual candidate by
// `detectVisualCandidates` (T3.2). Per-page failure semantics — the heart of
// FR-3 / AC-004 — live HERE and ONLY here: the renderer and captioner each
// throw `VlmError` on their own failures; the orchestrator is the single
// site that catches those errors and continues with text-only output for the
// offending page.
//
// Contract (DD §Component → enrichPagesWithCaptions orchestrator, lines
// 712-742):
//   1. Build a Set of candidate page numbers from
//      `candidates.filter(c => c.isCandidate).map(c => c.pageNum)`.
//   2. Iterate `pages` in input order. For each page whose `pageNum` is in
//      the candidate Set:
//        - `pngBytes = await renderPdfPage(doc, page.pageNum)`
//        - `caption  = await captioner.caption(pngBytes, page.pageNum)`
//        - `caption === null` → `console.warn` naming the page; leave
//          `page.text` unchanged.
//        - non-null → mutate `page.text` to
//          `page.text + (page.text ? '\n\n' : '') + '[Visual content on page N: caption]'`.
//        - thrown error → `console.error` naming the page and including
//          `err.message`; leave `page.text` unchanged.
//   3. Return the (possibly mutated) `pages` array.
//
// DPI is NOT a parameter of this function. The renderer owns DPI as a
// module-private constant. If a future caller needs to override DPI it can
// be added then.
//
// Layer constraint (per task file): this module imports ONLY from
// `./renderer`, `./captioner`, `./detector`, `./types`. No external packages.
// (The `mupdf` type import is type-only and erased at compile.)

import type { Document as MupdfDocument } from 'mupdf'

import { renderPdfPage } from './renderer.js'
import type { Captioner } from './types.js'

// Public surface re-exports (T3.5). The Phase 4 dispatch sites in
// `src/cli/ingest.ts` and `src/server/index.ts` reach the visual-mode
// implementation exclusively through `await import('../pdf-visual/index.js')`
// (NFR-1 dynamic-import discipline). Keeping every public symbol re-exported
// here means those sites never need to know the internal module layout.
// Re-export ordering below is alphabetical by source module to match Biome's
// `organizeImports` rule (`./captioner` → `./detector` → `./renderer` → `./types`).
export { createCaptioner } from './captioner.js'
export { detectVisualCandidates } from './detector.js'
export { renderPdfPage } from './renderer.js'
export { VlmError } from './types.js'

/**
 * Per-page record consumed and (selectively) mutated by the orchestrator.
 * `stextJson` is passed through verbatim — the orchestrator does not inspect
 * it. The structural type is duplicated here (not imported from `parser/`)
 * to preserve the layer boundary documented in the task file.
 */
interface OrchestratorPage {
  pageNum: number
  text: string
  stextJson: unknown
}

/**
 * Per-page detector record. Mirrors the shape returned by
 * `detectVisualCandidates` in `./detector.ts`.
 */
interface OrchestratorCandidate {
  pageNum: number
  isCandidate: boolean
}

/**
 * Enrich the per-page text array with VLM-generated captions for each visual
 * candidate page. Per-page failures are tolerated: a thrown error or a `null`
 * caption leaves the offending page's text unchanged and logs an entry
 * naming the page. Other candidate pages are unaffected.
 *
 * @param pages - Per-page records from `parsePdfPages`. The same array is
 *                returned with `text` selectively mutated.
 * @param candidates - Per-page `{ pageNum, isCandidate }` records from
 *                     `detectVisualCandidates`. Pages whose `isCandidate` is
 *                     false are passed through unchanged.
 * @param doc - The open mupdf `Document`. The orchestrator does not own its
 *              lifecycle — the caller is responsible for `doc.destroy()`.
 * @param captioner - The VLM wrapper from `createCaptioner`.
 * @returns The same `pages` array reference, with candidate pages' `text`
 *          fields possibly appended with `[Visual content on page N: …]`.
 */
export async function enrichPagesWithCaptions(
  pages: OrchestratorPage[],
  candidates: OrchestratorCandidate[],
  doc: MupdfDocument,
  captioner: Captioner
): Promise<OrchestratorPage[]> {
  const candidateSet = new Set(candidates.filter((c) => c.isCandidate).map((c) => c.pageNum))

  for (const page of pages) {
    if (!candidateSet.has(page.pageNum)) continue

    try {
      const pngBytes = await renderPdfPage(doc, page.pageNum)
      const caption = await captioner.caption(pngBytes, page.pageNum)

      if (caption === null) {
        // Empty / sanitized-empty caption is a documented non-failure (see
        // DD §Component → captioner contract step 7 + §Component →
        // orchestrator algorithm). Warn-log and skip the append.
        console.warn(`VLM caption empty for page ${page.pageNum}; proceeding text-only`)
        continue
      }

      // Documented join string: a single blank line between existing text
      // and the bracketed caption, but no leading separator when the page
      // had no prior text (DD line 736).
      const separator = page.text ? '\n\n' : ''
      page.text = `${page.text}${separator}[Visual content on page ${page.pageNum}: ${caption}]`
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`VLM caption failed for page ${page.pageNum}: ${message}`)
      // page.text intentionally left unchanged — AC-004.
    }
  }

  return pages
}
