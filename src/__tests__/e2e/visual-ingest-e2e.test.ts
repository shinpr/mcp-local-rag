// VLM PDF Enrichment - Service-Integration E2E Test (CI-gated)
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers (cross-process / cross-service correctness):
//   - End-to-end stdio JSON-RPC wiring of the MCP server's `ingest_file` tool
//     with `visual: true`
//   - Real LanceDB persistence of visual-enriched chunks against a temp BASE_DIR
//   - Real VLM model load through the captioner code path (model is assumed
//     pre-cached — see header note below)
// Lane: service-integration-e2e
// Budget Used: 1/2 service-integration-e2e (reserved slot)
//
// IMPORTANT (pre-condition for RUN_E2E=1):
//   This test assumes `CACHE_DIR` already contains the chosen `dtype` variant
//   of the production default VLM (`HuggingFaceTB/SmolVLM-256M-Instruct` at
//   `q4`). The first-time download is a separate one-time setup step outside
//   the test run. Running without a pre-cached model will either time out or
//   attempt a network download; the suite is intentionally CI-gated so the
//   default `pnpm test` never triggers this.
//
// Test Type: End-to-end against a running local stack (mcp-local-rag binary
//            spawned via stdio + real LanceDB + real production-default VLM).
//            No HTTP service exists in this product — the "service" here is
//            the MCP server itself, exercised through real JSON-RPC over stdio.
//
// Implementation Timing: FINAL phase only. Skipped unless `RUN_E2E=1`. The
// CI gate is checked at file-evaluation time so the suite is completely
// absent in default runs.
//
// vi.hoisted note: NOT used in this file. This E2E spawns a real child
// process and uses real LanceDB + real @huggingface/transformers — no module
// mocks. The isolate: false vitest config (vitest.config.mjs:16-18) still
// applies but is not load-bearing here because there are no vi.mock calls.
//
// CI gate:
//   describe.skipIf(process.env['RUN_E2E'] !== '1')(...)
// also lives in package.json as a dedicated `test:e2e` script so the
// default `pnpm test` never pulls the VLM model. No workflow sets RUN_E2E=1
// either, so this runs nowhere automatically — on purpose (see ci.yml).

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import zlib from 'node:zlib'

import { connect as lancedbConnect } from '@lancedb/lancedb'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as mupdf from 'mupdf'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// ============================================
// CI Gate
// ============================================

const E2E_ENABLED = process.env['RUN_E2E'] === '1'

// ============================================
// Constants
// ============================================

// Resolve relative to the current working directory (vitest is launched from
// project root). Mirrors the path style used by `rag-workflow.e2e.test.ts`.
const BINARY_PATH = resolve('./dist/index.js')
/** Pre-cached model lives under `./models/` per the project default. */
const DEFAULT_CACHE_DIR = resolve('./models')
const LANCEDB_TABLE_NAME = 'chunks'
const VISUAL_CONTENT_MARKER = '[Visual content on page '

// Hook + test timeouts: model load on first VLM call can take several minutes
// even from a warm cache. 10 minutes is the documented ceiling per the task.
const E2E_TIMEOUT_MS = 10 * 60 * 1000

// ============================================
// Helpers
// ============================================

/**
 * Build a `Record<string, string>` env for `StdioClientTransport`. The SDK type
 * rejects `undefined` values, so we filter them out and only pass the keys we
 * actually want to set.
 */
function buildChildEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value
  }
  return env
}

/**
 * Synthesize a minimal PNG (gradient + dark rectangle). Pure stdlib (zlib only)
 * so the fixture builder has zero non-mupdf runtime dependencies. Pattern
 * mirrors `tmp/probe/probe-stext-blocks.mjs::buildPng`.
 */
