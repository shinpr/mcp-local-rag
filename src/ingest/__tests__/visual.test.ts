import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SemanticChunker } from '../../chunker/index.js'
import type { EmbedderInterface } from '../../chunker/semantic-chunker.js'
import type { FilteredTextFragment } from '../../parser/pdf-filter.js'
import type {
  DetectedVisualRegion,
  ImageRendition,
  ProcessedVisualRegion,
  VisualAttachment,
} from '../../pdf-visual/types.js'

const mocks = vi.hoisted(() => ({
  createCaptioner: vi.fn(() => ({ caption: vi.fn() })),
  createVisualAttachment: vi.fn(),
  detectVisualRegions: vi.fn(),
  parsePdf: vi.fn(),
  parsePdfPages: vi.fn(),
  processVisualRegions: vi.fn(),
  renderPdfRendition: vi.fn(),
  destroy: vi.fn(),
  indexModuleLoaded: vi.fn(),
}))

const region: DetectedVisualRegion = {
  pageNum: 1,
  detectionIndex: 0,
  bbox: [10, 20, 40, 30],
  normalizedBbox: [0.1, 0.2, 0.4, 0.3],
  evidence: 'vector',
}

const rendition: ImageRendition = {
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'image/png',
  pixelWidth: 30,
  pixelHeight: 10,
}

function attachment(visualIndex: number): VisualAttachment {
  return {
    pageNum: 1,
    visualIndex,
    bbox: region.normalizedBbox,
    mimeType: 'image/png',
    pixelWidth: 30,
    pixelHeight: 10,
    data: 'AQID',
  }
}

function fragment(
  text: string,
  pageNum: number,
  lineOrdinal: number,
  bbox: [number, number, number, number]
): FilteredTextFragment {
  return {
    pageNum,
    blockOrdinal: 0,
    lineOrdinal,
    fragmentOrdinal: 0,
    bbox,
    text,
    pageTextStart: 0,
    pageTextEnd: text.length,
  }
}

const MOCKED_PATHS = [
  '../../pdf-visual/index.js',
  '../../pdf-visual/detector.js',
  '../../pdf-visual/renderer.js',
] as const

let buildOrderedVisualDocument: typeof import('../visual.js').buildOrderedVisualDocument
let assignVisualAttachments: typeof import('../visual.js').assignVisualAttachments
let prepareVisualPdfChunks: typeof import('../visual.js').prepareVisualPdfChunks

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../../pdf-visual/index.js', () => {
    mocks.indexModuleLoaded()
    return {
      createCaptioner: mocks.createCaptioner,
      createVisualAttachment: mocks.createVisualAttachment,
      detectVisualCandidates: mocks.detectVisualRegions,
      detectVisualRegions: mocks.detectVisualRegions,
      enrichPagesWithCaptions: vi.fn(async (pages: unknown[]) => ({ pages, captions: [] })),
      processVisualRegions: mocks.processVisualRegions,
    }
  })
  vi.doMock('../../pdf-visual/detector.js', () => ({
    detectVisualRegions: mocks.detectVisualRegions,
  }))
  vi.doMock('../../pdf-visual/renderer.js', () => ({
    createVisualAttachment: mocks.createVisualAttachment,
    renderPdfRendition: mocks.renderPdfRendition,
  }))
  ;({ buildOrderedVisualDocument, assignVisualAttachments, prepareVisualPdfChunks } = await import(
    '../visual.js'
  ))
})

afterAll(() => {
  for (const path of MOCKED_PATHS) vi.doUnmock(path)
  vi.resetModules()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.detectVisualRegions.mockReturnValue([region])
  mocks.renderPdfRendition.mockResolvedValue(rendition)
  mocks.createVisualAttachment.mockImplementation((_region, visualIndex) => attachment(visualIndex))
  mocks.processVisualRegions.mockImplementation(
    async (
      regions: DetectedVisualRegion[],
      _doc: unknown,
      options: { captioner?: unknown; includeImages?: boolean }
    ): Promise<ProcessedVisualRegion[]> =>
      regions.map((value) => ({
        ...value,
        caption: options.captioner ? 'Caption sentence.' : null,
        ...(options.includeImages ? { rendition } : {}),
      }))
  )
  mocks.parsePdf.mockResolvedValue({ content: 'Body sentence.', title: 'Parsed title' })
  mocks.parsePdfPages.mockResolvedValue({
    doc: { destroy: mocks.destroy },
    metadataTitle: 'Metadata title',
    pages: [
      {
        pageNum: 1,
        text: 'Body sentence.',
        textFragments: [fragment('Body sentence.', 1, 0, [0, 0, 100, 10])],
        stextJson: {},
      },
    ],
  })
})

