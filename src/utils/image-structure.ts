export const BOUNDED_IMAGE_MAX_BYTES = 512 * 1024

type BoundedImageMimeType = 'image/png' | 'image/jpeg'

interface ImageDimensions {
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52] as const
const PNG_IDAT = [0x49, 0x44, 0x41, 0x54] as const
const PNG_IEND = [0x49, 0x45, 0x4e, 0x44] as const
const PNG_VALID_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

function matchesBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function isPngChunkType(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index] as number
    if (!((value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a))) return false
  }
  return true
}

function parsePng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 8 || !matchesBytes(bytes, 0, PNG_SIGNATURE)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let dimensions: ImageDimensions | null = null
  let chunkIndex = 0
  let idatState: 'none' | 'active' | 'ended' = 'none'

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12 || !isPngChunkType(bytes, offset + 4)) return null
    const dataLength = view.getUint32(offset)
    if (dataLength > bytes.byteLength - offset - 12) return null
    const chunkEnd = offset + 12 + dataLength
    const isIhdr = matchesBytes(bytes, offset + 4, PNG_IHDR)
    const isIdat = matchesBytes(bytes, offset + 4, PNG_IDAT)
    const isIend = matchesBytes(bytes, offset + 4, PNG_IEND)

    if (chunkIndex === 0) {
      if (!isIhdr || dataLength !== 13) return null
      const width = view.getUint32(offset + 8)
      const height = view.getUint32(offset + 12)
      const bitDepth = bytes[offset + 16] as number
      const colorType = bytes[offset + 17] as number
      const compressionMethod = bytes[offset + 18] as number
      const filterMethod = bytes[offset + 19] as number
      const interlaceMethod = bytes[offset + 20] as number
      if (
        width === 0 ||
        height === 0 ||
        PNG_VALID_BIT_DEPTHS[colorType]?.includes(bitDepth) !== true ||
        compressionMethod !== 0 ||
        filterMethod !== 0 ||
        (interlaceMethod !== 0 && interlaceMethod !== 1)
      ) {
        return null
      }
      dimensions = { width, height }
    } else if (isIhdr) {
      return null
    }

    if (isIdat) {
      if (dataLength === 0 || idatState === 'ended') return null
      idatState = 'active'
    } else if (idatState === 'active') {
      idatState = 'ended'
    }

    if (isIend) {
      return dataLength === 0 &&
        dimensions !== null &&
        idatState !== 'none' &&
        chunkEnd === bytes.length
        ? dimensions
        : null
    }

    offset = chunkEnd
    chunkIndex += 1
  }
  return null
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  )
}

function parseJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  let dimensions: ImageDimensions | null = null
  let inScan = false
  let sawSos = false
  let scanHasData = false

  while (offset < bytes.byteLength) {
    let markerFromScan = false
    if (inScan) {
      let foundMarker = false
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          scanHasData = true
          offset += 1
          continue
        }
        const markerOffset = offset
        while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
        if (offset >= bytes.byteLength) return null
        const scanMarker = bytes[offset] as number
        if (scanMarker === 0x00) {
          scanHasData = true
          offset += 1
          continue
        }
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset += 1
          continue
        }
        if (!scanHasData) return null
        offset = markerOffset
        markerFromScan = true
        foundMarker = true
        inScan = false
        break
      }
      if (!foundMarker) return null
    }

    if (bytes[offset] !== 0xff) return null
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) return null
    const marker = bytes[offset] as number
    offset += 1

    if (marker === 0xd9) {
      return dimensions !== null && sawSos && scanHasData && offset === bytes.byteLength
        ? dimensions
        : null
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return null
    if (marker === 0x01) {
      inScan = markerFromScan
      continue
    }
    if (offset + 1 >= bytes.byteLength) return null
    const segmentLength = readUint16(bytes, offset)
    if (segmentLength < 2 || segmentLength > bytes.byteLength - offset) return null
    const segmentEnd = offset + segmentLength

    if (isStartOfFrame(marker)) {
      if (dimensions !== null || segmentLength < 11) return null
      const precision = bytes[offset + 2] as number
      const height = readUint16(bytes, offset + 3)
      const width = readUint16(bytes, offset + 5)
      const componentCount = bytes[offset + 7] as number
      if (
        precision === 0 ||
        precision > 16 ||
        width === 0 ||
        height === 0 ||
        componentCount === 0 ||
        segmentLength !== 8 + componentCount * 3
      ) {
        return null
      }
      dimensions = { width, height }
    } else if (marker === 0xda) {
      if (dimensions === null || segmentLength < 8) return null
      const componentCount = bytes[offset + 2] as number
      if (componentCount === 0 || segmentLength !== 6 + componentCount * 2) return null
      sawSos = true
      scanHasData = false
      inScan = true
    } else if (marker === 0xdc) {
      if (segmentLength !== 4) return null
      inScan = markerFromScan
    }

    offset = segmentEnd
  }
  return null
}

export function parseBoundedImageStructure(
  bytes: Uint8Array,
  mimeType: BoundedImageMimeType
): ImageDimensions | null {
  if (bytes.byteLength === 0 || bytes.byteLength > BOUNDED_IMAGE_MAX_BYTES) return null
  return mimeType === 'image/png' ? parsePng(bytes) : parseJpeg(bytes)
}