function buildPng(width: number, height: number): Uint8Array {
  function crc32(buf: Uint8Array): number {
    const table = new Array<number>(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      const idx = (crc ^ (buf[i] ?? 0)) & 0xff
      crc = ((table[idx] ?? 0) ^ (crc >>> 8)) >>> 0
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeBuf = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
    return Buffer.concat([len, typeBuf, data, crcBuf])
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // color type RGB
  const rowLen = 1 + width * 3
  const raw = Buffer.alloc(height * rowLen)
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0
    for (let x = 0; x < width; x++) {
      raw[y * rowLen + 1 + x * 3 + 0] = Math.floor((x / width) * 255)
      raw[y * rowLen + 1 + x * 3 + 1] = Math.floor((y / height) * 255)
      raw[y * rowLen + 1 + x * 3 + 2] = 128
    }
  }
  const idat = zlib.deflateSync(raw)
  return new Uint8Array(
    Buffer.concat([
      signature,
      chunk('IHDR', ihdrData),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}

/**
 * Build a single-page PDF that satisfies BOTH test cases:
 *   - Substantial body text (well above the chunker's `minChunkLength=50`
 *     filter, with multiple sentences so the semantic chunker emits ≥1 chunk
 *     in the text-only fallback path).
 *   - An embedded raster image so `detectVisualCandidates` flags the page as
 *     a visual candidate (DD §pdf-visual/detector.ts — binary rule on
 *     `block.type === 'image'`), exercising the captioner code path.
 *
 * Pattern + content-stream operators mirror `tmp/probe/probe-stext-blocks.mjs`.
 * Text strings contain only ASCII letters, digits, spaces, periods and commas
 * — no PDF-literal escape characters required.
 */
function buildFixturePdfBytes(): Uint8Array {
  const pdfDoc = new mupdf.PDFDocument()
  try {
    const pngBytes = buildPng(200, 150)
    const image = new mupdf.Image(pngBytes)
    const imageObj = pdfDoc.addImage(image)

    const font = new mupdf.Font('Times-Roman')
    const fontObj = pdfDoc.addSimpleFont(font, 'Latin')

    // PDF mediabox: 595x842 (A4 in points).
    const mediabox: [number, number, number, number] = [0, 0, 595, 842]

    // Each `Tj` line below contributes ~50-80 characters of plain text. Total
    // body text is ~350 characters — far above `minChunkLength=50` and large
    // enough that even after sentence splitting the chunker emits ≥1 chunk.
    // Newlines between PDF operators are required by the PDF content-stream
    // grammar; `Td` advances the text matrix between visual lines.
    const contents = [
      'q',
      'BT',
      '/F1 14 Tf',
      '72 780 Td',
      '(Visual Ingest End to End Fixture Document) Tj',
      '0 -22 Td',
      '(This synthetic page exists to exercise the visual ingest path) Tj',
      '0 -22 Td',
      '(through a real Mupdf parse and a real LanceDB persistence step.) Tj',
      '0 -22 Td',
      '(The document body is intentionally long enough that the semantic) Tj',
      '0 -22 Td',
      '(chunker emits at least one chunk even when the visual captioner) Tj',
      '0 -22 Td',
      '(fails and the page text alone must satisfy the minimum length.) Tj',
      '0 -22 Td',
      '(Figure 1 below is a colored gradient block recognized as an image.) Tj',
      'ET',
      // Image: cm matrix scales the unit-square image into a 400x300 box.
      '400 0 0 300 100 350 cm',
      '/Im1 Do',
      'Q',
    ].join('\n')

    const resources = pdfDoc.newDictionary()
    const fontDict = pdfDoc.newDictionary()
    fontDict.put('F1', fontObj)
    resources.put('Font', fontDict)
    const xobjDict = pdfDoc.newDictionary()
    xobjDict.put('Im1', imageObj)
    resources.put('XObject', xobjDict)

    const pageObj = pdfDoc.addPage(mediabox, 0, resources, contents)
    pdfDoc.insertPage(-1, pageObj)
    return pdfDoc.saveToBuffer('compress').asUint8Array()
  } finally {
    pdfDoc.destroy()
  }
}

/** Resolve text content from a `tools/call` response shape. */
function extractTextContent(result: unknown): string {
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content: unknown }).content
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0]
      if (first && typeof first === 'object' && 'text' in first) {
        const text = (first as { text: unknown }).text
        if (typeof text === 'string') return text
      }
    }
  }
  throw new Error(`Unexpected tools/call response shape: ${JSON.stringify(result)}`)
}

// ============================================
// Tests
// ============================================

