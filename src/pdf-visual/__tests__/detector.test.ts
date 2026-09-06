import type { Device, Matrix, Document as MupdfDocument, Page as MupdfPage, Rect } from 'mupdf'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asDouble, expectDefined, privateMembers } from '../../__tests__/test-doubles.js'

type DeviceCallbacks = {
  strokePath?: (path: { getBounds: () => number[] }, stroke: unknown, ctm: Matrix) => void
}

const mocks = vi.hoisted(() => {
  /** Stand-in for mupdf's callback device: it only records its callbacks. */
  class CallbackDevice {
    readonly callbacks: DeviceCallbacks
    readonly close = vi.fn()

    constructor(callbacks: DeviceCallbacks) {
      this.callbacks = callbacks
    }
  }
  return { Device: CallbackDevice }
})

let detectVisualRegions: typeof import('../detector.js').detectVisualRegions

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('mupdf', () => ({
    Device: mocks.Device,
    Matrix: { identity: [1, 0, 0, 1, 0, 0] },
  }))
  ;({ detectVisualRegions } = await import('../detector.js'))
})

afterAll(() => {
  vi.doUnmock('mupdf')
  vi.resetModules()
})

function image(x: number, y: number, width: number, height: number) {
  return { type: 'image', bbox: { x, y, w: width, h: height } }
}

function fakeDoc(strokeRects: number[][] = []) {
  const pageBounds: Rect = [0, 0, 1000, 1000]
  const page = {
    getBounds: vi.fn(() => pageBounds),
    run: vi.fn((device: Device) => {
      // A JS device created from callbacks exposes them at runtime; mupdf's
      // `Device` type does not describe that surface.
      const { callbacks } = privateMembers<{ callbacks: DeviceCallbacks }>(device)
      for (const rect of strokeRects) {
        callbacks.strokePath?.({ getBounds: () => rect }, {}, [1, 0, 0, 1, 0, 0])
      }
    }),
    destroy: vi.fn(),
  }
  return {
    doc: asDouble<MupdfDocument>({ loadPage: vi.fn(() => asDouble<MupdfPage>(page)) }),
    page,
  }
}

describe('detectVisualRegions', () => {
  it('returns separated raster crops and skips vector replay once raster qualifies', () => {
    const { doc, page } = fakeDoc([[100, 100, 900, 900]])
    const regions = detectVisualRegions(
      [
        {
          pageNum: 1,
          stextJson: {
            blocks: [image(100, 100, 320, 320), image(600, 600, 300, 300)],
          },
        },
      ],
      doc
    )

    expect(page.run).not.toHaveBeenCalled()
    expect(regions).toHaveLength(2)
    expect(regions.map((region) => region.evidence)).toEqual(['raster', 'raster'])
    expect(expectDefined(regions[0]).bbox[2]).toBeLessThan(expectDefined(regions[1]).bbox[0])
    expect(page.destroy).toHaveBeenCalledOnce()
  })

  it('uses the existing stroke bounds fallback when raster evidence is insufficient', () => {
    const connectedStrokes = [
      [100, 100, 300, 130],
      [100, 125, 300, 155],
      [100, 150, 300, 180],
      [100, 175, 300, 205],
      [100, 200, 300, 230],
    ]
    const { doc, page } = fakeDoc(connectedStrokes)
    const regions = detectVisualRegions(
      [{ pageNum: 1, stextJson: { blocks: [image(10, 10, 20, 20)] } }],
      doc
    )

    expect(page.run).toHaveBeenCalledOnce()
    expect(regions).toHaveLength(1)
    expect(regions[0]?.evidence).toBe('vector')
  })

  it('keeps separated vector groups when the page has enough stroke evidence', () => {
    const strokes = [
      [100, 100, 300, 130],
      [100, 125, 300, 155],
      [100, 150, 300, 180],
      [650, 650, 850, 680],
      [650, 675, 850, 705],
      [650, 700, 850, 730],
    ]
    const { doc } = fakeDoc(strokes)

    const regions = detectVisualRegions([{ pageNum: 1, stextJson: { blocks: [] } }], doc)

    expect(regions).toHaveLength(2)
    expect(regions.every((region) => region.evidence === 'vector')).toBe(true)
  })

  it('filters corner logos without suppressing a qualifying central image', () => {
    const { doc } = fakeDoc()
    const regions = detectVisualRegions(
      [
        {
          pageNum: 1,
          stextJson: {
            blocks: [image(5, 5, 100, 100), image(250, 250, 400, 400)],
          },
        },
      ],
      doc
    )

    expect(regions).toHaveLength(1)
    expect(regions[0]?.bbox[0]).toBeGreaterThan(100)
  })
})
