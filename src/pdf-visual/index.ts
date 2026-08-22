// `pdf-visual` region orchestration and public surface. Region processing
// isolates caption and rendition failures so one crop cannot discard another.

import type { Document as MupdfDocument } from 'mupdf'

import { renderPdfPage, renderPdfRendition } from './renderer.js'
import type { Captioner, DetectedVisualRegion, ProcessedVisualRegion, VisualBBox } from './types.js'

// Public surface re-exports. The dispatch sites in `src/cli/ingest.ts` and
// `src/server/index.ts` reach the visual-mode
// implementation exclusively through `await import('../pdf-visual/index.js')`
// so default-mode ingest does not load visual dependencies. Keeping every
// public symbol re-exported here means those sites never need to know the
// internal module layout.
// Re-export ordering below is alphabetical by source module to match Biome's
// `organizeImports` rule (`./captioner` → `./detector` → `./renderer` → `./types`).
export { createCaptioner } from './captioner.js'
export { detectVisualCandidates, detectVisualRegions } from './detector.js'
export {
  createVisualAttachment,
  renderPdfPage,
  renderPdfRendition,
  validateVisualAttachment,
} from './renderer.js'
export type {
  DetectedVisualRegion,
  ImageRendition,
  ProcessedVisualRegion,
  VisualAttachment,
} from './types.js'
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

/** Compatibility shape retained until the ordered ingest builder consumes regions directly. */
interface OrchestratorCandidate {
  pageNum: number
  isCandidate?: boolean
  cropRect?: VisualBBox
  detectionIndex?: number
  bbox?: VisualBBox
  normalizedBbox?: VisualBBox
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
  detectionIndex?: number
  bbox?: VisualBBox
  normalizedBbox?: VisualBBox
}

export interface ProcessVisualRegionsOptions {
  captioner?: Captioner
  includeImages?: boolean
}

export async function processVisualRegions(
  regions: DetectedVisualRegion[],
  doc: MupdfDocument,
  options: ProcessVisualRegionsOptions
): Promise<ProcessedVisualRegion[]> {
  const processed: ProcessedVisualRegion[] = []
  for (const region of regions) {
    let caption: string | null = null
    let rendition: ProcessedVisualRegion['rendition']

    if (options.captioner) {
      try {
        const pngBytes = await renderPdfPage(doc, region.pageNum, region.bbox)
        caption = await options.captioner.caption(pngBytes, region.pageNum)
        if (caption === null) {
          console.warn(
            `VLM caption empty for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without caption`
          )
        }
      } catch {
        console.warn(
          `VLM caption failed for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without caption`
        )
      }
    }

    if (options.includeImages) {
      try {
        rendition = await renderPdfRendition(doc, region.pageNum, region.bbox, region.evidence)
      } catch {
        console.warn(
          `PDF rendition failed for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without image`
        )
      }
    }

    processed.push({ ...region, caption, ...(rendition ? { rendition } : {}) })
  }
  return processed
}

/**
 * Generate VLM captions for each visual region. Failures are isolated to the
 * current region, including when several regions share a page.
 *
 * @param pages - Per-page records from `parsePdfPages`. Passed through
 *                unchanged (no text mutation).
 * @param candidates - Region records or temporary legacy page candidates.
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
  const captions: VisualCaption[] = []

  for (const candidate of candidates) {
    if (candidate.isCandidate === false) continue
    const isRegion =
      Number.isInteger(candidate.detectionIndex) &&
      candidate.bbox !== undefined &&
      candidate.normalizedBbox !== undefined
    const cropRect = isRegion ? candidate.bbox : candidate.cropRect

    try {
      const pngBytes = await renderPdfPage(doc, candidate.pageNum, cropRect)
      const caption = await captioner.caption(pngBytes, candidate.pageNum)

      if (caption === null) {
        const visual = isRegion ? `, visual ${candidate.detectionIndex}` : ''
        console.warn(
          `VLM caption empty for page ${candidate.pageNum}${visual}; proceeding text-only`
        )
        continue
      }

      captions.push({
        pageNum: candidate.pageNum,
        text: caption,
        ...(isRegion
          ? {
              detectionIndex: candidate.detectionIndex,
              bbox: candidate.bbox,
              normalizedBbox: candidate.normalizedBbox,
            }
          : {}),
      })
    } catch {
      const visual = isRegion ? `, visual ${candidate.detectionIndex}` : ''
      console.warn(
        `VLM caption failed for page ${candidate.pageNum}${visual}; proceeding text-only`
      )
    }
  }

  return { pages, captions }
}
