import * as mupdf from 'mupdf'

type Layout = 'single-column' | 'two-column'

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function textBlock(text: readonly string[], size: number, x: number, y: number): string {
  const commands = [`/F1 ${size} Tf`, `${x} ${y} Td`]
  for (const [index, line] of text.entries()) {
    if (index > 0) {
      commands.push('0 -16 Td')
    }
    commands.push(`(${escapePdfText(line)}) Tj`)
  }
  return ['BT', ...commands, 'ET'].join('\n')
}

/** Build a real MuPDF-readable PDF whose body blocks are emitted left column first. */
export function buildPdfReadingOrderFixture(
  options: { pageCount?: number; layout?: Layout; repeatedBoundaries?: boolean } = {}
): Uint8Array {
  const pageCount = options.pageCount ?? 3
  const layout = options.layout ?? 'two-column'
  const repeatedBoundaries = options.repeatedBoundaries ?? true
  const pdf = new mupdf.PDFDocument()
  try {
    const fontObject = pdf.addSimpleFont(new mupdf.Font('Times-Roman'), 'Latin')
    const resources = pdf.newDictionary()
    const fonts = pdf.newDictionary()
    fonts.put('F1', fontObject)
    resources.put('Font', fonts)

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const pageNum = pageIndex + 1
      const contents: string[] = []
      if (repeatedBoundaries) {
        contents.push(textBlock(['Shared Reading Order Header'], 8, 72, 766))
      }
      contents.push(textBlock([`Section ${pageNum} Reading Order`], 16, 72, 710))
      if (layout === 'two-column') {
        contents.push(
          textBlock(
            [
              `Left page ${pageNum} begins with a wrapped statement that`,
              'continues in the same native block to its complete ending.',
            ],
            12,
            72,
            650
          )
        )
        contents.push(
          textBlock(
            [
              `Right page ${pageNum} begins with a separate wrapped statement that`,
              'continues in the right native block to its complete ending.',
            ],
            12,
            330,
            650
          )
        )
      } else {
        contents.push(
          textBlock(
            [
              'Single-column reading stays in stream order with a wrapped clause',
              'continued in the following visual line to its complete ending.',
            ],
            12,
            72,
            650
          )
        )
      }
      if (repeatedBoundaries) {
        contents.push(textBlock([`Printed Page ${pageNum} of ${pageCount}`], 8, 72, 34))
      }

      const page = pdf.addPage([0, 0, 612, 792], 0, resources, contents.join('\n'))
      pdf.insertPage(-1, page)
    }

    return pdf.saveToBuffer('compress').asUint8Array()
  } finally {
    pdf.destroy()
  }
}