describe('ordered visual document', () => {
  it('interleaves an atomic caption between native fragments and assigns visualIndex in stream order', () => {
    const pages = [
      {
        pageNum: 1,
        text: 'Top line.\nBottom line.\nRight line.',
        textFragments: [
          fragment('Top line.', 1, 0, [0, 0, 40, 10]),
          fragment('Bottom line.', 1, 1, [0, 40, 40, 50]),
          fragment('Right line.', 1, 2, [60, 0, 100, 10]),
        ],
      },
    ]
    const processed: ProcessedVisualRegion[] = [
      { ...region, caption: 'Caption sentence.', rendition },
      { ...region, detectionIndex: 1, bbox: [10, 22, 40, 32], caption: null, rendition },
    ]

    const ordered = buildOrderedVisualDocument(pages, processed)
    const caption = '[Visual content on page 1, visual 0: Caption sentence.]'

    expect(ordered.text).toBe(`Top line.\n\n${caption}\n\nBottom line.\n\nRight line.`)
    expect(ordered.atomicRanges).toEqual([
      {
        start: 'Top line.\n\n'.length,
        end: 'Top line.\n\n'.length + caption.length,
      },
    ])
    expect(
      ordered.regions.map(({ visualIndex, captionRange }) => ({ visualIndex, captionRange }))
    ).toEqual([
      { visualIndex: 0, captionRange: ordered.atomicRanges[0] },
      { visualIndex: 1, captionRange: undefined },
    ])
    for (const sourceFragment of ordered.fragments) {
      expect(ordered.text.slice(sourceFragment.documentStart, sourceFragment.documentEnd)).toBe(
        sourceFragment.text
      )
    }
  })

  it('maps captioned and nearest-text attachments to one ordered zero-to-many owner array', () => {
    const before = fragment('Before text.', 1, 0, [0, 0, 40, 10])
    const after = fragment('After text.', 1, 1, [0, 40, 40, 50])
    const ordered = buildOrderedVisualDocument(
      [{ pageNum: 1, text: 'Before text.\nAfter text.', textFragments: [before, after] }],
      [
        { ...region, caption: 'Caption.', rendition },
        { ...region, detectionIndex: 1, caption: null, rendition },
      ]
    )
    const chunks = [
      {
        text: ordered.text,
        index: 0,
        sourceStart: 0,
        sourceEnd: ordered.text.length,
      },
    ]

    const owners = assignVisualAttachments(ordered, chunks, [attachment(1), attachment(0)])

    expect(owners.get(0)?.map((value) => value.visualIndex)).toEqual([0, 1])
  })

  it('uses geometry, preceding text, then lower chunkIndex as deterministic tie-breakers', () => {
    const ordered = buildOrderedVisualDocument(
      [
        {
          pageNum: 1,
          text: 'Before.\nAfter.',
          textFragments: [
            fragment('Before.', 1, 0, [0, 0, 10, 10]),
            fragment('After.', 1, 1, [80, 20, 100, 30]),
          ],
        },
      ],
      [{ ...region, bbox: [45, 10, 55, 20], caption: null, rendition }]
    )
    const [beforeFragment, afterFragment] = ordered.fragments
    expect(beforeFragment).toBeDefined()
    expect(afterFragment).toBeDefined()
    const chunks = [
      {
        text: 'Before.',
        index: 4,
        sourceStart: beforeFragment?.documentStart ?? 0,
        sourceEnd: beforeFragment?.documentEnd ?? 0,
      },
      {
        text: 'After.',
        index: 2,
        sourceStart: afterFragment?.documentStart ?? 0,
        sourceEnd: afterFragment?.documentEnd ?? 0,
      },
    ]

    expect(assignVisualAttachments(ordered, chunks, [attachment(0)]).has(2)).toBe(true)

    if (beforeFragment && afterFragment) {
      beforeFragment.bbox = [0, 0, 40, 10]
      afterFragment.bbox = [60, 20, 100, 30]
    }
    expect(assignVisualAttachments(ordered, chunks, [attachment(0)]).has(4)).toBe(true)

    const sameEnvelope = chunks.map((chunk, index) => ({
      ...chunk,
      index,
      sourceStart: beforeFragment?.documentStart ?? 0,
      sourceEnd: beforeFragment?.documentEnd ?? 0,
    }))
    expect(assignVisualAttachments(ordered, sameEnvelope, [attachment(0)]).has(0)).toBe(true)
  })

  it('creates no placeholder, atomic range, or owner for an image-only PDF without captions', () => {
    const ordered = buildOrderedVisualDocument(
      [{ pageNum: 1, text: '', textFragments: [] }],
      [{ ...region, caption: null, rendition }]
    )

    expect(ordered.text).toBe('')
    expect(ordered.atomicRanges).toEqual([])
    expect(assignVisualAttachments(ordered, [], [attachment(0)])).toEqual(new Map())
  })

  it('prefers preceding text across equidistant pages', () => {
    const ordered = buildOrderedVisualDocument(
      [
        {
          pageNum: 1,
          text: 'Previous page.',
          textFragments: [fragment('Previous page.', 1, 0, [0, 0, 100, 10])],
        },
        { pageNum: 2, text: '', textFragments: [] },
        {
          pageNum: 3,
          text: 'Following page.',
          textFragments: [fragment('Following page.', 3, 0, [0, 0, 100, 10])],
        },
      ],
      [{ ...region, pageNum: 2, caption: null, rendition }]
    )
    const chunks = ordered.fragments.map((sourceFragment, index) => ({
      text: sourceFragment.text,
      index,
      sourceStart: sourceFragment.documentStart,
      sourceEnd: sourceFragment.documentEnd,
    }))

    expect(assignVisualAttachments(ordered, chunks, [attachment(0)]).has(0)).toBe(true)
  })
})

