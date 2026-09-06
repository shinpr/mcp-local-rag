// Visual-mode ingest integration: AC-002 (enriched chunks), AC-004 (per-page
// VLM failure tolerated), AC-005 (whole-VLM failure falls back to text),
// AC-006 (non-PDF + visual silently coerced), AC-007 (captions embed).
// Design doc: docs/design/vlm-pdf-enrichment-design.md
//
// The mock of `../../pdf-visual/index.js` is REAL-SHAPED — every export
// returns plausible values so the visual path completes. It must not collide
// with the negative-side Proxy sentinel in ingest-default-mode.test.ts, which
// is why the two live in separate files.
//
// Neither @huggingface/transformers nor mupdf loads here: the captioner is
// reached only through the mocked pdf-visual surface, and parsePdfPages is
// mocked at the parser boundary.

import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectRecord } from '../test-doubles.js'

/** A layout bounding box, as `[x0, y0, x1, y1]`. */
function bbox(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  return [x0, y0, x1, y1]
}

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

// Captioner spy state — shared across the pdf-visual real-shaped mock and the
// per-test arrange phase. The hoisted block is required because the mock
// factories run before any `import` statement (isolate: false + vitest hoisting).
interface CaptionerSpy {
  calls: { pageNum: number }[]
  /** Single pageNum that should throw (set to 2 for AC-004). Null = no per-page throw. */
  throwOn: number | null
  /** When true, every captioner.caption() call throws (AC-005). */
  throwAll: boolean
  /** Pages flagged as visual candidates by the detector mock. Default: page 2. */
  candidatePages: Set<number>
}

const captionerSpy = vi.hoisted<CaptionerSpy>(() => ({
  calls: [],
  throwOn: null,
  throwAll: false,
  candidatePages: new Set<number>([2]),
}))

const mocks = vi.hoisted(() => {
  return {
    // ---------------- fs/promises ----------------
    stat: vi.fn(),

    // ---------------- Parser ----------------
    parseFile: vi.fn(),
    parsePdf: vi.fn(),
    parsePdfPages: vi.fn(),
    // Real DocumentParser methods, called by the pre-parse `contentHash` read.
    validateFilePath: vi.fn().mockResolvedValue(undefined),
    validateFileSize: vi.fn(),

    // ---------------- Chunker ----------------
    chunkText: vi.fn(),

    // ---------------- Embedder + VectorStore (via cli/common.js) ----------------
    embedBatch: vi.fn(),
    initialize: vi.fn(),
    deleteChunks: vi.fn(),
    insertChunks: vi.fn(),
    optimize: vi.fn(),

    // ---------------- doc.destroy spy ----------------
    destroy: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
})

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const fsPromisesFactory = async (
  importOriginal: () => Promise<typeof import('node:fs/promises')>
) => {
  const actual = await importOriginal()
  return {
    ...actual,
    stat: mocks.stat,
    // `ingestSingleFile` reads the raw source bytes to compute `contentHash`.
    // The visual fixtures are mocked parser output, not files on disk, so the
    // byte read returns fixed content.
    readFile: async () => Buffer.from('fixture bytes', 'utf-8'),
  }
}

const parserFactory = () => ({
  DocumentParser: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.parseFile = mocks.parseFile
    this.parsePdf = mocks.parsePdf
    this.parsePdfPages = mocks.parsePdfPages
    // Real DocumentParser boundary checks, as recording spies: the pre-parse
    // `contentHash` read runs them itself, because it no longer sits behind the
    // parse that used to. Their decisions are pinned against a real
    // `DocumentParser` in `ingest-content-hash-pre-parse.test.ts`.
    this.validateFilePath = mocks.validateFilePath
    this.validateFileSize = mocks.validateFileSize
  }),
  SUPPORTED_EXTENSIONS: new Set(['.pdf', '.docx', '.txt', '.md']),
})

const chunkerFactory = () => ({
  SemanticChunker: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.chunkText = mocks.chunkText
  }),
})

