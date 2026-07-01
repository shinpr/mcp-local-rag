import { uploadFile, type UploadFileResult } from '../api/files'

export type UploadItemStatus =
  | 'pending'
  | 'uploading'
  | 'complete'
  | 'skipped'
  | 'failed'

export interface UploadItem {
  key: string
  file: File
  status: UploadItemStatus
  error?: string
  result?: UploadFileResult
}

export interface UploadBatchOptions {
  projectId: number
  concurrency?: number
  maxRetries?: number
  onItemUpdate?: (item: UploadItem) => void
}

export interface UploadBatchSummary {
  complete: number
  skipped: number
  failed: number
  total: number
}

const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

function fileKey(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return TRANSIENT_STATUS_CODES.has(status)
  }
  if (error instanceof TypeError) return true
  return false
}

export function createUploadItems(files: File[]): UploadItem[] {
  return files.map((file) => ({
    key: fileKey(file),
    file,
    status: 'pending',
  }))
}

export async function uploadBatch(
  items: UploadItem[],
  options: UploadBatchOptions,
): Promise<{ items: UploadItem[]; summary: UploadBatchSummary }> {
  const {
    projectId,
    concurrency = 3,
    maxRetries = 3,
    onItemUpdate,
  } = options

  const working = items.map((item) => ({ ...item }))
  const queue = [...working]
  const inFlight: Promise<void>[] = []

  const updateItem = (key: string, patch: Partial<UploadItem>) => {
    const index = working.findIndex((item) => item.key === key)
    if (index === -1) return
    working[index] = { ...working[index]!, ...patch }
    onItemUpdate?.(working[index]!)
  }

  const uploadOne = async (item: UploadItem) => {
    updateItem(item.key, { status: 'uploading', error: undefined })

    let lastError: string | undefined
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await uploadFile(projectId, item.file)
        if (result.duplicate) {
          updateItem(item.key, {
            status: 'skipped',
            result,
            error: result.message,
          })
        } else {
          updateItem(item.key, { status: 'complete', result })
        }
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Upload failed'
        if (!isTransientError(error) || attempt === maxRetries) break
        await sleep(500 * 2 ** (attempt - 1))
      }
    }

    updateItem(item.key, {
      status: 'failed',
      error: lastError ?? 'Upload failed',
    })
  }

  while (queue.length > 0 || inFlight.length > 0) {
    while (queue.length > 0 && inFlight.length < concurrency) {
      const item = queue.shift()!
      const task = uploadOne(item).finally(() => {
        const idx = inFlight.indexOf(task)
        if (idx >= 0) inFlight.splice(idx, 1)
      })
      inFlight.push(task)
    }
    if (inFlight.length > 0) {
      await Promise.race(inFlight)
    }
  }

  const summary: UploadBatchSummary = {
    total: working.length,
    complete: working.filter((item) => item.status === 'complete').length,
    skipped: working.filter((item) => item.status === 'skipped').length,
    failed: working.filter((item) => item.status === 'failed').length,
  }

  return { items: working, summary }
}
