import type { Document } from 'mupdf'
import { describe, expect, it } from 'vitest'
import { asDouble } from '../../__tests__/test-doubles.js'
import { sourceContextForRange } from '../../utils/source-context.js'
import { filterPageBoundaryLayouts, type PageData } from '../pdf-filter.js'
import { pdfHeadings } from '../pdf-headings.js'

const body = 'Ordinary body text repeated to establish the dominant document font size. '.repeat(8)
const line = (text: string, y: number, fontSize = 10, fontName = 'Regular') => ({
  text,
  x: 0,
  y,
  fontSize,
  fontName,
  hasEOL: true,
})

describe('PDF heading inference', () => {
  it('finds numbered headings without an outline while rejecting ordinary bold table labels', () => {
    const doc = asDouble<Document>({ loadOutline: () => null })
    const items: PageData['items'] = [
      line('1 Introduction', 100, 12),
      line(body, 80),
      line('Category', 60, 10, 'Bold'),
      { ...line('Vertical watermark', 50, 24), bbox: [0, 0, 20, 200] },
      line('1.1 Details', 40, 10, 'Bold'),
    ]
    const text = items.map((item) => item.text).join('\n')
    expect(pdfHeadings(doc, [{ pageNum: 1, items }], [{ text, textFragments: [] }])[0]).toEqual([
      { offset: 0, level: 1, text: '1 Introduction' },
      { offset: text.indexOf('1.1 Details'), level: 2, text: '1.1 Details' },
    ])
  })

  it('uses the actual numbered heading instead of an earlier mention of its outline title', () => {
    const doc = asDouble<Document>({
      loadOutline: () => [{ title: 'Architecture', page: 0, uri: undefined, open: false }],
    })
    const items: PageData['items'] = [
      line(`Architecture is discussed later. ${body}`, 100),
      line('3', 40, 12),
      { ...line('Architecture', 40, 12), x: 20 },
    ]
    const text = `Architecture is discussed later. ${body}\n3 Architecture`
    const pages: PageData[] = [{ pageNum: 1, items }]
    expect(pdfHeadings(doc, pages, [{ text, textFragments: [] }])[0]).toEqual([
      { offset: text.indexOf('3 Architecture'), level: 1, text: 'Architecture' },
    ])
  })

  it('keeps separate column headings separate when they share a baseline', () => {
    const items: PageData['items'] = [
      { ...line('1 Left Column', 100, 14), blockOrdinal: 0, lineOrdinal: 0 },
      { ...line('2 Right Column', 100, 14), blockOrdinal: 1, lineOrdinal: 0 },
      { ...line(body, 80), blockOrdinal: 2, lineOrdinal: 0 },
    ]
    const text = items.map((item) => item.text).join('\n')

    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => [] }),
        [{ pageNum: 1, items }],
        [{ text, textFragments: [] }]
      )[0]
    ).toEqual([
      { offset: 0, level: 1, text: '1 Left Column' },
      { offset: text.indexOf('2 Right Column'), level: 1, text: '2 Right Column' },
    ])
  })

  it('matches a wrapped full-width outline heading after text normalization', () => {
    const doc = asDouble<Document>({
      loadOutline: () => [{ title: '１.１  目的とスコープ', page: 0, uri: undefined, open: false }],
    })
    const text = '１.１ 目的と\nスコープ\n本文'
    expect(
      pdfHeadings(doc, [{ pageNum: 1, items: [line(body, 80)] }], [{ text, textFragments: [] }])[0]
    ).toEqual([{ offset: 0, level: 1, text: '１.１  目的とスコープ' }])
  })
  it('keeps outline hierarchy without unrelated large text', () => {
    const doc = asDouble<Document>({
      loadOutline: () => [
        {
          title: 'Chapter Two',
          page: 0,
          uri: undefined,
          open: false,
          down: [{ title: 'Details', page: 0, uri: undefined, open: false }],
        },
      ],
    })
    const items = [
      line('Chapter Two', 100, 14),
      line(body, 90),
      line('Large pull quote', 70, 18),
      line('Details', 50, 12),
      line('Following body', 30),
    ]
    const text = items.map((item) => item.text).join('\n')
    const headings =
      pdfHeadings(doc, [{ pageNum: 1, items }], [{ text, textFragments: [] }])[0] ?? []
    expect(headings.map((heading) => ({ text: heading.text, level: heading.level }))).toEqual([
      { text: 'Chapter Two', level: 1 },
      { text: 'Details', level: 2 },
    ])
    expect(
      sourceContextForRange({ headings }, text.indexOf('Following body'), text.length).headingPaths
    ).toEqual([['Chapter Two', 'Details']])
  })

  it.each([
    { outline: [] },
    { outline: [{ title: 'Introduction', page: 0, uri: undefined, open: false }] },
  ])('locates the heading after an earlier body mention with outline %j', ({ outline }) => {
    const items = [line(`See Introduction below. ${body}`, 100), line('Introduction', 70, 14)]
    const text = items.map((item) => item.text).join('\n')
    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => outline }),
        [{ pageNum: 1, items }],
        [{ text, textFragments: [] }]
      )[0]
    ).toEqual([{ offset: text.lastIndexOf('Introduction'), level: 1, text: 'Introduction' }])
  })

  it('uses font inference when no outline entry can be located', () => {
    const items = [line('1 Introduction', 100, 14), line(body, 80)]
    const text = items.map((item) => item.text).join('\n')
    expect(
      pdfHeadings(
        asDouble<Document>({
          loadOutline: () => [{ title: 'Missing', page: 0, uri: undefined, open: false }],
        }),
        [{ pageNum: 1, items }],
        [{ text, textFragments: [] }]
      )[0]
    ).toEqual([{ offset: 0, level: 1, text: '1 Introduction' }])
  })

  it('does not promote body-sized bold numbered steps to headings', () => {
    const items = [
      line('Guide', 100, 14),
      line(body, 80),
      line('1. Install the package', 60, 10, 'Bold'),
    ]
    const text = items.map((item) => item.text).join('\n')
    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => [] }),
        [{ pageNum: 1, items }],
        [{ text, textFragments: [] }]
      )[0]
    ).toEqual([{ offset: 0, level: 1, text: 'Guide' }])
  })
  it.each([
    { title: 'Results', bodyText: 'The results show a difference.', outline: false },
    { title: 'Results', bodyText: 'The results show a difference.', outline: true },
    { title: 'Installation', bodyText: 'Run the installation script.', outline: false },
    { title: 'Installation', bodyText: 'Run the installation script.', outline: true },
  ])(
    'keeps $title when repeated in body (outline=$outline)',
    async ({ title, bodyText, outline }) => {
      const items = [line(title, 100, 14), line(`${bodyText} ${body}`, 80)].map((item, index) => ({
        ...item,
        blockOrdinal: 0,
        lineOrdinal: index,
      }))
      const pages = [{ pageNum: 1, items }]
      const layouts = await filterPageBoundaryLayouts(pages, { embedBatch: async () => [] })
      expect(
        pdfHeadings(
          asDouble<Document>({
            loadOutline: () => (outline ? [{ title, page: 0, uri: undefined, open: false }] : []),
          }),
          pages,
          layouts
        )[0]
      ).toEqual([{ offset: 0, level: 1, text: title }])
    }
  )

  it('uses fragment offsets after filtering has joined lines with spaces', () => {
    const lead = `See Results below. ${body}`
    const section = 'Results The results show a difference.'
    const text = `${lead} ${section}`
    const items = [
      line(lead, 100),
      line('Results', 70, 14),
      line('The results show a difference.', 50),
    ].map((item, index) => ({ ...item, blockOrdinal: 0, lineOrdinal: index }))
    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => [] }),
        [{ pageNum: 1, items }],
        [
          {
            text,
            textFragments: [
              {
                pageNum: 1,
                blockOrdinal: 0,
                lineOrdinal: 1,
                fragmentOrdinal: 0,
                bbox: [0, 0, 100, 20],
                text: section,
                pageTextStart: lead.length + 1,
                pageTextEnd: text.length,
              },
            ],
          },
        ]
      )[0]
    ).toEqual([{ offset: lead.length + 1, level: 1, text: 'Results' }])
  })

  it('omits repeated full lines when no source position can distinguish them', () => {
    const items = [line('Results', 100, 14), line(body, 80), line('Results', 50, 14)]
    const text = items.map((item) => item.text).join('\n')
    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => [] }),
        [{ pageNum: 1, items }],
        [{ text, textFragments: [] }]
      )[0]
    ).toEqual([])
  })

  it('keeps body-sized bold hierarchical numbers while rejecting punctuated step numbers', () => {
    const items = [
      line(body, 100),
      line('2.1 Design Goals', 80, 10, 'Bold'),
      line('1. Install the package', 60, 10, 'Bold'),
      line('1) Configure settings', 40, 10, 'Bold'),
    ]
    const text = items.map((item) => item.text).join('\n')
    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => [] }),
        [{ pageNum: 1, items }],
        [{ text, textFragments: [] }]
      )[0]
    ).toEqual([{ offset: text.indexOf('2.1 Design Goals'), level: 2, text: '2.1 Design Goals' }])
  })
  it('does not relocate a removed heading onto another surviving line', () => {
    const items = [
      { ...line('Results', 100, 14), blockOrdinal: 0, lineOrdinal: 0 },
      { ...line('Results', 80, 10), blockOrdinal: 0, lineOrdinal: 1 },
      { ...line(body, 60), blockOrdinal: 0, lineOrdinal: 2 },
    ]
    const text = `Results\n${body}`
    expect(
      pdfHeadings(
        asDouble<Document>({ loadOutline: () => [] }),
        [{ pageNum: 1, items }],
        [
          {
            text,
            textFragments: [
              {
                pageNum: 1,
                blockOrdinal: 0,
                lineOrdinal: 1,
                fragmentOrdinal: 0,
                bbox: [0, 0, 100, 20],
                text: 'Results',
                pageTextStart: 0,
                pageTextEnd: 7,
              },
            ],
          },
        ]
      )[0]
    ).toEqual([])
  })
})