describe('prepareVisualPdfChunks option matrix', () => {
  function dependencies() {
    const chunkText = vi.fn(async (text: string) =>
      text.length === 0 ? [] : [{ text, index: 0, sourceStart: 0, sourceEnd: text.length }]
    )
    const chunker = { chunkText } as unknown as SemanticChunker
    const embedder: EmbedderInterface = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
    }
    const parser = {
      parsePdf: mocks.parsePdf,
      parsePdfPages: mocks.parsePdfPages,
    }
    return { chunkText, chunker, embedder, parser }
  }

  it.each([
    { visual: false, images: false, expectsCaption: false, expectsImage: false },
    { visual: false, images: true, expectsCaption: false, expectsImage: true },
    { visual: true, images: false, expectsCaption: true, expectsImage: false },
    { visual: true, images: true, expectsCaption: true, expectsImage: true },
  ])('keeps visual=$visual and images=$images independent', async (mode) => {
    const { chunkText, chunker, embedder, parser } = dependencies()

    const result = await prepareVisualPdfChunks('/tmp/input.pdf', parser, chunker, embedder, {
      profile: 'fast',
      cacheDir: '/tmp/cache',
      visual: mode.visual,
      images: mode.images,
    })

    expect(chunkText).toHaveBeenCalledTimes(1)
    expect(mocks.createCaptioner).toHaveBeenCalledTimes(mode.expectsCaption ? 1 : 0)
    expect([...result.visualAttachments.values()].flat()).toHaveLength(mode.expectsImage ? 1 : 0)
    expect(result.text.includes('[Visual content')).toBe(mode.expectsCaption)
    if (!mode.visual && mode.images) {
      expect(mocks.indexModuleLoaded).not.toHaveBeenCalled()
      expect(result.text).toBe('Body sentence.')
      expect(result.atomicRanges).toEqual([])
    }
  })

  it('isolates one rendition failure and keeps text chunks without generated placeholders', async () => {
    const { chunker, embedder, parser } = dependencies()
    mocks.renderPdfRendition.mockRejectedValueOnce(new Error('render failed'))

    const result = await prepareVisualPdfChunks('/tmp/input.pdf', parser, chunker, embedder, {
      profile: 'fast',
      cacheDir: '/tmp/cache',
      visual: false,
      images: true,
    })

    expect(result.chunks).toHaveLength(1)
    expect(result.text).toBe('Body sentence.')
    expect(result.visualAttachments).toEqual(new Map())
    expect(mocks.createCaptioner).not.toHaveBeenCalled()
  })

  it('preserves text ingestion when visual detection skips an over-budget page', async () => {
    const { chunker, embedder, parser } = dependencies()
    mocks.detectVisualRegions.mockReturnValueOnce([])

    const result = await prepareVisualPdfChunks('/tmp/input.pdf', parser, chunker, embedder, {
      profile: 'fast',
      cacheDir: '/tmp/cache',
      visual: false,
      images: true,
    })

    expect(result.text).toBe('Body sentence.')
    expect(result.chunks).toHaveLength(1)
    expect(result.visualAttachments).toEqual(new Map())
    expect(mocks.renderPdfRendition).not.toHaveBeenCalled()
    expect(mocks.createCaptioner).not.toHaveBeenCalled()
  })
})