const cliCommonFactory = () => ({
  createEmbedder: vi.fn().mockImplementation(() => ({
    embedBatch: mocks.embedBatch,
    dispose: vi.fn(),
  })),
  createVectorStore: vi.fn().mockImplementation(() => ({
    initialize: mocks.initialize,
    deleteChunks: mocks.deleteChunks,
    insertChunks: mocks.insertChunks,
    optimize: mocks.optimize,
    close: vi.fn(),
  })),
  formatCliError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  // Stub the shared CLI base-dirs resolver so visual-mode tests skip the
  // realpath I/O the production resolver performs. The visual tests do not
  // exercise base-dir precedence — they only need a valid config so the
  // `DocumentParser` constructor receives a `baseDirs` array.
  resolveCliBaseDirsOrExit: vi.fn().mockImplementation((cliRoots: string[]) =>
    Promise.resolve({
      config: { baseDirs: cliRoots.length > 0 ? cliRoots : ['/mock/cwd/'] },
      warnings: [],
    })
  ),
})

// Real-shaped region orchestrator. Captions remain isolated per region and
// are inserted into the ordered document by `src/ingest/visual.ts`.
/** Shape the stubbed `processVisualRegions` returns to the ingest pipeline. */
type ProcessedRegion = {
  pageNum: number
  detectionIndex: number
  bbox: [number, number, number, number]
  evidence: 'raster'
  caption: string | null
  rendition?: { bytes: Uint8Array; mimeType: string }
}

const pdfVisualFactory = () => ({
  detectVisualRegions: (pages: { pageNum: number; stextJson: unknown }[]) =>
    pages
      .filter((page) => captionerSpy.candidatePages.has(page.pageNum))
      .map((page, detectionIndex) => ({
        pageNum: page.pageNum,
        detectionIndex,
        bbox: [0, 0, 10, 10],
        evidence: 'raster',
      })),
  processVisualRegions: async (
    regions: Array<{
      pageNum: number
      detectionIndex: number
      bbox: [number, number, number, number]
      evidence: 'raster'
    }>,
    _doc: unknown,
    options: { includeImages?: boolean }
  ) => {
    const processed: ProcessedRegion[] = []
    for (const region of regions) {
      captionerSpy.calls.push({ pageNum: region.pageNum })
      if (captionerSpy.throwAll || captionerSpy.throwOn === region.pageNum) {
        console.warn(`VLM caption failed for page ${region.pageNum}: simulated failure`)
        processed.push({ ...region, caption: null })
      } else {
        processed.push({
          ...region,
          caption: 'synthetic caption text',
          ...(options.includeImages
            ? {
                rendition: {
                  bytes: new Uint8Array([1, 2, 3]),
                  mimeType: 'image/png',
                },
              }
            : {}),
        })
      }
    }
    return processed
  },
  createCaptioner: () => ({
    caption: async () => 'synthetic caption text',
    dispose: mocks.dispose,
  }),
})

const detectorFactory = () => ({
  detectVisualRegions: (pages: { pageNum: number }[]) =>
    pages
      .filter((page) => captionerSpy.candidatePages.has(page.pageNum))
      .map((page, detectionIndex) => ({
        pageNum: page.pageNum,
        detectionIndex,
        bbox: [0, 0, 10, 10],
        evidence: 'raster',
      })),
})

const rendererFactory = () => ({
  renderPdfRendition: async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
  }),
})

const MOCKED_PATHS = [
  'node:fs/promises',
  '../../parser/index.js',
  '../../chunker/index.js',
  '../../cli/common.js',
  '../../pdf-visual/index.js',
  '../../pdf-visual/detector.js',
  '../../pdf-visual/renderer.js',
] as const

// Dynamically imported after vi.resetModules() in beforeAll. Load-bearing
// under `isolate: false`: a sibling file that mocks the same paths can
// otherwise win the module-registry race and bind runIngest's closures to its
// factories instead of this file's.
let runIngest: typeof import('../../cli/ingest.js').runIngest

// ============================================
// Helpers
// ============================================

interface CapturedInsert {
  filePath: string
  chunkIndex: number
  text: string
  vector: number[]
  fileTitle: string | null
  visualAttachments: string | null
}

/**
 * Capture stderr (console.error) and stderr-warn (console.warn) output.
 * Also accumulates every chunk passed to `insertChunks` so test assertions
 * can inspect the full set of inserted chunks (text + vector).
 */
