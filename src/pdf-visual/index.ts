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
    const caption = options.captioner ? await captionRegion(options.captioner, doc, region) : null
    const rendition = options.includeImages ? await renderRegion(doc, region) : undefined
    processed.push({ ...region, caption, ...(rendition ? { rendition } : {}) })
  }
  return processed
}

/**
 * Caption one region. A VLM failure or an empty caption is a warning, not an
 * error: the region still contributes its position and any rendition.
 */
async function captionRegion(
  captioner: NonNullable<ProcessVisualRegionsOptions['captioner']>,
  doc: MupdfDocument,
  region: DetectedVisualRegion
): Promise<string | null> {
  try {
    const pngBytes = await renderPdfPage(doc, region.pageNum, region.bbox)
    const caption = await captioner.caption(pngBytes, region.pageNum)
    if (caption === null) {
      console.warn(
        `VLM caption empty for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without caption`
      )
    }
    return caption
  } catch {
    console.warn(
      `VLM caption failed for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without caption`
    )
    return null
  }
}

/** Render one region's image, warning and omitting it on failure. */
async function renderRegion(
  doc: MupdfDocument,
  region: DetectedVisualRegion
): Promise<ProcessedVisualRegion['rendition']> {
  try {
    return await renderPdfRendition(doc, region.pageNum, region.bbox, region.evidence)
  } catch {
    console.warn(
      `PDF rendition failed for page ${region.pageNum}, visual ${region.detectionIndex}; proceeding without image`
    )
    return undefined
  }
}
