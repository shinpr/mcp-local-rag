import { describe, expect, it } from 'vitest'

import type { ProcessedVisualRegion } from '../../pdf-visual/types.js'
import { buildOrderedVisualDocument, type OrderedVisualPage } from '../visual.js'

const page: OrderedVisualPage = {
  pageNum: 1,
  text: 'Before text.\nAfter text.',
  textFragments: [
    {
      pageNum: 1,
      blockOrdinal: 0,
      lineOrdinal: 0,
      fragmentOrdinal: 0,
      bbox: [0, 0, 100, 10],
      text: 'Before text.',
      pageTextStart: 0,
      pageTextEnd: 12,
    },
    {
      pageNum: 1,
      blockOrdinal: 1,
      lineOrdinal: 0,
      fragmentOrdinal: 0,
      bbox: [0, 30, 100, 40],
      text: 'After text.',
      pageTextStart: 13,
      pageTextEnd: 24,
    },
  ],
}

function region(caption: string | null, detectionIndex = 0): ProcessedVisualRegion {
  return {
    pageNum: 1,
    detectionIndex,
    bbox: [0, 15, 100, 25],
    evidence: 'vector',
    caption,
  }
}

describe('buildOrderedVisualDocument', () => {
  it('preserves ordinary PDF text when an image has no VLM caption', () => {
    const result = buildOrderedVisualDocument([page], [region(null)])

    expect(result.text).toBe(page.text)
    expect(result.atomicRanges).toEqual([])
    expect(result.regions[0]).toMatchObject({ visualIndex: 0, anchorOffset: 12 })
  })

  it('places a VLM caption between the surrounding PDF text fragments', () => {
    const result = buildOrderedVisualDocument([page], [region('Architecture diagram.')])
    const caption = '[Visual content on page 1, visual 0: Architecture diagram.]'

    expect(result.text).toBe(`Before text.\n\n${caption}\n\nAfter text.`)
    expect(result.atomicRanges.map((range) => result.text.slice(range.start, range.end))).toEqual([
      caption,
    ])
    expect(result.regions[0]?.anchorOffset).toBe(result.text.indexOf(caption))
  })

  it('preserves detection order when only a later visual at the same position has a caption', () => {
    const result = buildOrderedVisualDocument(
      [page],
      [region(null, 0), region('Architecture diagram.', 1)]
    )

    expect(result.regions.map(({ visualIndex }) => visualIndex)).toEqual([0, 1])
    expect(result.regions[0]?.anchorOffset).toBeLessThanOrEqual(
      result.regions[1]?.anchorOffset as number
    )
  })
})
