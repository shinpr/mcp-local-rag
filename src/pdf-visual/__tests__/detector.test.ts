import type { Matrix, Document as MupdfDocument } from 'mupdf'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type PathWalker = {
  moveTo?: (x: number, y: number) => void
  lineTo?: (x: number, y: number) => void
  curveTo?: (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => void
  closePath?: () => void
}

type DeviceCallbacks = {
  strokePath?: (...args: unknown[]) => void
  fillPath?: (...args: unknown[]) => void
  fillShade?: (...args: unknown[]) => void
}

const mocks = vi.hoisted(() => {
  class Device {
    readonly callbacks: DeviceCallbacks
    readonly close = vi.fn()

    constructor(callbacks: DeviceCallbacks) {
      this.callbacks = callbacks
    }
  }

  return { Device, identity: [1, 0, 0, 1, 0, 0] as Matrix }
})

const mupdfFactory = () => ({
  Device: mocks.Device,
  Matrix: { identity: mocks.identity },
  Rect: {
    transform: (rect: [number, number, number, number], matrix: Matrix) => {
      const [a, b, c, d, e, f] = matrix
      const points = [
        [rect[0], rect[1]],
        [rect[2], rect[1]],
        [rect[0], rect[3]],
        [rect[2], rect[3]],
      ].map(([x, y]) => [
        a * (x as number) + c * (y as number) + e,
        b * (x as number) + d * (y as number) + f,
      ])
      return [
        Math.min(...points.map((point) => point[0] as number)),
        Math.min(...points.map((point) => point[1] as number)),
        Math.max(...points.map((point) => point[0] as number)),
        Math.max(...points.map((point) => point[1] as number)),
      ]
    },
  },
})

const PAGE_BOUNDS = [0, 0, 1000, 1000] as const
const IDENTITY = [1, 0, 0, 1, 0, 0] as Matrix

let detectVisualRegions: typeof import('../detector.js').detectVisualRegions

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('mupdf', mupdfFactory)
  ;({ detectVisualRegions } = await import('../detector.js'))
})

afterAll(() => {
  vi.doUnmock('mupdf')
  vi.resetModules()
})

