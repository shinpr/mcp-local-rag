// VLM PDF Enrichment - Visual Mode Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-002 (visual mode produces enriched chunks),
//         AC-004 (per-page VLM failure tolerated),
//         AC-005 (whole-VLM failure → text fallback),
//         AC-006 (non-PDF + visual: true silent coercion),
//         AC-007 (caption embeds correctly through chunker/embedder)
// Test Type: Integration Test (in-process cli ingest dispatch + pdf-visual mocked)
// Implementation Timing: Phase 4 (alongside dispatch-site wiring)
//
// Lane: integration. Justification: AC-002/004/005/006/007 — visual-mode
// behavior witnesses that require end-to-end dispatch through ingestSingleFile.
//
// vi.hoisted note: Required by isolate: false (vitest.config.mjs:16-18).
// The mock of '../../pdf-visual/index.js' is a REAL-SHAPED mock — each
// export is a callable that returns plausible values so the visual path
// completes end-to-end. This mock MUST NOT collide with the negative-side
// Proxy sentinel in ingest-default-mode.test.ts; the two live in separate
// files for that reason (DD §Testing Strategy → NFR-1 probe).
//
// @huggingface/transformers is NOT loaded in this file because the captioner
// is invoked only through the mocked pdf-visual surface. mupdf is also not
// loaded — parser.parsePdfPages is mocked at the parser boundary.

import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

// Captioner spy state — shared across the pdf-visual real-shaped mock and the
// per-test arrange phase. The hoisted block is required because the mock
// factories run before any `import` statement (isolate: false + vitest hoisting).
const captionerSpy = vi.hoisted(() => ({
  calls: [] as { pageNum: number }[],
  // Single pageNum that should throw (set to 2 for AC-004). Null = no per-page throw.
  throwOn: null as number | null,
  // When true, every captioner.caption() call throws (AC-005).
  throwAll: false,
  // Pages flagged as visual candidates by the detector mock. Default: page 2.
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
const pdfVisualFactory = () => ({
  detectVisualRegions: (pages: { pageNum: number; stextJson: unknown }[]) =>
    pages
      .filter((page) => captionerSpy.candidatePages.has(page.pageNum))
      .map((page, detectionIndex) => ({
        pageNum: page.pageNum,
        detectionIndex,
        bbox: [0, 0, 10, 10],
        normalizedBbox: [0, 0, 0.1, 0.1],
        evidence: 'raster',
      })),
  processVisualRegions: async (
    regions: Array<{
      pageNum: number
      detectionIndex: number
      bbox: [number, number, number, number]
      normalizedBbox: [number, number, number, number]
      evidence: 'raster'
    }>,
    _doc: unknown,
    options: { includeImages?: boolean }
  ) => {
    const processed = []
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
                  pixelWidth: 10,
                  pixelHeight: 10,
                },
              }
            : {}),
        })
      }
    }
    return processed
  },
  createVisualAttachment: (
    region: { pageNum: number; normalizedBbox: [number, number, number, number] },
    visualIndex: number
  ) => ({
    pageNum: region.pageNum,
    visualIndex,
    bbox: region.normalizedBbox,
    mimeType: 'image/png',
    pixelWidth: 10,
    pixelHeight: 10,
    data: 'AQID',
  }),
  createCaptioner: () => ({
    caption: async () => 'synthetic caption text',
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
        normalizedBbox: [0, 0, 0.1, 0.1],
        evidence: 'raster',
      })),
})

