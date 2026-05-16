// T3.2 — `detectVisualCandidates` unit test.
//
// Asserts the public contract of `detectVisualCandidates` documented in
// docs/design/vlm-pdf-enrichment-design.md §Component `pdf-visual/detector.ts`:
//
//   detectVisualCandidates(
//     pages: Array<{ pageNum: number; stextJson: unknown }>
//   ): Array<{ pageNum: number; isCandidate: boolean }>
//
// Binary rule: a page is a candidate iff `stextJson.blocks` contains any
// block where `type === 'image'`. The Phase 1 probe
// (tmp/probe/probe-results/probe-stext-blocks.log) recorded exactly two
// observed `block.type` values: `"text"` and `"image"`. The synthetic
// fixtures below use only these two values; no other block-type strings are
// asserted on because the probe did not observe them.
//
// The detector is a pure function with no external I/O — no vi.mock,
// no async, no setup/teardown needed.
import { describe, expect, it } from 'vitest'
import { detectVisualCandidates } from '../detector'

describe('detectVisualCandidates', () => {
  it('returns isCandidate=true when a page has any block with type="image" (image-block branch)', () => {
    // Arrange: single page whose stextJson.blocks contains one image block.
    const pages = [
      {
        pageNum: 1,
        stextJson: { blocks: [{ type: 'image', bbox: { x: 0, y: 0, w: 10, h: 10 } }] },
      },
    ]

    // Act
    const result = detectVisualCandidates(pages)

    // Assert: literal expected value — one entry, candidate true.
    expect(result).toEqual([{ pageNum: 1, isCandidate: true }])
  })

  it('returns isCandidate=false when a page has only text blocks (text-only branch)', () => {
    // Arrange: single page whose stextJson.blocks has only a text block.
    const pages = [
      {
        pageNum: 1,
        stextJson: {
          blocks: [{ type: 'text', bbox: { x: 0, y: 0, w: 10, h: 10 }, lines: [] }],
        },
      },
    ]

    // Act
    const result = detectVisualCandidates(pages)

    // Assert: literal expected value — one entry, candidate false.
    expect(result).toEqual([{ pageNum: 1, isCandidate: false }])
  })

  it('marks exactly one page as candidate when only one of three pages has an image block (mixed input)', () => {
    // Arrange: three pages — pages 1 and 3 text-only, page 2 has an image
    // block alongside text. Order in the input must be preserved in the
    // output.
    const pages = [
      {
        pageNum: 1,
        stextJson: {
          blocks: [{ type: 'text', bbox: { x: 0, y: 0, w: 10, h: 10 }, lines: [] }],
        },
      },
      {
        pageNum: 2,
        stextJson: {
          blocks: [
            { type: 'text', bbox: { x: 0, y: 0, w: 10, h: 10 }, lines: [] },
            { type: 'image', bbox: { x: 20, y: 20, w: 30, h: 30 } },
          ],
        },
      },
      {
        pageNum: 3,
        stextJson: {
          blocks: [{ type: 'text', bbox: { x: 0, y: 0, w: 10, h: 10 }, lines: [] }],
        },
      },
    ]

    // Act
    const result = detectVisualCandidates(pages)

    // Assert: literal expected output — exactly page 2 is a candidate.
    expect(result).toEqual([
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true },
      { pageNum: 3, isCandidate: false },
    ])
  })
})
