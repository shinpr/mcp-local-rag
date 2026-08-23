import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDocxFixture,
  headingXml,
  paragraphXml,
  tableXml,
} from '../../__tests__/docx-fixture.js'
import { convertDocxDocumentToText } from '../docx-parser.js'
import { DocumentParser } from '../index.js'

function convertDocxHtmlToText(html: string) {
  return convertDocxDocumentToText(new JSDOM(html).window.document)
}

describe('DOCX parser', () => {
  const testDir = join(process.cwd(), 'tmp', 'test-docx-parser')
  let parser: DocumentParser

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    parser = new DocumentParser({
      baseDir: testDir,
      maxFileSize: 100 * 1024 * 1024,
    })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  async function parseFixture(
    fileName: string,
    fixture: Buffer,
    options?: Parameters<DocumentParser['parseFile']>[1]
  ) {
    const filePath = join(testDir, fileName)
    await writeFile(filePath, fixture)
    return await parser.parseFile(filePath, options)
  }

  it('keeps image anchors at their text position without adding searchable marker text', () => {
    expect(
      convertDocxHtmlToText('<p>Before<img data-rag-image-index="0" src="ignored"> after</p>')
    ).toEqual({
      content: 'Before after',
      atomicRanges: [],
      imageAnchors: [{ offset: 'Before'.length, imageIndex: 0 }],
    })
  })

  it('preserves text that matches the former image marker beside a real image', () => {
    const literalMarker = '\uE000rag-image:0\uE001'
    const beforeImage = `Visible ${literalMarker} before`

    expect(
      convertDocxHtmlToText(
        `<p>${beforeImage}<img data-rag-image-index="1" src="ignored"> after</p>`
      )
    ).toEqual({
      content: `${beforeImage} after`,
      atomicRanges: [],
      imageAnchors: [{ offset: beforeImage.length, imageIndex: 1 }],
    })
  })

  it('does not duplicate an image used in a serialized table header', () => {
    const result = convertDocxHtmlToText(
      '<table><tr><td><img data-rag-image-index="0"></td></tr><tr><td>First</td></tr><tr><td>Second</td></tr></table>'
    )

    expect(result.imageAnchors).toEqual([{ offset: 0, imageIndex: 0 }])
  })

  it('captures Mammoth img output only when image storage is enabled', async () => {
    const fixture = await readFile(
      join(process.cwd(), 'node_modules', 'mammoth', 'test', 'test-data', 'tiny-picture.docx')
    )

    const plain = await parseFixture('plain.docx', fixture)
    const withImages = await parseFixture('with-images.docx', fixture, { images: true })

    expect(withImages.content).toBe(plain.content)
    expect(plain.imageAnchors).toBeUndefined()
    expect(withImages.imageAnchors).toEqual([
      expect.objectContaining({ offset: 0, imageIndex: 0, mimeType: 'image/png' }),
    ])
  })

  it('does not read external DOCX image references', async () => {
    const fixture = await readFile(
      join(process.cwd(), 'node_modules', 'mammoth', 'test', 'test-data', 'external-picture.docx')
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await parseFixture('external-picture.docx', fixture, { images: true })

    expect(result.imageAnchors).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('only embedded PNG and JPEG are supported')
    )
    warning.mockRestore()
  })

  it('uses a fixed valid ZIP timestamp independently of wall-clock time', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'))
      const firstPromise = buildDocxFixture({
        coreTitle: 'Stable title',
        bodyXml: paragraphXml('Stable body'),
      })
      await vi.runAllTimersAsync()
      const first = await firstPromise
      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
      const secondPromise = buildDocxFixture({
        coreTitle: 'Stable title',
        bodyXml: paragraphXml('Stable body'),
      })
      await vi.runAllTimersAsync()
      const second = await secondPromise

      expect(second).toEqual(first)
      const archive = await JSZip.loadAsync(first)
      expect(archive.file('word/document.xml')?.date.toISOString()).toBe('1980-01-01T00:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers a normalized core title over the first heading', async () => {
    const fixture = await buildDocxFixture({
      coreTitle: '  Research & Development  ',
      bodyXml: `${headingXml('Heading Fallback')}${paragraphXml('Body text.')}`,
    })

    const result = await parseFixture('metadata-title.docx', fixture)

    expect(result.title).toBe('Research & Development')
    expect(result.content).toContain('Heading Fallback')
  })

  it('reads a differently prefixed core title through the public JSZip API', async () => {
    const fixture = await buildDocxFixture({
      corePropertiesXml:
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:meta="http://purl.org/dc/elements/1.1/"><meta:title>Research &amp; Development</meta:title></cp:coreProperties>',
      bodyXml: headingXml('Heading Fallback'),
    })
    const zip = await JSZip.loadAsync(fixture)
    const coreProperties = zip.file('docProps/core.xml')

    expect(await coreProperties?.async('string')).toContain('<meta:title>')
    await expect(parseFixture('prefixed-title.docx', fixture)).resolves.toMatchObject({
      title: 'Research & Development',
    })
  })

  it('falls through an empty core title to the first non-empty heading', async () => {
    const fixture = await buildDocxFixture({
      coreTitle: '   ',
      bodyXml: headingXml('Heading Title'),
    })

    await expect(parseFixture('empty-core-title.docx', fixture)).resolves.toMatchObject({
      title: 'Heading Title',
    })
  })

  it('falls through malformed core properties to plain heading text', async () => {
    const fixture = await buildDocxFixture({
      corePropertiesXml:
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title>',
      bodyXml: `${headingXml('Bookmark Title', '_Toc123')}${paragraphXml('Body text.')}`,
    })

    const result = await parseFixture('heading-title.docx', fixture)

    expect(result.title).toBe('Bookmark Title')
    expect(result.title).not.toContain('<')
  })

  it('falls back to the normalized filename when metadata and h1 are unavailable', async () => {
    const fixture = await buildDocxFixture({
      bodyXml: paragraphXml('Body without a heading.'),
    })

    const result = await parseFixture('fallback-title.docx', fixture)

    expect(result.title).toBe('fallback title')
    expect(result.content).toBe('Body without a heading.')
    expect(result.atomicRanges).toBeUndefined()
  })

  it('serializes an ordinary all-td table row and records one exact atomic range', async () => {
    const rowText = [
      'Field No.: 42',
      'Field Name: Retry Policy Identifier',
      'Required: Optional',
      'Type: Integer(11)',
      'Description: First sentence. Second sentence.',
    ].join('\n')
    const fixture = await buildDocxFixture({
      bodyXml: `${paragraphXml('Before table.')}${tableXml([
        ['Field No.', 'Field Name', 'Required', 'Type', 'Description'],
        [
          '42',
          'Retry Policy Identifier',
          'Optional',
          'Integer(11)',
          'First sentence. Second sentence.',
        ],
      ])}${paragraphXml('After table.')}`,
    })

    const result = await parseFixture('table-row.docx', fixture)

    expect(result.content).toBe(`Before table.\n\n${rowText}\n\nAfter table.`)
    expect(result.atomicRanges).toEqual([
      {
        start: 'Before table.\n\n'.length,
        end: 'Before table.\n\n'.length + rowText.length,
      },
    ])
    expect(
      result.atomicRanges?.map((range) => result.content.slice(range.start, range.end))
    ).toEqual([rowText])
  })

  it('preserves paragraph and line-break boundaries inside a real DOCX table cell', async () => {
    const rowText = 'Header: First Second Before After'
    const fixture = await buildDocxFixture({
      coreTitle: 'Cell boundary fixture',
      bodyXml: `<w:tbl>
  <w:tr>
    <w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc>
  </w:tr>
  <w:tr>
    <w:tc>
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
      <w:p><w:r><w:t>Before</w:t><w:br/><w:t>After</w:t></w:r></w:p>
    </w:tc>
  </w:tr>
</w:tbl>`,
    })

    const result = await parseFixture('cell-boundaries.docx', fixture)

    expect(result.content).toBe(rowText)
    expect(result.atomicRanges).toEqual([{ start: 0, end: rowText.length }])
  })

  it('preserves list-item boundaries inside supported table cells', () => {
    const rowText = 'Header: First Second Third'

    expect(
      convertDocxHtmlToText(
        '<table><tr><td>Header</td></tr><tr><td><ul><li>First</li><li>Second<ul><li>Third</li></ul></li></ul></td></tr></table>'
      )
    ).toEqual({
      content: rowText,
      atomicRanges: [{ start: 0, end: rowText.length }],
    })
  })

  it('uses the exact document-order traversal contract for mixed HTML', () => {
    const html = [
      '<h1>Title <a id="bookmark"></a>&amp; More</h1>',
      '<p>Alpha<br>Beta <strong>bold</strong>.</p>',
      '<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>',
      '<table><tr><td>H</td></tr><tr><td>V</td></tr></table>',
      '<table><tr><td>Outer<table><tr><td>Inner</td></tr></table></td></tr></table>',
      '<p>Tail</p>',
    ].join('')
    const expectedContent = [
      'Title & More',
      'Alpha\nBeta bold.',
      'One\nTwo\nNested',
      'H: V',
      'Outer Inner',
      'Tail',
    ].join('\n\n')
    const rowStart = expectedContent.indexOf('H: V')

    expect(convertDocxHtmlToText(html)).toEqual({
      content: expectedContent,
      atomicRanges: [{ start: rowStart, end: rowStart + 'H: V'.length }],
    })
  })

  it('omits skipped descendants from a container fallback block', () => {
    expect(
      convertDocxHtmlToText(
        '<div>Visible<script>hidden()</script><span> tail</span><style>.hidden { color: red; }</style></div>'
      )
    ).toEqual({
      content: 'Visible tail',
      atomicRanges: [],
    })
  })

  it('supports th headers while preserving empty headers and values', () => {
    const row = 'Column 1: \nName: Value'

    expect(
      convertDocxHtmlToText(
        '<table><tr><th></th><th>Name</th></tr><tr><td></td><td>Value</td></tr></table>'
      )
    ).toEqual({
      content: row,
      atomicRanges: [{ start: 0, end: row.length }],
    })
  })

  it('keeps repeated rows as separate ordered ranges', () => {
    const row = 'Code: 42'
    const result = convertDocxHtmlToText(
      '<table><tr><th>Code</th></tr><tr><td>42</td></tr><tr><td>42</td></tr></table>'
    )
    const secondStart = row.length + 2

    expect(result).toEqual({
      content: `${row}\n\n${row}`,
      atomicRanges: [
        { start: 0, end: row.length },
        { start: secondStart, end: secondStart + row.length },
      ],
    })
  })

  it('preserves unsupported merged-table text once without atomic ranges', () => {
    expect(
      convertDocxHtmlToText(
        '<p>Before</p><table><tr><td colspan="2">Merged</td></tr><tr><td>A</td><td>B</td></tr></table><p>After</p>'
      )
    ).toEqual({
      content: 'Before\n\nMerged A B\n\nAfter',
      atomicRanges: [],
    })
  })

  it('preserves unsupported uneven-table text without header associations', () => {
    expect(
      convertDocxHtmlToText(
        '<table><tr><td>Header A</td><td>Header B</td></tr><tr><td>Only one value</td></tr></table>'
      )
    ).toEqual({
      content: 'Header A Header B Only one value',
      atomicRanges: [],
    })
  })
})