function bbox(x0: number, y0: number, x1: number, y1: number) {
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

type Scenario = (callbacks: DeviceCallbacks) => void

function fakeDoc(scenarios: Scenario[]): {
  doc: MupdfDocument
  pages: Array<{ run: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>
} {
  const pages = scenarios.map((scenario) => ({
    getBounds: vi.fn().mockReturnValue([...PAGE_BOUNDS]),
    run: vi.fn((device: { callbacks: DeviceCallbacks }) => scenario(device.callbacks)),
    destroy: vi.fn(),
  }))
  return {
    doc: { loadPage: vi.fn((index: number) => pages[index]) } as unknown as MupdfDocument,
    pages,
  }
}

type PathCommand = (walker: PathWalker) => void

function fakePath(commands: PathCommand[], fallback: [number, number, number, number]) {
  return {
    walk: vi.fn((walker: PathWalker) => {
      for (const command of commands) command(walker)
    }),
    getBounds: vi.fn().mockReturnValue(fallback),
  }
}

function moveTo(x: number, y: number): PathCommand {
  return (walker) => walker.moveTo?.(x, y)
}

function lineTo(x: number, y: number): PathCommand {
  return (walker) => walker.lineTo?.(x, y)
}

function closePath(): PathCommand {
  return (walker) => walker.closePath?.()
}

function throwWalk(message: string): PathCommand {
  return () => {
    throw new Error(message)
  }
}

function fill(callbacks: DeviceCallbacks, path: ReturnType<typeof fakePath>, alpha = 1) {
  callbacks.fillPath?.(path, false, IDENTITY, {}, [], alpha)
}

function stroke(callbacks: DeviceCallbacks, path: ReturnType<typeof fakePath>, alpha = 1) {
  callbacks.strokePath?.(path, {}, IDENTITY, {}, [], alpha)
}

function page(pageNum: number, blocks: unknown[] = []) {
  return { pageNum, stextJson: { blocks } }
}

describe('detectVisualRegions', () => {
  it('always scans vector callbacks and returns independent raster and vector regions', () => {
    const vectorPath = fakePath(
      [moveTo(600, 600), lineTo(900, 600), lineTo(900, 900), lineTo(600, 900), closePath()],
      [600, 600, 900, 900]
    )
    const { doc, pages } = fakeDoc([(callbacks) => fill(callbacks, vectorPath)])

    const regions = detectVisualRegions(
      [page(1, [{ type: 'image', bbox: bbox(100, 100, 420, 420) }])],
      doc
    )

    expect(pages[0]?.run).toHaveBeenCalledTimes(1)
    expect(regions).toHaveLength(2)
    expect(regions.map((region) => region.evidence)).toEqual(['raster', 'vector'])
    expect(regions.map((region) => region.detectionIndex)).toEqual([0, 1])
  })

  it('keeps disconnected subpaths in one painted path as separate regions', () => {
    const path = fakePath(
      [
        moveTo(100, 100),
        lineTo(300, 100),
        lineTo(300, 300),
        lineTo(100, 300),
        closePath(),
        moveTo(650, 650),
        lineTo(850, 650),
        lineTo(850, 850),
        lineTo(650, 850),
        closePath(),
      ],
      [100, 100, 850, 850]
    )
    const { doc } = fakeDoc([(callbacks) => fill(callbacks, path)])

    const regions = detectVisualRegions([page(1)], doc)

    expect(regions).toHaveLength(2)
    expect(path.getBounds).not.toHaveBeenCalled()
    expect(regions[0]?.bbox[2]).toBeLessThan(regions[1]?.bbox[0] as number)
  })

  it('qualifies a batched grid from two horizontal and two vertical thin rules', () => {
    const path = fakePath(
      [
        moveTo(100, 100),
        lineTo(400, 100),
        moveTo(100, 300),
        lineTo(400, 300),
        moveTo(150, 50),
        lineTo(150, 350),
        moveTo(350, 50),
        lineTo(350, 350),
      ],
      [100, 50, 400, 350]
    )
    const { doc } = fakeDoc([(callbacks) => stroke(callbacks, path)])

    const regions = detectVisualRegions([page(1)], doc)

    expect(regions).toHaveLength(1)
    expect(regions[0]?.evidence).toBe('vector')
  })

  it.each([
    ['completed walk with zero local evidence', []],
    ['walk failure before local evidence', [throwWalk('pre-evidence failure')]],
  ])('uses one filtered whole-path fallback after %s', (_name, commands) => {
    const path = fakePath(commands, [200, 200, 400, 400])
    const { doc } = fakeDoc([(callbacks) => fill(callbacks, path)])

    const regions = detectVisualRegions([page(1)], doc)

    expect(path.getBounds).toHaveBeenCalledTimes(1)
    expect(regions).toHaveLength(1)
    expect(regions[0]?.bbox).toEqual([184, 184, 416, 416])
  })

  it('retains accepted local evidence without an enclosing fallback after a partial walk failure', () => {
    const path = fakePath(
      [
        moveTo(100, 100),
        lineTo(250, 100),
        lineTo(250, 250),
        lineTo(100, 250),
        closePath(),
        moveTo(800, 800),
        throwWalk('partial failure'),
      ],
      [100, 100, 900, 900]
    )
    const { doc } = fakeDoc([(callbacks) => fill(callbacks, path)])

    const regions = detectVisualRegions([page(1)], doc)

    expect(path.getBounds).not.toHaveBeenCalled()
    expect(regions).toHaveLength(1)
    expect(regions[0]?.bbox).toEqual([88, 88, 262, 262])
  })

  it('qualifies a nearby three-bar filled-only figure below the single-fill threshold', () => {
    const bars = [
      [100, 200, 150, 350],
      [165, 150, 215, 350],
      [230, 100, 280, 350],
    ] as const
    const { doc } = fakeDoc([
      (callbacks) => {
        for (const [x0, y0, x1, y1] of bars) {
          fill(
            callbacks,
            fakePath(
              [moveTo(x0, y0), lineTo(x1, y0), lineTo(x1, y1), lineTo(x0, y1), closePath()],
              [x0, y0, x1, y1]
            )
          )
        }
      },
    ])

    const regions = detectVisualRegions([page(1)], doc)

    expect(regions).toHaveLength(1)
    expect(regions[0]?.evidence).toBe('vector')
  })

  it('transforms and qualifies shade bounds', () => {
    const shade = { getBounds: vi.fn().mockReturnValue([10, 20, 110, 120]) }
    const { doc } = fakeDoc([(callbacks) => callbacks.fillShade?.(shade, [2, 0, 0, 1, 100, 50], 1)])

    const regions = detectVisualRegions([page(1)], doc)

    expect(regions).toHaveLength(1)
    expect(regions[0]?.bbox).toEqual([104, 58, 336, 182])
  })

  it('rejects a tiled fill-only component that recreates a page background', () => {
    const tiles = [
      [0, 0, 500, 500],
      [500, 0, 1000, 500],
      [0, 500, 500, 1000],
      [500, 500, 1000, 1000],
    ] as const
    const { doc } = fakeDoc([
      (callbacks) => {
        for (const [x0, y0, x1, y1] of tiles) {
          fill(
            callbacks,
            fakePath(
              [moveTo(x0, y0), lineTo(x1, y0), lineTo(x1, y1), lineTo(x0, y1), closePath()],
              [x0, y0, x1, y1]
            )
          )
        }
      },
    ])

    expect(detectVisualRegions([page(1)], doc)).toEqual([])
  })

  it('preserves a large filled chart when its local stroke subset independently qualifies', () => {
    const tiles = [
      [0, 0, 500, 500],
      [500, 0, 1000, 500],
      [0, 500, 500, 1000],
      [500, 500, 1000, 1000],
    ] as const
    const grid = fakePath(
      [
        moveTo(100, 100),
        lineTo(900, 100),
        moveTo(100, 200),
        lineTo(900, 200),
        moveTo(100, 300),
        lineTo(900, 300),
        moveTo(100, 400),
        lineTo(900, 400),
        moveTo(100, 500),
        lineTo(900, 500),
      ],
      [100, 100, 900, 500]
    )
    const { doc } = fakeDoc([
      (callbacks) => {
        for (const [x0, y0, x1, y1] of tiles) {
          fill(
            callbacks,
            fakePath(
              [moveTo(x0, y0), lineTo(x1, y0), lineTo(x1, y1), lineTo(x0, y1), closePath()],
              [x0, y0, x1, y1]
            )
          )
        }
        stroke(callbacks, grid)
      },
    ])

    const regions = detectVisualRegions([page(1)], doc)

    expect(regions).toHaveLength(1)
    expect(regions[0]?.bbox).toEqual([0, 0, 1000, 1000])
  })

  it('sorts regions deterministically and normalizes bbox coordinates', () => {
    const { doc } = fakeDoc([() => {}])

    const regions = detectVisualRegions(
      [
        page(1, [
          { type: 'image', bbox: bbox(600, 600, 920, 920) },
          { type: 'image', bbox: bbox(100, 100, 420, 420) },
        ]),
      ],
      doc
    )

    expect(regions.map((region) => region.detectionIndex)).toEqual([0, 1])
    expect(regions[0]?.bbox).toEqual([74.4, 74.4, 445.6, 445.6])
    expect(regions[0]?.normalizedBbox).toEqual([0.0744, 0.0744, 0.4456, 0.4456])
    expect(regions[1]?.bbox).toEqual([574.4, 574.4, 945.6, 945.6])
  })
})
