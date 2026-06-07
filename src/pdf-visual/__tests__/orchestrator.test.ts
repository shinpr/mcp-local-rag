// `enrichPagesWithCaptions` unit tests (AC-003, AC-004).
//
// Asserts the orchestrator's public contract:
//
//   enrichPagesWithCaptions(
//     pages: Array<{ pageNum, text, stextJson }>,
//     candidates: Array<{ pageNum, isCandidate }>,
//     doc: MupdfDocument,
//     captioner: Captioner
//   ): Promise<{ pages, captions: Array<{ pageNum, text }> }>
//
// Per the visual-quality-mode refactor, captions are no longer mutated into
// `page.text`. The orchestrator returns the unchanged `pages` array plus a
// dedicated `captions` array; the `[Visual content on page N: ...]` wrapper
// and chunk emission live in `src/ingest/visual.ts`.
//
// Verification points:
//   - AC-003: when no candidate has `isCandidate === true`, the captioner is
//     never invoked (call count 0), the renderer is never invoked, and the
//     returned `captions` array is empty.
//   - AC-004: per-page captioner failures are swallowed — the failing page
//     produces no `captions[]` entry, while subsequent candidate pages do.
//     A warn/error-level log line names the failed page.
//   - null caption: when the captioner returns `null`, the page produces no
//     `captions[]` entry AND a warn log line names the page (null → warn log,
//     same effect as failure but distinct log channel).
//   - Happy path: a candidate page produces a `{ pageNum, text }` record on
//     `captions[]` with the raw caption string (no `[Visual content ...]`
//     wrapper — wrapping is applied by `ingest/visual.ts`). `page.text` is
//     never mutated.
//
// Renderer and captioner are mocked via `vi.hoisted` per the project-wide
// constraint (`vitest.config.mjs` sets `isolate: false`, so mock factories
// must be hoisted to be visible inside `vi.mock` before the SUT imports the
// module).

import type { Document as MupdfDocument } from 'mupdf'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mocks (vi.hoisted — required for `../renderer` and `../captioner`)
// ============================================

const mocks = vi.hoisted(() => {
  // Shared state controllable from individual tests.
  const state: {
    // Page-keyed captioner behaviour. If absent, `defaultCaption` is returned.
    captionByPage: Map<number, string | null | Error>
    defaultCaption: string | null
    // Page-keyed renderer behaviour. If absent, `defaultPng` is returned.
    renderByPage: Map<number, Error>
    defaultPng: Uint8Array
  } = {
    captionByPage: new Map(),
    defaultCaption: 'a generic caption',
    renderByPage: new Map(),
    defaultPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  }

  const renderSpy = vi.fn(
    async (_doc: unknown, pageNum: number, _cropRect?: unknown): Promise<Uint8Array> => {
      const override = state.renderByPage.get(pageNum)
      if (override) throw override
      return state.defaultPng
    }
  )

  const captionSpy = vi.fn(async (_png: Uint8Array, pageNum: number): Promise<string | null> => {
    const override = state.captionByPage.get(pageNum)
    if (override instanceof Error) throw override
    if (override !== undefined) return override
    return state.defaultCaption
  })

  return { state, renderSpy, captionSpy }
})

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const rendererFactory = () => ({
  renderPdfPage: mocks.renderSpy,
})

const captionerFactory = () => ({
  // The orchestrator imports `Captioner` from `../types.js`, not from here,
  // so we only need to ensure this module load resolves cleanly during tests
  // that may transitively import it. Provide a no-op `createCaptioner`.
  createCaptioner: vi.fn(),
})

const MOCKED_PATHS = ['../renderer.js', '../captioner.js'] as const

import type { Captioner } from '../types.js'

let enrichPagesWithCaptions: typeof import('../index.js').enrichPagesWithCaptions

// ============================================
// Helpers
// ============================================

type PageRecord = { pageNum: number; text: string; stextJson: unknown }

function makePages(specs: Array<{ pageNum: number; text: string }>): PageRecord[] {
  return specs.map((s) => ({
    pageNum: s.pageNum,
    text: s.text,
    // The orchestrator does not read stextJson; pass through opaquely.
    stextJson: { blocks: [] },
  }))
}

// The orchestrator receives a `Captioner` instance and calls `.caption(...)`
// on it. We wire the hoisted spy through here so individual tests can adjust
// `mocks.state` to control behaviour.
const captioner: Captioner = {
  caption: (png, pageNum) => mocks.captionSpy(png, pageNum),
}

// `doc` is forwarded verbatim to `renderPdfPage`, which is mocked, so any
// sentinel object is fine.
const fakeDoc = { _sentinel: 'mupdf-doc' } as unknown as MupdfDocument

// ============================================
// Tests
// ============================================

