import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getFileType,
  resolveStoredFilePath,
  SUPPORTED_EXTENSIONS,
  sanitizeFilename,
} from '../upload-utils.js'

describe('upload-utils', () => {
  it('accepts supported extensions', () => {
    expect(getFileType('report.docx')).toBe('docx')
    expect(getFileType('notes.MD')).toBe('md')
    expect(getFileType('page.html')).toBe('html')
    expect(SUPPORTED_EXTENSIONS.has('json')).toBe(true)
  })

  it('rejects unsupported extensions', () => {
    expect(getFileType('archive.zip')).toBeNull()
  })

  it('sanitizes unsafe filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('file<script>.docx')).toBe('file_script_.docx')
  })

  it('resolves legacy relative file paths via canonical layout', () => {
    const uploadDir = resolve('/data/uploads')
    const legacyPath = 'lancedb/uploads/234dfcc7-4eb3-47ef-a9e6-edcac0a96f47.docx'
    const resolved = resolveStoredFilePath(legacyPath, uploadDir, {
      projectId: 1,
      storedFilename: '234dfcc7-4eb3-47ef-a9e6-edcac0a96f47.docx',
    })
    expect(resolved).toBe(resolve('/data/uploads/1/234dfcc7-4eb3-47ef-a9e6-edcac0a96f47.docx'))
  })

  it('resolves legacy relative file paths via cwd when fields omitted', () => {
    const uploadDir = resolve('/data/uploads')
    const legacyPath = 'lancedb/uploads/234dfcc7-4eb3-47ef-a9e6-edcac0a96f47.docx'
    const resolved = resolveStoredFilePath(legacyPath, uploadDir)
    expect(resolved).toBe(resolve(process.cwd(), legacyPath))
  })

  it('keeps absolute file paths normalized', () => {
    const uploadDir = resolve('/data/uploads')
    const absolutePath = resolve('/data/uploads/1/file.docx')
    expect(resolveStoredFilePath(absolutePath, uploadDir)).toBe(absolutePath)
  })
})
