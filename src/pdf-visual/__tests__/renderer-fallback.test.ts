import type { Document as MupdfDocument } from 'mupdf'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  interface EncoderAttempt {
    mimeType: 'image/png' | 'image/jpeg'
    quality?: number
    width: number
    height: number
  }

  const state: {
    attempts: EncoderAttempt[]
    pixmaps: Array<{ destroy: ReturnType<typeof vi.fn> }>
    throwDrawDeviceConstruction: boolean
    throwDeviceClose: boolean
    encodedSize: (attempt: EncoderAttempt) => number
  } = {
    attempts: [],
    pixmaps: [],
    throwDrawDeviceConstruction: false,
    throwDeviceClose: false,
    encodedSize: () => 1024,
  }

  class Pixmap {
    readonly destroy = vi.fn()
    readonly width: number
    readonly height: number

    constructor(_colorSpace: unknown, bounds: number[]) {
      this.width = bounds[2] as number
      this.height = bounds[3] as number
      state.pixmaps.push(this)
    }

    clear() {}

    getWidth() {
      return this.width
    }

    getHeight() {
      return this.height
    }

    asPNG() {
      const attempt: EncoderAttempt = {
        mimeType: 'image/png',
        width: this.width,
        height: this.height,
      }
      state.attempts.push(attempt)
      return new Uint8Array(state.encodedSize(attempt))
    }

    asJPEG(quality: number) {
      const attempt: EncoderAttempt = {
        mimeType: 'image/jpeg',
        quality,
        width: this.width,
        height: this.height,
      }
      state.attempts.push(attempt)
      return new Uint8Array(state.encodedSize(attempt))
    }
  }

  class DrawDevice {
    constructor() {
      if (state.throwDrawDeviceConstruction) throw new Error('draw device construction failed')
    }

    close() {
      if (state.throwDeviceClose) throw new Error('device close failed')
    }
  }

  return { state, Pixmap, DrawDevice }
})

const mupdfFactory = () => ({
  ColorSpace: { DeviceRGB: {} },
  DrawDevice: mocks.DrawDevice,
  Matrix: { identity: [1, 0, 0, 1, 0, 0] },
  Pixmap: mocks.Pixmap,
})

let renderPdfPage: typeof import('../renderer.js').renderPdfPage
let renderPdfRendition: typeof import('../renderer.js').renderPdfRendition
let VlmError: typeof import('../renderer.js').VlmError

function fakeDoc() {
  const page = { run: vi.fn(), destroy: vi.fn() }
  return {
    doc: { loadPage: vi.fn(() => page) } as unknown as MupdfDocument,
    page,
  }
}

describe('renderer retry and native resource cleanup', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('mupdf', mupdfFactory)
    ;({ renderPdfPage, renderPdfRendition, VlmError } = await import('../renderer.js'))
  })

  afterAll(() => {
    vi.doUnmock('mupdf')
    vi.resetModules()
  })

  beforeEach(() => {
    mocks.state.attempts = []
    mocks.state.pixmaps = []
    mocks.state.throwDrawDeviceConstruction = false
    mocks.state.throwDeviceClose = false
    mocks.state.encodedSize = () => 1024
  })

  it('destroys the pixmap when DrawDevice construction throws', async () => {
    const { doc, page } = fakeDoc()
    mocks.state.throwDrawDeviceConstruction = true

    await expect(renderPdfPage(doc, 1, [0, 0, 400, 200])).rejects.toBeInstanceOf(VlmError)

    expect(mocks.state.pixmaps).toHaveLength(1)
    expect(mocks.state.pixmaps[0]?.destroy).toHaveBeenCalledTimes(1)
    expect(page.destroy).toHaveBeenCalledTimes(1)
  })

  it('destroys the pixmap when device.close throws', async () => {
    const { doc, page } = fakeDoc()
    mocks.state.throwDeviceClose = true

    await expect(renderPdfPage(doc, 1, [0, 0, 400, 200])).rejects.toBeInstanceOf(VlmError)

    expect(mocks.state.pixmaps).toHaveLength(1)
    expect(mocks.state.pixmaps[0]?.destroy).toHaveBeenCalledTimes(1)
    expect(page.destroy).toHaveBeenCalledTimes(1)
  })

  it('retries incompressible photographic content below the 256 KiB target', async () => {
    const { doc } = fakeDoc()
    mocks.state.encodedSize = ({ mimeType, quality }) =>
      mimeType === 'image/jpeg' && quality === 72 ? 240 * 1024 : 300 * 1024

    const rendition = await renderPdfRendition(doc, 1, [0, 0, 400, 200], 'raster')

    expect(rendition.mimeType).toBe('image/jpeg')
    expect(rendition.bytes.byteLength).toBe(240 * 1024)
    expect([rendition.pixelWidth, rendition.pixelHeight]).toEqual([1024, 512])
    expect(mocks.state.attempts.map(({ quality }) => quality)).toEqual([82, 72])
  })

  it('keeps a lossless table rendition between the target and hard limit', async () => {
    const { doc } = fakeDoc()
    mocks.state.encodedSize = ({ mimeType }) => (mimeType === 'image/png' ? 300 * 1024 : 128 * 1024)

    const rendition = await renderPdfRendition(doc, 1, [0, 0, 400, 200], 'vector')

    expect(rendition.mimeType).toBe('image/png')
    expect(rendition.bytes.byteLength).toBe(300 * 1024)
    expect([rendition.pixelWidth, rendition.pixelHeight]).toEqual([1024, 512])
    expect(mocks.state.attempts.filter(({ mimeType }) => mimeType === 'image/png').length).toBe(5)
  })

  it('flattens an oversized transparency-preferred rendition to bounded JPEG', async () => {
    const { doc } = fakeDoc()
    mocks.state.encodedSize = ({ mimeType, width }) =>
      mimeType === 'image/jpeg' && width <= 384 ? 400 * 1024 : 600 * 1024

    const rendition = await renderPdfRendition(doc, 1, [0, 0, 400, 200], 'vector')

    expect(rendition.mimeType).toBe('image/jpeg')
    expect(rendition.bytes.byteLength).toBe(400 * 1024)
    expect([rendition.pixelWidth, rendition.pixelHeight]).toEqual([384, 192])
    expect(rendition.pixelWidth / rendition.pixelHeight).toBe(2)
    expect(Math.max(rendition.pixelWidth, rendition.pixelHeight)).toBeLessThanOrEqual(1024)
  })

  it('omits content that cannot satisfy the hard bound and never upscales', async () => {
    const oversized = fakeDoc()
    mocks.state.encodedSize = () => 600 * 1024

    await expect(
      renderPdfRendition(oversized.doc, 1, [0, 0, 400, 200], 'vector')
    ).rejects.toMatchObject({ name: 'VlmError', pageNum: 1 })

    mocks.state.attempts = []
    mocks.state.encodedSize = () => 1024
    const small = fakeDoc()
    const rendition = await renderPdfRendition(small.doc, 1, [0, 0, 100, 50], 'raster')
    expect(rendition.pixelWidth).toBeLessThanOrEqual(Math.floor((100 * 200) / 72))
    expect(rendition.pixelWidth / rendition.pixelHeight).toBeCloseTo(2, 1)
  })
})
