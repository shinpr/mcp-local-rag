// Visual candidate detector tests.
//
// `bbox` values follow the `{ x, y, w, h }` shape that mupdf's
// `StructuredText.asJSON()` actually emits (see
// `tmp/probe/probe-results/probe-stext-blocks.log`). The vector branch is
// not exercised here — these tests focus on the image-area decision.

import type { Document as MupdfDocument } from 'mupdf'
import { describe, expect, it, vi } from 'vitest'
import { detectVisualCandidates } from '../detector.js'

const PAGE_BOUNDS = [0, 0, 1000, 1000] as const

function bbox(x0: number, y0: number, x1: number, y1: number) {
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function fakeDoc(): MupdfDocument {
  return {
    loadPage: vi.fn().mockReturnValue({
      getBounds: vi.fn().mockReturnValue([...PAGE_BOUNDS]),
      run: vi.fn(),
      destroy: vi.fn(),
    }),
  } as unknown as MupdfDocument
}

describe('detectVisualCandidates', () => {
  it('returns true when the largest effective image block is at least 10% of the page', () => {
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'image', bbox: bbox(0, 0, 320, 320) }] },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([{ pageNum: 1, isCandidate: true, cropRect: [0, 0, 345.6, 345.6] }])
  })

  it('returns true when total effective image area is at least 15% of the page', () => {
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: {
            blocks: [
              { type: 'image', bbox: bbox(0, 0, 280, 280) },
              { type: 'image', bbox: bbox(300, 0, 580, 280) },
            ],
          },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([{ pageNum: 1, isCandidate: true, cropRect: [0, 0, 626.4, 302.4] }])
  })

  it('returns false for tiny image blocks below the meaningful-image thresholds', () => {
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'image', bbox: bbox(0, 0, 50, 50) }] },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([{ pageNum: 1, isCandidate: false }])
  })

  it('ignores small corner logos when deciding candidates and crop bounds', () => {
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: {
            blocks: [
              { type: 'image', bbox: bbox(880, 20, 980, 120) },
              { type: 'image', bbox: bbox(200, 200, 560, 560) },
            ],
          },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([
      { pageNum: 1, isCandidate: true, cropRect: [171.2, 171.2, 588.8, 588.8] },
    ])
  })

  it('does not mark a page as candidate for only a small corner logo', () => {
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'image', bbox: bbox(880, 20, 980, 120) }] },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([{ pageNum: 1, isCandidate: false }])
  })

  it('preserves order and marks only pages that meet the visual thresholds', () => {
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'text', bbox: bbox(0, 0, 100, 100), lines: [] }] },
        },
        {
          pageNum: 2,
          stextJson: {
            blocks: [
              { type: 'text', bbox: bbox(0, 0, 100, 100), lines: [] },
              { type: 'image', bbox: bbox(0, 0, 320, 320) },
            ],
          },
        },
        {
          pageNum: 3,
          stextJson: { blocks: [{ type: 'image', bbox: bbox(0, 0, 50, 50) }] },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true, cropRect: [0, 0, 345.6, 345.6] },
      { pageNum: 3, isCandidate: false },
    ])
  })

  it('omits cropRect when the padded union covers more than 85% of the page', () => {
    // A nearly-full-page image inflates after padding past the 85% guard, so
    // the renderer falls back to a full-page render (cropRect absent).
    const result = detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'image', bbox: bbox(0, 0, 900, 900) }] },
        },
      ],
      fakeDoc()
    )

    expect(result).toEqual([{ pageNum: 1, isCandidate: true }])
  })

  it('runs the vector scan when the image signal is empty', () => {
    // `page.run` is what drives the (expensive) vector stroke scan. Asserting
    // that it is invoked guards the existence of the vector code path;
    // threshold-level behaviour for strokes is covered downstream because the
    // real mupdf.Device runtime type checks reject unit-test fakes for `Path`.
    const page = {
      getBounds: vi.fn().mockReturnValue([...PAGE_BOUNDS]),
      run: vi.fn(),
      destroy: vi.fn(),
    }
    const doc = { loadPage: vi.fn().mockReturnValue(page) } as unknown as MupdfDocument

    detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'text', bbox: bbox(0, 0, 50, 50), lines: [] }] },
        },
      ],
      doc
    )

    expect(page.run).toHaveBeenCalledTimes(1)
  })

  it('skips the vector branch when the image signal already fires (cost guard)', () => {
    const page = {
      getBounds: vi.fn().mockReturnValue([...PAGE_BOUNDS]),
      run: vi.fn(),
      destroy: vi.fn(),
    }
    const doc = { loadPage: vi.fn().mockReturnValue(page) } as unknown as MupdfDocument

    detectVisualCandidates(
      [
        {
          pageNum: 1,
          stextJson: { blocks: [{ type: 'image', bbox: bbox(0, 0, 320, 320) }] },
        },
      ],
      doc
    )

    expect(page.run).not.toHaveBeenCalled()
  })
})