describe('enrichPagesWithCaptions', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../renderer.js', rendererFactory)
    vi.doMock('../captioner.js', captionerFactory)
    ;({ enrichPagesWithCaptions } = await import('../index.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  beforeEach(() => {
    // Reset shared state between tests.
    mocks.state.captionByPage = new Map()
    mocks.state.defaultCaption = 'a generic caption'
    mocks.state.renderByPage = new Map()
    mocks.renderSpy.mockClear()
    mocks.captionSpy.mockClear()
    // Silence and capture console output. Use `mockImplementation` (not
    // `mockReturnValue`) so the original method is fully shadowed.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('AC-003: skips captioner entirely when no page is a visual candidate', async () => {
    // Arrange: detector marks every page as not-a-candidate.
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
      { pageNum: 3, text: 'page three body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: false },
      { pageNum: 3, isCandidate: false },
    ]

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert: zero VLM invocations (the AC-003 invariant) and zero renderer
    // invocations (no point rendering a page we will not caption).
    expect(mocks.captionSpy).toHaveBeenCalledTimes(0)
    expect(mocks.renderSpy).toHaveBeenCalledTimes(0)
    // Texts pass through unchanged.
    expect(result.pages.map((p) => p.text)).toEqual([
      'page one body',
      'page two body',
      'page three body',
    ])
    // No captions produced.
    expect(result.captions).toEqual([])
  })

  it('AC-004: a single page captioner failure is swallowed; other pages still get captions', async () => {
    // Arrange: pages 2 and 3 are candidates. Captioner throws on page 2 and
    // returns a real caption on page 3.
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
      { pageNum: 3, text: 'page three body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true },
      { pageNum: 3, isCandidate: true },
    ]
    mocks.state.captionByPage.set(2, new Error('simulated VLM failure'))
    mocks.state.captionByPage.set(3, 'bar chart with X axis labels')

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert
    // Page texts are never mutated — both pages pass through verbatim.
    const byPage = new Map(result.pages.map((p) => [p.pageNum, p.text]))
    expect(byPage.get(2)).toBe('page two body')
    expect(byPage.get(3)).toBe('page three body')
    // Page 2 failure swallowed → no caption record.
    // Page 3 happy path → one caption record with the raw caption string
    // (no `[Visual content ...]` wrapper — wrapping happens in ingest/visual.ts).
    expect(result.captions).toEqual([{ pageNum: 3, text: 'bar chart with X axis labels' }])
    // A log line names page 2. The DD specifies error-level for throw paths
    // and warn-level for null paths; either log channel is acceptable for the
    // throw path so long as the page number is captured.
    const allLogMessages = [...warnSpy.mock.calls.flat(), ...errorSpy.mock.calls.flat()]
      .map((arg) => (typeof arg === 'string' ? arg : ''))
      .join(' | ')
    expect(allLogMessages).toMatch(/page 2/)
  })

  it('warns and leaves text unchanged when captioner returns null (empty caption)', async () => {
    // Arrange: page 2 is a candidate, captioner returns `null` (DD: null
    // post-sanitization → warn log, no caption appended).
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true, cropRect: [1, 2, 3, 4] as [number, number, number, number] },
    ]
    mocks.state.captionByPage.set(2, null)

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert
    const byPage = new Map(result.pages.map((p) => [p.pageNum, p.text]))
    expect(byPage.get(2)).toBe('page two body')
    // No caption record was produced for the null page.
    expect(result.captions).toEqual([])
    // The null path must be warn-level, not error-level (it is not a failure).
    const warnMessages = warnSpy.mock.calls
      .flat()
      .map((arg: unknown) => (typeof arg === 'string' ? arg : ''))
      .join(' | ')
    expect(warnMessages).toMatch(/page 2/)
    // And no error log for the null case (it is the documented non-error skip).
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  it('happy path: emits a {pageNum, text} caption record without mutating page.text', async () => {
    // Arrange: page 2 is the sole candidate.
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true, cropRect: [1, 2, 3, 4] as [number, number, number, number] },
    ]
    mocks.state.captionByPage.set(2, 'pie chart 40 / 35 / 25 percent')

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert: pages pass through unchanged; caption surfaces only via the
    // dedicated `captions` array. The `[Visual content on page N: ...]`
    // wrapper is applied downstream in `src/ingest/visual.ts`, not here.
    const byPage = new Map(result.pages.map((p) => [p.pageNum, p.text]))
    expect(byPage.get(1)).toBe('page one body')
    expect(byPage.get(2)).toBe('page two body')
    expect(result.captions).toEqual([{ pageNum: 2, text: 'pie chart 40 / 35 / 25 percent' }])
    // The candidate page invoked the renderer and the captioner exactly once.
    expect(mocks.renderSpy).toHaveBeenCalledTimes(1)
    expect(mocks.renderSpy).toHaveBeenCalledWith(fakeDoc, 2, [1, 2, 3, 4])
    expect(mocks.captionSpy).toHaveBeenCalledTimes(1)
    expect(mocks.captionSpy).toHaveBeenCalledWith(mocks.state.defaultPng, 2)
  })
})
