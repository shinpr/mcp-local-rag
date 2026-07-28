import JSZip from 'jszip'

export interface DocxFixtureOptions {
  bodyXml: string
  coreTitle?: string | null
  corePropertiesXml?: string
}

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const zipEntryOptions = {
  createFolders: false,
  date: new Date(Date.UTC(1980, 0, 1)),
} as const

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function buildCorePropertiesXml(title: string | null): string {
  const titleElement = title === null ? '' : `<dc:title>${escapeXml(title)}</dc:title>`
  return `${xmlDeclaration}
<cp:coreProperties
  xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  ${titleElement}
</cp:coreProperties>`
}

export async function buildDocxFixture(options: DocxFixtureOptions): Promise<Buffer> {
  const zip = new JSZip()
  const hasCoreProperties =
    options.corePropertiesXml !== undefined || options.coreTitle !== undefined

  zip.file(
    '[Content_Types].xml',
    `${xmlDeclaration}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${
    hasCoreProperties
      ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      : ''
  }
</Types>`,
    zipEntryOptions
  )

  zip.file(
    '_rels/.rels',
    `${xmlDeclaration}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship
    Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
  ${
    hasCoreProperties
      ? `<Relationship
    Id="rId2"
    Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
    Target="docProps/core.xml"/>`
      : ''
  }
</Relationships>`,
    zipEntryOptions
  )

  zip.file(
    'word/document.xml',
    `${xmlDeclaration}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${options.bodyXml}
    <w:sectPr/>
  </w:body>
</w:document>`,
    zipEntryOptions
  )

  if (hasCoreProperties) {
    zip.file(
      'docProps/core.xml',
      options.corePropertiesXml ?? buildCorePropertiesXml(options.coreTitle ?? null),
      zipEntryOptions
    )
  }

  return await zip.generateAsync({ type: 'nodebuffer', platform: 'DOS' })
}

export function paragraphXml(text: string): string {
  return `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`
}

export function headingXml(text: string, bookmarkName?: string): string {
  const bookmark = bookmarkName
    ? `<w:bookmarkStart w:id="0" w:name="${escapeXml(bookmarkName)}"/><w:bookmarkEnd w:id="0"/>`
    : ''
  return `<w:p>
  <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
  ${bookmark}
  <w:r><w:t>${escapeXml(text)}</w:t></w:r>
</w:p>`
}

export function tableXml(rows: readonly (readonly string[])[]): string {
  return `<w:tbl>
  ${rows
    .map(
      (row) => `<w:tr>
    ${row
      .map((cell) => `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`)
      .join('\n')}
  </w:tr>`
    )
    .join('\n')}
</w:tbl>`
}
