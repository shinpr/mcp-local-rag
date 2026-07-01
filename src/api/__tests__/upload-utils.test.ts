import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getFileType,
  listStoredFilePathCandidates,
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

  it('remaps stale absolute paths from another host to canonical layout', () => {
    const uploadDir = resolve('/data/uploads')
    const dockerPath = '/app/lancedb/uploads/3/abc.docx'
    const resolved = resolveStoredFilePath(dockerPath, uploadDir, {
      projectId: 3,
      storedFilename: 'abc.docx',
    })
    expect(resolved).toBe(resolve('/data/uploads/3/abc.docx'))
  })

  it('keeps absolute file paths under the current upload dir', () => {
    const uploadDir = resolve('/data/uploads')
    const absolutePath = resolve('/data/uploads/1/file.docx')
    expect(
      resolveStoredFilePath(absolutePath, uploadDir, {
        projectId: 1,
        storedFilename: 'file.docx',
      })
    ).toBe(absolutePath)
  })

  it('keeps absolute file paths normalized when fields omitted', () => {
    const uploadDir = resolve('/data/uploads')
    const absolutePath = resolve('/data/uploads/1/file.docx')
    expect(resolveStoredFilePath(absolutePath, uploadDir)).toBe(absolutePath)
  })

  it('prefers legacy flat layout when file exists directly under upload dir', () => {
    const uploadDir = resolve('./tmp/test-flat-uploads')
    mkdirSync(uploadDir, { recursive: true })
    const storedFilename = '234dfcc7-4eb3-47ef-a9e6-edcac0a96f47.docx'
    const flatPath = resolve(uploadDir, storedFilename)
    writeFileSync(flatPath, 'test')

    const resolved = resolveStoredFilePath(flatPath, uploadDir, {
      projectId: 1,
      storedFilename,
    })
    expect(resolved).toBe(flatPath)

    rmSync('./tmp/test-flat-uploads', { recursive: true, force: true })
  })

  it('lists path candidates for vector cleanup', () => {
    const uploadDir = resolve('/data/uploads')
    const dockerPath = '/app/lancedb/uploads/2/old.pdf'
    const candidates = listStoredFilePathCandidates(dockerPath, uploadDir, {
      projectId: 2,
      storedFilename: 'old.pdf',
    })
    expect(candidates).toContain(resolve('/data/uploads/2/old.pdf'))
    expect(candidates).toContain(resolve('/data/uploads/old.pdf'))
    expect(candidates).toContain('/app/lancedb/uploads/2/old.pdf')
  })
})
