// Visual candidate detector for the visual ingest path.
//
// Pure function over the per-page records returned by `parsePdfPages`. For
// each page, decides whether the page is a "visual candidate" — i.e. whether
// the downstream renderer + captioner should run on it. Contract spelled out
// in docs/design/vlm-pdf-enrichment-design.md §Component → pdf-visual/detector.ts
// and §Visual Candidate Heuristic — Concrete Rule.
//
// Rule: a page is a candidate iff its `stextJson.blocks` array contains any
// block where `type === 'image'`. No bbox math, no text-density fallback —
// the density-fallback follow-up is deferred (DD §Component → detector.ts,
// "Why no text-density fallback in the initial implementation").
//
// Phase 1 probe observed block.type values: "text","image"
// (verbatim from tmp/probe/probe-results/probe-stext-blocks.log line 17,
// "observed block.type values: [\"text\",\"image\"]"). Image blocks are
// emitted by mupdf ONLY when the stext option string includes
// `preserve-images`; `parsePdfPages` already passes
// `'preserve-whitespace,preserve-images'` so this detector sees them.
//
// No external library imports — detector is pure and dispatch-agnostic.

/**
 * Input page record consumed by the detector. `stextJson` is typed `unknown`
 * because mupdf's `StructuredText.asJSON()` shape is not statically declared
 * by `mupdf.d.ts` (DD §Risks → "mupdf JSON block.type taxonomy"). The
 * implementation narrows it locally.
 */
interface DetectorPage {
  pageNum: number
  stextJson: unknown
}

/**
 * Output record. Separate from the input page record (not joined back) so
 * the detector stays dispatch-agnostic; the orchestrator (T3.4) joins via
 * `pageNum`.
 */
interface DetectorResult {
  pageNum: number
  isCandidate: boolean
}

/**
 * Returns true when `stextJson` looks like `{ blocks: Array<{ type: ... }> }`
 * and at least one block has `type === 'image'`. Returns false for any other
 * shape — the binary rule errs on the side of under-detection (DD §Component
 * → detector.ts, "Rationale").
 */
function hasImageBlock(stextJson: unknown): boolean {
  if (typeof stextJson !== 'object' || stextJson === null) {
    return false
  }
  const blocks = (stextJson as { blocks?: unknown }).blocks
  if (!Array.isArray(blocks)) {
    return false
  }
  return blocks.some(
    (b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'image'
  )
}

/**
 * Decide which pages are visual candidates.
 *
 * @param pages - Per-page records from `parsePdfPages`, each carrying the
 *                raw mupdf StructuredText JSON.
 * @returns Per-page `{ pageNum, isCandidate }` records in the same order as
 *          the input.
 */
export function detectVisualCandidates(pages: DetectorPage[]): DetectorResult[] {
  return pages.map((p) => ({
    pageNum: p.pageNum,
    isCandidate: hasImageBlock(p.stextJson),
  }))
}
