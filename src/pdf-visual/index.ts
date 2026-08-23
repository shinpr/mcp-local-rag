// `pdf-visual` region orchestration and public surface. Region processing
// isolates caption and rendition failures so one crop cannot discard another.

import type { Document as MupdfDocument } from 'mupdf'

import { renderPdfPage, renderPdfRendition } from './renderer.js'
import type { Captioner, DetectedVisualRegion, ProcessedVisualRegion } from './types.js'

// Public surface re-exports. The dispatch sites in `src/cli/ingest.ts` and
// `src/server/index.ts` reach the visual-mode
// implementation exclusively through `await import('../pdf-visual/index.js')`
// so default-mode ingest does not load visual dependencies. Keeping every
// public symbol re-exported here means those sites never need to know the
// internal module layout.
// Re-export ordering below is alphabetical by source module to match Biome's
// `organizeImports` rule (`./captioner` → `./detector` → `./renderer` → `./types`).
export { createCaptioner } from './captioner.js'
export { detectVisualRegions } from './detector.js'
export { renderPdfPage, renderPdfRendition } from './renderer.js'
export type {
  DetectedVisualRegion,
  ImageRendition,
  ProcessedVisualRegion,
} from './types.js'
export { VlmError } from './types.js'

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