describe.skipIf(!E2E_ENABLED)('VLM PDF Enrichment - service-integration-e2e (RUN_E2E=1)', () => {
  const testBaseDir = resolve('./tmp/e2e-visual-base')
  const testDbPath = resolve('./tmp/e2e-visual-db')
  const testCacheDir = DEFAULT_CACHE_DIR // share the pre-cached model
  const fixturePdf = resolve(testBaseDir, 'figure-bearing.pdf')

  beforeAll(() => {
    // Pre-condition: the compiled binary must exist (built via `pnpm build`).
    if (!existsSync(BINARY_PATH)) {
      throw new Error(
        `E2E pre-condition failed: ${BINARY_PATH} does not exist. Run \`pnpm build\` before \`RUN_E2E=1 pnpm test:e2e\`.`
      )
    }

    // Fresh temp dirs each suite run; testCacheDir is shared and never wiped.
    rmSync(testBaseDir, { recursive: true, force: true })
    rmSync(testDbPath, { recursive: true, force: true })
    mkdirSync(testBaseDir, { recursive: true })
    mkdirSync(testDbPath, { recursive: true })
    // Synthesize the fixture in-memory and write it to BASE_DIR. This makes
    // the suite portable across clean checkouts — no dependency on the
    // gitignored `tmp/probe/probe-results/figure.pdf` produced by the Phase-1
    // probe. The fixture is figure-bearing AND text-rich so it satisfies both
    // the primary case (visual marker present) and the fallback case
    // (text-only chunks above `minChunkLength=50`).
    writeFileSync(fixturePdf, buildFixturePdfBytes())
  }, E2E_TIMEOUT_MS)

  afterAll(() => {
    rmSync(testBaseDir, { recursive: true, force: true })
    rmSync(testDbPath, { recursive: true, force: true })
    // Keep `testCacheDir` to preserve the pre-cached model across runs.
    if (process.env['RUN_E2E_KEEP_CACHE'] !== '1' && testCacheDir !== DEFAULT_CACHE_DIR) {
      rmSync(testCacheDir, { recursive: true, force: true })
    }
  })

  // User Journey (CLI-flavored multi-step, service-internal correctness):
  //   1. Spawn `node dist/index.js` (the published binary entry) with
  //      BASE_DIR, DB_PATH, CACHE_DIR pointing at temp dirs and stdio piped
  //      so the test can drive JSON-RPC.
  //   2. MCP initialize handshake (handled by `client.connect`).
  //   3. Call tools/call for `ingest_file` with { filePath, visual: true }.
  //   4. Read back the response — assert chunkCount > 0.
  //   5. Open the real LanceDB at `testDbPath` and assert at least one row
  //      contains the substring `[Visual content on page `.
  //   6. `client.close()` cleanly terminates the child via the transport.
  //
  // ROI: 51 (BV:8 × Freq:5 + Legal:0 + Defect:9) — reserved slot for
  //      cross-process + real-DB correctness; the in-process AC-002 test
  //      cannot prove the published binary wires the visual path end-to-end.
  // @category: service-integration-e2e
  // @lane: service-integration-e2e
  // @dependency: full-system (mcp-local-rag binary via stdio, real LanceDB, real production-default VLM)
  // @complexity: high
  it(
    'User Journey: spawn mcp-local-rag via stdio, call ingest_file with visual: true, real LanceDB persists [Visual content on page ...] chunk',
    async () => {
      // Arrange — connect a real MCP client to the spawned binary. VLM model
      // identifier is not user-tunable (no env override); the server resolves
      // the production default VLM internally.
      const transport = new StdioClientTransport({
        command: process.execPath, // node
        args: [BINARY_PATH],
        env: buildChildEnv({
          BASE_DIR: testBaseDir,
          DB_PATH: testDbPath,
          CACHE_DIR: testCacheDir,
          MODEL_NAME: 'Xenova/all-MiniLM-L6-v2',
        }),
        stderr: 'inherit',
      })
      const client = new Client({ name: 'visual-ingest-e2e', version: '0.0.0' })

      try {
        await client.connect(transport)

        // Act — call ingest_file with visual: true on the real PDF
        const callResult = await client.callTool({
          name: 'ingest_file',
          arguments: { filePath: fixturePdf, visual: true },
        })

        // Assert — response shape: { chunkCount: number, filePath: string }
        const responseJson = JSON.parse(extractTextContent(callResult)) as {
          chunkCount: number
          filePath: string
        }
        expect(responseJson.chunkCount).toBeGreaterThan(0)
        expect(responseJson.filePath).toBe(fixturePdf)

        // Assert — real LanceDB row inspection: at least one row's `text`
        // contains the visual-content marker. The MCP server has the table
        // open at this point, but LanceDB connections are file-system based
        // and tolerate concurrent readers.
        const db = await lancedbConnect(testDbPath)
        const table = await db.openTable(LANCEDB_TABLE_NAME)
        // chunkCount > 0 was asserted above, so we cap the read at a small
        // number to keep the assertion cheap.
        const rows = (await table.query().limit(1000).toArray()) as Array<{ text: string }>
        const hasVisualChunk = rows.some(
          (row) => typeof row.text === 'string' && row.text.includes(VISUAL_CONTENT_MARKER)
        )
        expect(hasVisualChunk).toBe(true)
      } finally {
        // Clean teardown of the spawned child via the transport
        await client.close().catch(() => {
          /* best-effort */
        })
      }
    },
    E2E_TIMEOUT_MS
  )
})