const rendererFactory = () => ({
  renderPdfRendition: async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
    pixelWidth: 10,
    pixelHeight: 10,
  }),
  createVisualAttachment: (
    region: { pageNum: number; normalizedBbox: [number, number, number, number] },
    visualIndex: number
  ) => ({
    pageNum: region.pageNum,
    visualIndex,
    bbox: region.normalizedBbox,
    mimeType: 'image/png',
    pixelWidth: 10,
    pixelHeight: 10,
    data: 'AQID',
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

// Dynamically imported after vi.resetModules() in beforeAll. This is the
// load-bearing isolation mechanism under vitest's `isolate: false`: a sibling
// test file that vi.mock's the same module paths (e.g., ingest.test.ts mocks
// ../../cli/common.js) can otherwise win the module-registry race and bind
// runIngest's closures to that file's factories instead of this file's.
// Resetting the registry + re-importing here forces this file's factories to
// be the ones the runIngest under test sees.
let runIngest: typeof import('../../cli/ingest.js').runIngest

// ============================================
// Helpers
// ============================================

interface CapturedInsert {
  filePath: string
  chunkIndex: number
  text: string
  vector: number[]
  visualAttachments: string | null
  imageStorageVersion: string
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
      const row = c as Record<string, unknown>
      inserted.push({
        filePath: String(row['filePath']),
        chunkIndex: Number(row['chunkIndex']),
        text: String(row['text']),
        vector: Array.isArray(row['vector']) ? (row['vector'] as number[]) : [],
        visualAttachments:
          typeof row['visualAttachments'] === 'string' ? row['visualAttachments'] : null,
        imageStorageVersion: String(row['imageStorageVersion']),
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
 * Build a synthetic 3-page parsePdfPages result. Page 2 carries an image-block
 * stext entry (so the detector mock would, in a real run, mark it as a
 * candidate). The detector mock here ignores stextJson and uses
 * `captionerSpy.candidatePages` directly, but we still emit a realistic shape
 * for documentation purposes.
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
        bbox: [0, 0, 100, 10] as [number, number, number, number],
        text,
        pageTextStart: 0,
        pageTextEnd: text.length,
      },
    ],
    stextJson: { blocks: [{ type: blockType }] },
  })
  return {
    doc: { destroy: mocks.destroy },
    metadataTitle: undefined,
    pages: [
      page(1, 'page 1 plain text', 'text'),
      page(2, 'page 2 plain text', 'image'),
      page(3, 'page 3 plain text', 'text'),
    ],
  }
}