function captureRun(fn: () => Promise<void>): Promise<{
  stderr: string[]
  warnings: string[]
  inserted: CapturedInsert[]
  error: unknown
}> {
  const stderr: string[] = []
  const warnings: string[] = []
  const inserted: CapturedInsert[] = []

  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  })
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })

  // Default-shape insertChunks that records every chunk for later assertion.
  mocks.insertChunks.mockImplementation((chunks: unknown[]) => {
    for (const c of chunks) {
      const row = expectRecord(c)
      inserted.push({
        filePath: String(row['filePath']),
        chunkIndex: Number(row['chunkIndex']),
        text: String(row['text']),
        vector: Array.isArray(row['vector']) ? row['vector'].map(Number) : [],
        fileTitle: typeof row['fileTitle'] === 'string' ? row['fileTitle'] : null,
        visualAttachments:
          typeof row['visualAttachments'] === 'string' ? row['visualAttachments'] : null,
      })
    }
    return Promise.resolve(undefined)
  })

  return fn()
    .then(() => ({ stderr, warnings, inserted, error: undefined }))
    .catch((error: unknown) => ({ stderr, warnings, inserted, error }))
    .finally(() => {
      errSpy.mockRestore()
      warnSpy.mockRestore()
    })
}

function mockFileStat() {
  return { isFile: () => true, isDirectory: () => false }
}

/**
 * Synthetic 3-page parsePdfPages result. Page 2 carries an image-block stext
 * entry for realism; the detector mock reads `captionerSpy.candidatePages`.
 */
function buildThreePageParseResult() {
  const page = (pageNum: number, text: string, blockType: 'text' | 'image') => ({
    pageNum,
    text,
    textFragments: [
      {
        pageNum,
        blockOrdinal: 0,
        lineOrdinal: 0,
        fragmentOrdinal: 0,
        bbox: bbox(0, 0, 100, 10),
        text,
        pageTextStart: 0,
        pageTextEnd: text.length,
      },
    ],
    stextJson: { blocks: [{ type: blockType }] },
  })
  return {
    doc: { destroy: mocks.destroy },
    title: 'Plain PDF',
    pages: [
      page(1, 'page 1 plain text', 'text'),
      page(2, 'page 2 plain text', 'image'),
      page(3, 'page 3 plain text', 'text'),
    ],
  }
}

/**
 * The chunker emits one chunk per `\n\n` boundary — the same separator the
 * dispatch site joins enriched pages with — capped at 4 for sanity.
 */
function setupChunkerAndEmbedder() {
  mocks.chunkText.mockImplementation(async (text: string) => {
    const parts = text.split('\n\n').filter((p) => p.trim().length > 0)
    let sourceStart = 0
    return parts.map((part, index) => {
      const start = text.indexOf(part, sourceStart)
      sourceStart = start + part.length
      return { text: part, index, sourceStart: start, sourceEnd: sourceStart }
    })
  })
  mocks.embedBatch.mockImplementation(async (texts: string[]) =>
    texts.map(() => [0.11, 0.22, 0.33])
  )
}

/**
 * Set up the persistence stubs to resolve quietly.
 */
function setupPersistenceStubs() {
  mocks.initialize.mockResolvedValue(undefined)
  mocks.deleteChunks.mockResolvedValue(undefined)
  mocks.optimize.mockResolvedValue(undefined)
}

// ============================================
// Tests
// ============================================

