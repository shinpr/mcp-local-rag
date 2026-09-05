import type { Document as MupdfDocument } from 'mupdf'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Captioner, DetectedVisualRegion } from '../types.js'

const mocks = vi.hoisted(() => ({
  renderPage: vi.fn(),
  renderRendition: vi.fn(),
}))

let processVisualRegions: typeof import('../index.js').processVisualRegions

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../renderer.js', () => ({
    renderPdfPage: mocks.renderPage,
    renderPdfRendition: mocks.renderRendition,
  }))
  vi.doMock('../captioner.js', () => ({ createCaptioner: vi.fn() }))
  ;({ processVisualRegions } = await import('../index.js'))
})

afterAll(() => {
  vi.doUnmock('../renderer.js')
  vi.doUnmock('../captioner.js')
  vi.resetModules()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.renderPage.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  mocks.renderRendition.mockResolvedValue({
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    mimeType: 'image/png',
  })
})

const regions: DetectedVisualRegion[] = [
  { pageNum: 1, detectionIndex: 0, bbox: [10, 20, 110, 120], evidence: 'vector' },
  { pageNum: 1, detectionIndex: 1, bbox: [200, 220, 400, 420], evidence: 'raster' },
]
const doc = {} as MupdfDocument

describe('processVisualRegions', () => {
  it('isolates caption failures between regions', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.renderPage.mockRejectedValueOnce(new Error('render failed'))
    const captioner: Captioner = {
      caption: vi.fn().mockResolvedValue('surviving caption'),
      dispose: vi.fn().mockResolvedValue(undefined),
    }

    const result = await processVisualRegions(regions, doc, { captioner })

    expect(result.map(({ caption }) => caption)).toEqual([null, 'surviving caption'])
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('page 1, visual 0'))
    warning.mockRestore()
  })

  it('keeps other renditions when one region fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.renderRendition.mockRejectedValueOnce(new Error('render failed'))

    const result = await processVisualRegions(regions, doc, { includeImages: true })

    expect(result[0]).not.toHaveProperty('rendition')
    expect(result[1]?.rendition).toEqual({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
    })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('page 1, visual 0'))
    warning.mockRestore()
  })
})