/**
 * Set up the chunker/embedder mocks so they preserve the inputs in a way the
 * tests can verify. The chunker emits one chunk per non-empty paragraph
 * boundary in the input (split on '\n\n' — same separator the dispatch site
 * uses to join enriched pages), capped at 4 chunks for sanity. The embedder
 * returns a non-empty vector for every chunk.
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
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
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

  it('documents --images as independent from --visual', async () => {
    const { stderr, error } = await captureRun(() => runIngest(['--help']))

    expect((error as Error | undefined)?.message).toBe('process.exit(0)')
    expect(stderr.join('\n')).toContain('--images')
    expect(stderr.join('\n')).toContain('independently from captions')
  })

  it.each([
    { flags: [] as string[], captioned: false, storedImages: false },
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
      expect(
        inserted.every(
          (row) => row.imageStorageVersion === (storedImages ? 'pdf-images-v1' : 'none')
        )
      ).toBe(true)
      expect(inserted.some((row) => row.visualAttachments !== null)).toBe(storedImages)
      expect(captionerSpy.calls.length > 0).toBe(captioned)
    }
  )

  // AC-002: "With visual: true, ingesting a 3-page PDF where page 2 contains
  //         exactly one figure produces ingested chunks whose combined text
  //         contains at least one occurrence of the substring
  //         `[Visual content on page 2: ` followed by caption text and a
  //         closing `]`."
  // ROI: 72 (BV:9 × Freq:8 + Legal:0 + Defect:0) — feature-defining behavior
  // Behavior: visual: true + figure on page 2 → caption substring present in
  //           the chunks inserted into the vector store
  // Verification items:
  //   - At least one inserted chunk.text contains `[Visual content on page 2: `
  //   - The caption text body is recoverable from the combined chunk text
  //   - Pages 1 and 3 produce chunks with no `[Visual content on page` marker
  // @category: core-functionality
  // @lane: integration
  // @dependency: ingestSingleFile, parser (parsePdfPages mocked), chunker, embedder, vectorStore (mocked), pdf-visual (real-shaped mock)
  // @complexity: medium
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

  // AC-004: "When the VLM rejects exactly one page (simulated via a mock that
  //         throws on pageNum === 2), the file ingest completes; the failing
  //         page's text is included without a caption; chunks for other
  //         visual-candidate pages contain `[Visual content on page N: ...]`;
  //         a warn-level log line names the failed page."
  // ROI: 48 (BV:8 × Freq:4 + Legal:0 + Defect:8)
  // Behavior: Per-page failure on page 2 + success on others → ingest completes
  // Verification items:
  //   - No thrown error from ingestSingleFile
  //   - Page 2 text appears in chunks but WITHOUT `[Visual content on page 2:`
  //   - Other candidate pages still carry their `[Visual content on page N:`
  //   - Warn-level log line contains the failed pageNum (asserted via console spy)
  // Note: To exercise multiple candidate pages, set the mock so pages 2 AND 3
  //       are candidates and only page 2 throws.
  // @category: edge-case
  // @lane: integration
  // @dependency: ingestSingleFile, pdf-visual (mock with selective throw)
  // @complexity: medium
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

  // AC-005: "When the VLM throws on every visual-candidate page, the file
  //         ingest completes; chunks for the file contain the text-only
  //         content with no `[Visual content on page` substrings; the file's
  //         chunks are present in the index with text-only content; no error
  //         is propagated to the caller."
  // ROI: 64 (BV:8 × Freq:4 + Legal:0 + Defect:8) — explicit graceful-degradation contract
  // Behavior: Whole-VLM failure → fall back to text-only chunks
  // Verification items:
  //   - No thrown error from ingestSingleFile
  //   - No inserted chunk.text contains `[Visual content on page`
  //   - Chunk count > 0 (the text path still produces chunks)
  //   - ingestSingleFile returns the normal chunk-count value
  // @category: edge-case
  // @lane: integration
  // @dependency: ingestSingleFile, pdf-visual (mock with throwAll=true)
  // @complexity: medium
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

  // AC-006: "Ingesting a .md file with visual: true runs the existing
  //         parseFile() path unchanged and emits no warning. No VLM call is made."
  // ROI: 24 (BV:6 × Freq:4 + Legal:0 + Defect:0)
  // Behavior: visual: true + non-PDF → silent text-only path (no VLM)
  // Verification items:
  //   - captionerSpy.calls.length === 0
  //   - No `[Visual content on page` substring in any chunk
  //   - No warn-level log emitted
  //   - parser.parseFile (NOT parsePdfPages) was the boundary entered
  // @category: edge-case
  // @lane: integration
  // @dependency: ingestSingleFile, parser (parseFile mocked), pdf-visual (real-shaped mock — assert never called)
  // @complexity: low
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
    expect(mocks.parseFile).toHaveBeenCalledWith(filePath)
    expect(mocks.parsePdfPages).toHaveBeenCalledTimes(0)
    expect(mocks.parsePdf).toHaveBeenCalledTimes(0)
  })

  // AC-007: "The VLM-produced caption string passes through chunker.chunkText
  //         without throwing, and the resulting chunks pass through
  //         embedder.embedBatch without throwing. (Verifies the caption is
  //         plain text — no control characters that would break downstream
  //         processing.)"
  // ROI: 35 (BV:7 × Freq:5 + Legal:0 + Defect:0)
  // Behavior: Caption is interleaved into one ordered document, which passes
  //           through one semantic chunking pass and one final-chunk embed batch.
  // Verification items:
  //   - chunker.chunkText receives the ordered body-and-caption document once
  //   - embedder.embedBatch receives all final chunk texts once
  //   - Final inserted chunks include the caption marker AND have non-empty
  //     `vector` arrays
  // @category: integration
  // @lane: integration
  // @dependency: ingestSingleFile; parser, chunker, embedder, vector store, and pdf-visual isolated by shape-checked mocks
  // @complexity: low
  it('AC-007: ordered caption passes through the single chunk and embed pass', async () => {
    // Arrange: same setup as AC-002 — page 2 is the only candidate.
    const filePath = resolve('/tmp/test/ac007.pdf')
    mocks.stat.mockResolvedValue(mockFileStat())

    // Act
    const { inserted, error } = await captureRun(() => runIngest(['--visual', filePath]))

    // Assert: pipeline completed without throwing.
    expect(error).toBeUndefined()
    expect(process.exitCode).toBeUndefined()

    // AC-003 supersedes the old dedicated-caption contract: the caption is
    // present in the one ordered document passed to chunkText.
    expect(mocks.chunkText).toHaveBeenCalledTimes(1)
    const chunkTextArg = mocks.chunkText.mock.calls[0]?.[0] as string
    expect(chunkTextArg).toContain('[Visual content on page 2, visual 0: synthetic caption text]')

    // The final chunk texts, including the atomic caption unit, are embedded
    // in one batch after the single semantic chunking pass.
    expect(mocks.embedBatch).toHaveBeenCalledTimes(1)
    const allEmbedBatchTexts = mocks.embedBatch.mock.calls.flatMap(
      (call) => (call[0] as string[]) ?? []
    )
    expect(
      allEmbedBatchTexts.some((t) =>
        t.includes('[Visual content on page 2, visual 0: synthetic caption text]')
      )
    ).toBe(true)

    // Assert: every inserted chunk has a non-empty vector.
    expect(inserted.length).toBeGreaterThan(0)
    for (const chunk of inserted) {
      expect(chunk.vector.length).toBeGreaterThan(0)
    }
  })
})
