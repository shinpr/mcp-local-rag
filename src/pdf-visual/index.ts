// `pdf-visual` package — orchestrator + intermediate barrel.
//
// `enrichPagesWithCaptions` glues `renderPdfPage` and the `Captioner`
// together for every page flagged as a visual candidate by
// `detectVisualCandidates`. Per-page failure handling lives here: the
// renderer and captioner throw `VlmError` on their own failures, and the
// orchestrator catches those errors so only the offending page falls back to
// text-only output.
//
// Captions are NOT mutated into `page.text`. Returning them as a separate
// `captions` array lets the ingest layer emit them as dedicated chunks
// (`src/ingest/visual.ts`), preserving the `Summary` + `Keywords` structure
// against the semantic chunker's sentence-boundary splits.
//
// Contract:
//   1. Build a Set of candidate page numbers from
//      `candidates.filter(c => c.isCandidate).map(c => c.pageNum)`.
//   2. Iterate `pages` in input order. For each page whose `pageNum` is in
//      the candidate Set:
//        - `pngBytes = await renderPdfPage(doc, page.pageNum, candidate.cropRect)`
//        - `caption  = await captioner.caption(pngBytes, page.pageNum)`
//        - `caption === null` → `console.warn` naming the page; no caption record.
//        - non-null → push `{ pageNum, text: caption }` into `captions`.
//        - thrown error → `console.warn` naming the page and including
//          `err.message`; no caption record. Per FR-3, a per-page captioner
//          failure is warning-level (the file ingest as a whole succeeds).
//   3. Return `{ pages, captions }`. The `pages` array is passed through
//      unchanged (no text mutation).
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

// Public surface re-exports. The dispatch sites in `src/cli/ingest.ts` and
// `src/server/index.ts` reach the visual-mode
// implementation exclusively through `await import('../pdf-visual/index.js')`
// so default-mode ingest does not load visual dependencies. Keeping every
// public symbol re-exported here means those sites never need to know the
// internal module layout.
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
  cropRect?: [number, number, number, number]
}

/**
 * Per-page caption record emitted by `enrichPagesWithCaptions`.
 *
 * `text` is the raw caption string returned by the captioner (without the
 * `[Visual content on page N: …]` wrapper — wrapping happens at the ingest
 * layer where the dedicated caption chunks are built).
 */
export interface VisualCaption {
  pageNum: number
  text: string
}

/**
 * Generate VLM captions for each visual candidate page. Per-page failures are
 * tolerated: a thrown error or a `null` caption is logged and the page produces
 * no caption record. Other candidate pages are unaffected.
 *
 * @param pages - Per-page records from `parsePdfPages`. Passed through
 *                unchanged (no text mutation).
 * @param candidates - Per-page `{ pageNum, isCandidate }` records from
 *                     `detectVisualCandidates`. Pages whose `isCandidate` is
 *                     false are skipped.
 * @param doc - The open mupdf `Document`. The orchestrator does not own its
 *              lifecycle — the caller is responsible for `doc.destroy()`.
 * @param captioner - The VLM wrapper from `createCaptioner`.
 * @returns `{ pages, captions }`. `pages` is the same array reference, with
 *          text fields untouched. `captions` contains one entry per page that
 *          produced a non-empty caption.
 */
export async function enrichPagesWithCaptions(
  pages: OrchestratorPage[],
  candidates: OrchestratorCandidate[],
  doc: MupdfDocument,
  captioner: Captioner
): Promise<{ pages: OrchestratorPage[]; captions: VisualCaption[] }> {
  const candidateByPage = new Map(
    candidates.filter((c) => c.isCandidate).map((c) => [c.pageNum, c])
  )
  const captions: VisualCaption[] = []

  for (const page of pages) {
    const candidate = candidateByPage.get(page.pageNum)
    if (!candidate) continue

    try {
      const pngBytes = await renderPdfPage(doc, page.pageNum, candidate.cropRect)
      const caption = await captioner.caption(pngBytes, page.pageNum)

      if (caption === null) {
        // Empty / sanitized-empty caption is a documented non-failure (see
        // captioner contract step 7). Warn-log and emit no caption record.
        console.warn(`VLM caption empty for page ${page.pageNum}; proceeding text-only`)
        continue
      }

      captions.push({ pageNum: page.pageNum, text: caption })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Warn and continue so the file ingest succeeds while only this page
      // degrades to text-only.
      console.warn(`VLM caption failed for page ${page.pageNum}: ${message}`)
    }
  }

  return { pages, captions }
}
