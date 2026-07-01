import { describe, expect, it } from 'vitest'
import { resolveApiConfig, resolveMaxUploadSizeBytes } from '../config.js'

describe('resolveMaxUploadSizeBytes', () => {
  it('defaults to 50 MB', () => {
    expect(resolveMaxUploadSizeBytes({})).toBe(50 * 1024 * 1024)
  })

  it('parses MAX_UPLOAD_SIZE_MB from env', () => {
    expect(resolveMaxUploadSizeBytes({ MAX_UPLOAD_SIZE_MB: '100' })).toBe(100 * 1024 * 1024)
  })

  it('rejects invalid values', () => {
    expect(() => resolveMaxUploadSizeBytes({ MAX_UPLOAD_SIZE_MB: '0' })).toThrow(
      /MAX_UPLOAD_SIZE_MB/
    )
    expect(() => resolveMaxUploadSizeBytes({ MAX_UPLOAD_SIZE_MB: '501' })).toThrow(
      /MAX_UPLOAD_SIZE_MB/
    )
  })
})

describe('resolveApiConfig', () => {
  it('includes maxUploadSizeBytes from env', () => {
    const config = resolveApiConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      MAX_UPLOAD_SIZE_MB: '25',
    })
    expect(config.maxUploadSizeBytes).toBe(25 * 1024 * 1024)
  })
})
