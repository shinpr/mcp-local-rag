import * as mupdf from 'mupdf'

/** Build a deterministic text-rich PDF with one large raster image block. */
export function buildPdfWithImageBytes(): Uint8Array {
  const pdf = new mupdf.PDFDocument()
  let pixmap: mupdf.Pixmap | null = null
  try {
    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 200, 150], false)
    pixmap.clear(170)
    const imageObject = pdf.addImage(new mupdf.Image(pixmap.asPNG()))

    const fontObject = pdf.addSimpleFont(new mupdf.Font('Times-Roman'), 'Latin')
    const resources = pdf.newDictionary()
    const fonts = pdf.newDictionary()
    fonts.put('F1', fontObject)
    resources.put('Font', fonts)
    const images = pdf.newDictionary()
    images.put('Im1', imageObject)
    resources.put('XObject', images)

    const contents = [
      'q',
      'BT',
      '/F1 14 Tf',
      '72 780 Td',
      '(PDF Image Persistence Fixture Document) Tj',
      '0 -22 Td',
      '(This synthetic page verifies image attachment storage through real adapters.) Tj',
      '0 -22 Td',
      '(Its body is deliberately long enough for deterministic semantic chunking.) Tj',
      '0 -22 Td',
      '(The large raster region below must be detected and rendered without a VLM.) Tj',
      '0 -22 Td',
      '(A second sentence keeps the text-only replacement path non-empty and stable.) Tj',
      'ET',
      '400 0 0 300 100 350 cm',
      '/Im1 Do',
      'Q',
    ].join('\n')

    const page = pdf.addPage([0, 0, 595, 842], 0, resources, contents)
    pdf.insertPage(-1, page)
    return pdf.saveToBuffer('compress').asUint8Array()
  } finally {
    pixmap?.destroy?.()
    pdf.destroy()
  }
}
