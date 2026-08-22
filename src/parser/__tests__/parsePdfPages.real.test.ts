import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as mupdf from 'mupdf'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildOrderedVisualDocument } from '../../ingest/visual.js'
import { DocumentParser } from '../index.js'
import type { EmbedderInterface } from '../pdf-filter.js'

function buildTwoColumnPdf(): Uint8Array {
  const pdf = new mupdf.PDFDocument()
  try {
    const fontObject = pdf.addSimpleFont(new mupdf.Font('Times-Roman'), 'Latin')
    const resources = pdf.newDictionary()
    const fonts = pdf.newDictionary()
    fonts.put('F1', fontObject)
    resources.put('Font', fonts)
    const contents = [
      'BT /F1 20 Tf 40 760 Td (Representative Two Column Capability Document Spanning Heading) Tj ET',
      'BT /F1 12 Tf 72 700 Td (Left column first line) Tj ET',
      'BT /F1 12 Tf 330 700 Td (Right column first line) Tj ET',
      'BT /F1 12 Tf 72 676 Td (Left column second line) Tj ET',
      'BT /F1 12 Tf 330 676 Td (Right column second line) Tj ET',
      'BT /F1 12 Tf 72 652 Td (Left column third line) Tj ET',
      'BT /F1 12 Tf 330 652 Td (Right column third line) Tj ET',
    ].join('\n')
    const page = pdf.addPage([0, 0, 612, 792], 0, resources, contents)
    pdf.insertPage(-1, page)
    return pdf.saveToBuffer('compress').asUint8Array()
  } finally {
    pdf.destroy()
  }
}

describe('parsePdfPages real MuPDF reading order', () => {
  const testDir = join(process.cwd(), 'tmp', 'test-parse-pdf-pages-real')
  const filePath = join(testDir, 'two-column.pdf')
  const embedder: EmbedderInterface = {
    embedBatch: vi.fn(async () => {
      throw new Error('A single-page fixture must not require boundary embeddings')
    }),
  }

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
    await writeFile(filePath, buildTwoColumnPdf())
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('emits the heading, complete left column, then complete right column', async () => {
    const nativeDocument = mupdf.Document.openDocument(await readFile(filePath), 'application/pdf')
    try {
      const nativePage = nativeDocument.loadPage(0)
      try {
        const structuredText = nativePage.toStructuredText('preserve-whitespace,preserve-images')
        try {
          const raw = JSON.parse(structuredText.asJSON()) as {
            blocks: Array<{ type: string; lines?: Array<{ text: string }> }>
          }
          expect(
            raw.blocks.flatMap((block) =>
              block.type === 'text' ? (block.lines ?? []).map((line) => line.text) : []
            )
          ).toEqual([
            'Representative Two Column Capability Document Spanning Heading',
            'Left column first line',
            'Right column first line',
            'Left column second line',
            'Right column second line',
            'Left column third line',
            'Right column third line',
          ])
        } finally {
          structuredText.destroy?.()
        }
      } finally {
        nativePage.destroy?.()
      }
    } finally {
      nativeDocument.destroy()
    }

    const parser = new DocumentParser({ baseDir: testDir, maxFileSize: 1024 * 1024 })
    const result = await parser.parsePdfPages(filePath, embedder)

    try {
      const expected = [
        'Representative Two Column Capability Document Spanning Heading',
        'Left column first line',
        'Left column second line',
        'Left column third line',
        'Right column first line',
        'Right column second line',
        'Right column third line',
      ]
      expect(result.pages).toHaveLength(1)
      expect(result.pages[0]?.text.split('\n')).toEqual(expected)
      expect(result.pages[0]?.textFragments.map((fragment) => fragment.text)).toEqual(expected)
      const fragments = result.pages[0]?.textFragments ?? []
      expect((fragments[0]?.bbox[2] ?? 0) - (fragments[0]?.bbox[0] ?? 0)).toBeGreaterThan(612 * 0.6)
      expect(fragments.slice(1, 4).every((fragment) => fragment.bbox[0] < 200)).toBe(true)
      expect(fragments.slice(4).every((fragment) => fragment.bbox[0] > 300)).toBe(true)

      const leftFirst = fragments[1]
      const leftSecond = fragments[2]
      expect(leftFirst).toBeDefined()
      expect(leftSecond).toBeDefined()
      if (leftFirst && leftSecond) {
        const regionTop = leftFirst.bbox[3]
        const regionBottom = leftSecond.bbox[1]
        const ordered = buildOrderedVisualDocument(result.pages, [
          {
            pageNum: 1,
            detectionIndex: 0,
            bbox: [leftFirst.bbox[0], regionTop, leftFirst.bbox[2], regionBottom],
            normalizedBbox: [0.1, 0.1, 0.4, 0.2],
            evidence: 'vector',
            caption: 'Between left-column lines',
          },
        ])
        expect(ordered.text.split('\n\n')).toEqual([
          expected[0],
          expected[1],
          '[Visual content on page 1, visual 0: Between left-column lines]',
          expected[2],
          expected[3],
          expected[4],
          expected[5],
          expected[6],
        ])
      }
    } finally {
      result.doc.destroy()
    }
  })
})