describe('VLM PDF Enrichment - Visual Mode', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('node:fs/promises', fsPromisesFactory)
    vi.doMock('../../parser/index.js', parserFactory)
    vi.doMock('../../chunker/index.js', chunkerFactory)
    vi.doMock('../../cli/common.js', cliCommonFactory)
    vi.doMock('../../pdf-visual/index.js', pdfVisualFactory)
    vi.doMock('../../pdf-visual/detector.js', detectorFactory)
    vi.doMock('../../pdf-visual/renderer.js', rendererFactory)
    ;({ runIngest } = await import('../../cli/ingest.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) {
      vi.doUnmock(p)
    }
    vi.resetModules()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset captionerSpy state to its document-default shape.
    captionerSpy.calls.length = 0
    captionerSpy.throwOn = null
    captionerSpy.throwAll = false
    captionerSpy.candidatePages = new Set<number>([2])

    // Re-arm the default fixture shape after vi.clearAllMocks() wiped it.
    mocks.parsePdfPages.mockResolvedValue(buildThreePageParseResult())
    mocks.parsePdf.mockResolvedValue({
      content: 'plain PDF text long enough for one deterministic chunk',
      title: 'Plain PDF',
    })
    setupChunkerAndEmbedder()
    setupPersistenceStubs()

    // Mock process.exit so the bulk-loop summary path can run without leaving
    // the test runner. Throwing from exit makes a non-zero exit visible as a
    // thrown error in `captureRun`.
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })
  })

  afterEach(() => {
    exitSpy.mockRestore()
    process.exitCode = undefined
  })

  const NO_FLAGS: string[] = []

  it.each([
    { flags: NO_FLAGS, captioned: false, storedImages: false },
    { flags: ['--visual'], captioned: true, storedImages: false },
    { flags: ['--images'], captioned: false, storedImages: true },
    { flags: ['--visual', '--images'], captioned: true, storedImages: true },
  ])(
    'keeps PDF captioning=$captioned and image storage=$storedImages independent',
    async ({ flags, captioned, storedImages }) => {
      const filePath = '/mock/cwd/option-matrix.pdf'
      mocks.stat.mockResolvedValue(mockFileStat())

      const { inserted, error } = await captureRun(() => runIngest([...flags, filePath]))

      expect(error).toBeUndefined()
      expect(inserted.length).toBeGreaterThan(0)
      expect(inserted.some((row) => row.text.includes('[Visual content on page'))).toBe(captioned)
      expect(inserted.some((row) => JSON.parse(row.visualAttachments ?? '[]').length > 0)).toBe(
        storedImages
      )
      expect(inserted.every((row) => row.fileTitle === 'Plain PDF')).toBe(true)
      expect(captionerSpy.calls.length > 0).toBe(captioned)
    }
  )

  // AC-002: `visual: true` on a 3-page PDF with a figure on page 2 produces a
  // `[Visual content on page 2: ...]` caption in the inserted chunks, and none
  // on pages 1 and 3.
  it.each([false, true])('releases the captioner when chunking fails=%s', async (fail) => {
    mocks.stat.mockResolvedValue(mockFileStat())
    if (fail) {
      mocks.chunkText.mockRejectedValueOnce(new Error('Chunking failed'))
    }
    await captureRun(() => runIngest(['--visual', resolve('/tmp/test/lifecycle.pdf')]))
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })

  it('AC-002: visual mode enriches page 2 with caption substring', async () => {
    // Arrange: 3-page PDF, page 2 is the only candidate (default state).
    const filePath = resolve('/tmp/test/ac002.pdf')
    mocks.stat.mockResolvedValue(mockFileStat())

    // Act
    const { inserted, error } = await captureRun(() => runIngest(['--visual', filePath]))

    // Assert: ingest completed without throwing.
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: at least one inserted chunk carries the page-2 caption marker.
    const page2Chunks = inserted.filter((c) =>
      c.text.includes('[Visual content on page 2, visual 0: ')
    )
    expect(page2Chunks.length).toBeGreaterThan(0)

    // Assert: the caption body text is recoverable in that chunk.
    expect(page2Chunks[0]?.text).toContain('synthetic caption text')

    // Assert: pages 1 and 3 contribute chunks but carry no visual marker.
    const nonVisualChunks = inserted.filter((c) => !c.text.includes('[Visual content on page'))
    expect(nonVisualChunks.some((c) => c.text === 'page 1 plain text')).toBe(true)
    expect(nonVisualChunks.some((c) => c.text === 'page 3 plain text')).toBe(true)
  })

  // AC-004: a per-page VLM failure is tolerated — page 2's text is kept
  // without a caption, other candidate pages keep theirs, and the failed page
  // is named in a warning. Pages 2 AND 3 are candidates so the surviving case
  // is exercised too.
  it('AC-004: per-page VLM failure on page 2 leaves that page text-only and other pages enriched', async () => {
    // Arrange: pages 2 AND 3 are candidates; captioner throws only on page 2.
    captionerSpy.candidatePages = new Set<number>([2, 3])
    captionerSpy.throwOn = 2
    const filePath = resolve('/tmp/test/ac004.pdf')
    mocks.stat.mockResolvedValue(mockFileStat())

    // Act
    const { inserted, warnings, error } = await captureRun(() => runIngest(['--visual', filePath]))

    // Assert: ingest completed without throwing.
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: NO chunk has the page-2 caption marker.
    const page2Marker = inserted.filter((c) =>
      c.text.includes('[Visual content on page 2, visual 0:')
    )
    expect(page2Marker).toHaveLength(0)

    // Assert: page 2's raw text is still present in the index.
    expect(inserted.some((c) => c.text === 'page 2 plain text')).toBe(true)

    // Assert: page 3 KEEPS its caption marker (per-page failure does not
    // poison the rest of the file).
    const page3Marker = inserted.filter((c) =>
      c.text.includes('[Visual content on page 3, visual 1: synthetic caption text')
    )
    expect(page3Marker.length).toBeGreaterThan(0)

    // Assert: warn-level log names page 2.
    const page2Warning = warnings.filter((w) => w.includes('page 2'))
    expect(page2Warning.length).toBeGreaterThan(0)
  })

  // AC-005: when the VLM throws on every candidate page, ingest still
  // completes with text-only chunks and no error reaches the caller.
  it('AC-005: whole-VLM failure falls back to text-only chunks without propagating error', async () => {
    // Arrange: page 2 is candidate; captioner throws on EVERY call.
    captionerSpy.throwAll = true
    const filePath = resolve('/tmp/test/ac005.pdf')
    mocks.stat.mockResolvedValue(mockFileStat())

    // Act
    const { inserted, stderr, error } = await captureRun(() => runIngest(['--visual', filePath]))

    // Assert: ingest completed without propagating any error.
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: NO chunk contains the visual marker — text-only fallback.
    const visualMarkerChunks = inserted.filter((c) => c.text.includes('[Visual content on page'))
    expect(visualMarkerChunks).toHaveLength(0)

    // Assert: text-only chunks were still produced for all 3 pages.
    expect(inserted.length).toBeGreaterThan(0)
    expect(inserted.some((c) => c.text === 'page 1 plain text')).toBe(true)
    expect(inserted.some((c) => c.text === 'page 2 plain text')).toBe(true)
    expect(inserted.some((c) => c.text === 'page 3 plain text')).toBe(true)

    // Assert: the per-file OK summary line reflects the normal chunk-count
    // return value (i.e. ingestSingleFile returned a positive count, not
    // SKIPPED). 3 input pages with one chunk each → 3 chunks.
    const summary = stderr.find((s) => s.includes('OK ('))
    expect(summary).toBeDefined()
    expect(summary).toContain('OK (3 chunks)')
  })

  // AC-006: a non-PDF with `visual: true` takes the text-only path silently —
  // no VLM call, no warning, `parseFile` rather than `parsePdfPages`.
  it('AC-006: visual: true on .md file silently behaves as visual: false', async () => {
    // Arrange: a .md fixture and a parseFile result. parsePdfPages must NOT be reached.
    const filePath = resolve('/tmp/test/ac006.md')
    mocks.stat.mockResolvedValue(mockFileStat())
    mocks.parseFile.mockResolvedValue({
      content: 'markdown body content',
      title: 'Markdown Title',
    })

    // Act
    const { inserted, warnings, error } = await captureRun(() => runIngest(['--visual', filePath]))

    // Assert: ingest succeeded.
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // Assert: captioner mock was never invoked.
    expect(captionerSpy.calls).toHaveLength(0)

    // Assert: no inserted chunk has the visual marker.
    const visualMarkerChunks = inserted.filter((c) => c.text.includes('[Visual content on page'))
    expect(visualMarkerChunks).toHaveLength(0)

    // Assert: no warn-level log fired from the visual orchestrator.
    expect(warnings).toHaveLength(0)

    // Assert: parser.parseFile was the boundary entered, not parsePdfPages or parsePdf.
    expect(mocks.parseFile).toHaveBeenCalledTimes(1)
    expect(mocks.parseFile).toHaveBeenCalledWith(filePath, { images: false })
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
  })
})
