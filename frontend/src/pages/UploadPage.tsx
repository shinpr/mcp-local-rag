import { useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { indexProject } from '../api/files'
import {
  createUploadItems,
  uploadBatch,
  type UploadItem,
  type UploadBatchSummary,
} from '../utils/uploadBatch'
import { formatFileSize } from '../utils/format'
import Button from '../components/Button'
import toast from 'react-hot-toast'

type UploadPhase = 'select' | 'uploading' | 'done'

function statusIcon(status: UploadItem['status']): string {
  switch (status) {
    case 'complete':
      return '✓'
    case 'skipped':
      return '↷'
    case 'failed':
      return '✕'
    case 'uploading':
      return '↑'
    default:
      return '○'
  }
}

function statusColor(status: UploadItem['status']): string {
  switch (status) {
    case 'complete':
      return 'text-emerald-400 bg-emerald-500/20'
    case 'skipped':
      return 'text-amber-400 bg-amber-500/20'
    case 'failed':
      return 'text-red-400 bg-red-500/20'
    case 'uploading':
      return 'text-blue-400 bg-blue-500/20'
    default:
      return 'text-gray-400 bg-gray-800'
  }
}

function statusLabel(status: UploadItem['status']): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'uploading':
      return 'Uploading'
    case 'complete':
      return 'Uploaded'
    case 'skipped':
      return 'Already exists'
    case 'failed':
      return 'Failed'
  }
}

export default function UploadPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id)
  const navigate = useNavigate()

  const [files, setFiles] = useState<File[]>([])
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([])
  const [phase, setPhase] = useState<UploadPhase>('select')
  const [summary, setSummary] = useState<UploadBatchSummary | null>(null)
  const [isStartingIndex, setIsStartingIndex] = useState(false)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files))
      setUploadItems([])
      setSummary(null)
      setPhase('select')
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.files) {
      setFiles(Array.from(e.dataTransfer.files))
      setUploadItems([])
      setSummary(null)
      setPhase('select')
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setUploadItems([])
    setSummary(null)
    setPhase('select')
  }

  const progressCounts = useMemo(() => {
    if (uploadItems.length === 0) {
      return { done: 0, total: files.length, percent: 0 }
    }
    const done = uploadItems.filter(
      (item) =>
        item.status === 'complete' ||
        item.status === 'skipped' ||
        item.status === 'failed',
    ).length
    const total = uploadItems.length
    return {
      done,
      total,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
    }
  }, [uploadItems, files.length])

  const canStartIndexing =
    phase === 'done' && summary !== null && summary.failed === 0 && summary.total > 0

  const handleUpload = async () => {
    if (files.length === 0) return

    const items = createUploadItems(files)
    setUploadItems(items)
    setPhase('uploading')
    setSummary(null)

    const result = await uploadBatch(items, {
      projectId,
      onItemUpdate: (item) => {
        setUploadItems((prev) =>
          prev.map((existing) => (existing.key === item.key ? item : existing)),
        )
      },
    })

    setUploadItems(result.items)
    setSummary(result.summary)
    setPhase('done')
  }

  const handleStartIndexing = async () => {
    setIsStartingIndex(true)
    try {
      await indexProject(projectId)
      navigate(`/projects/${projectId}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to start indexing',
      )
      setIsStartingIndex(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          onClick={() => navigate(`/projects/${projectId}`)}
          className="text-gray-400 hover:text-white mb-2 inline-flex items-center gap-1"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back to project
        </button>
        <h1 className="text-2xl font-bold text-white">Upload Files</h1>
        <p className="text-gray-400 mt-1">
          Upload documents to index for RAG search. Original files are kept on
          disk for re-download and updates.
        </p>
      </div>

      {phase === 'select' && (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="bg-gray-900 border-2 border-dashed border-gray-700 rounded-xl p-12 text-center hover:border-emerald-500/50 transition-colors"
        >
          <div className="text-5xl mb-4">📁</div>
          <h3 className="text-lg font-semibold text-white mb-2">
            Drop files here
          </h3>
          <p className="text-sm text-gray-400 mb-4">or click to browse files</p>
          <label className="inline-flex items-center px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 cursor-pointer transition-colors">
            Browse Files
            <input
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
              accept=".pdf,.md,.txt,.html,.docx,.json"
            />
          </label>
          <p className="text-xs text-gray-500 mt-3">
            Supports PDF, Markdown, Text, HTML, DOCX, and JSON files
          </p>
        </div>
      )}

      {files.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl">
          <div className="p-4 border-b border-gray-800 flex items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold text-white">
                {phase === 'done' ? 'Upload Results' : 'Selected Files'} (
                {files.length})
              </h3>
              {phase !== 'select' && (
                <p className="text-sm text-gray-400 mt-1">
                  {progressCounts.done}/{progressCounts.total} processed
                </p>
              )}
            </div>
            {phase === 'uploading' && (
              <span className="text-sm text-blue-400">Uploading batch…</span>
            )}
          </div>

          {phase !== 'select' && (
            <div className="px-4 pt-4">
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${progressCounts.percent}%` }}
                />
              </div>
              {summary && (
                <div className="flex flex-wrap gap-4 mt-3 text-sm">
                  <span className="text-emerald-400">
                    {summary.complete} uploaded
                  </span>
                  {summary.skipped > 0 && (
                    <span className="text-amber-400">
                      {summary.skipped} already existed
                    </span>
                  )}
                  {summary.failed > 0 && (
                    <span className="text-red-400">{summary.failed} failed</span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
            {(uploadItems.length > 0 ? uploadItems : createUploadItems(files)).map(
              (item, index) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between p-4 gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={`w-8 h-8 rounded flex items-center justify-center text-sm flex-shrink-0 ${statusColor(item.status)}`}
                    >
                      {item.status === 'uploading' ? (
                        <span className="animate-pulse">↑</span>
                      ) : (
                        statusIcon(item.status)
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {item.file.name}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatFileSize(item.file.size)}
                        {phase !== 'select' && (
                          <>
                            {' '}
                            · {statusLabel(item.status)}
                          </>
                        )}
                      </p>
                      {item.error && item.status === 'failed' && (
                        <p className="text-xs text-red-400 mt-1 truncate">
                          {item.error}
                        </p>
                      )}
                      {item.status === 'skipped' && item.error && (
                        <p className="text-xs text-amber-400 mt-1 truncate">
                          {item.error}
                        </p>
                      )}
                    </div>
                  </div>
                  {phase === 'select' && (
                    <button
                      onClick={() => removeFile(index)}
                      className="p-1 text-gray-500 hover:text-red-400 rounded flex-shrink-0"
                      title={`Remove ${item.file.name}`}
                      aria-label={`Remove ${item.file.name}`}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              ),
            )}
          </div>

          <div className="p-4 border-t border-gray-800 flex flex-col sm:flex-row justify-end gap-3">
            {phase === 'select' && (
              <>
                <button
                  onClick={() => navigate(`/projects/${projectId}`)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <Button onClick={handleUpload} disabled={files.length === 0}>
                  Upload {files.length} file(s)
                </Button>
              </>
            )}

            {phase === 'uploading' && (
              <Button disabled isLoading>
                Uploading {progressCounts.done}/{progressCounts.total}…
              </Button>
            )}

            {phase === 'done' && !canStartIndexing && (
              <>
                <button
                  onClick={() => {
                    setPhase('select')
                    setFiles([])
                    setUploadItems([])
                    setSummary(null)
                  }}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
                >
                  Upload more
                </button>
                <Link
                  to={`/projects/${projectId}`}
                  className="px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors text-center"
                >
                  Back to project
                </Link>
              </>
            )}
          </div>
        </div>
      )}

      {canStartIndexing && (
        <div className="rounded-xl border-2 border-emerald-500 bg-emerald-500/10 p-6 shadow-lg shadow-emerald-500/10">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-emerald-300">
                All files ready — start indexing
              </h3>
              <p className="text-sm text-emerald-100/80 mt-1">
                {summary!.complete} new file(s) uploaded
                {summary!.skipped > 0
                  ? `, ${summary!.skipped} already in project`
                  : ''}
                . Index them to make content searchable.
              </p>
            </div>
            <div className="flex gap-3">
              <Link
                to={`/projects/${projectId}`}
                state={{ highlightIndex: true }}
                className="px-4 py-2 text-sm text-emerald-200 hover:text-white hover:bg-emerald-500/20 rounded-lg transition-colors text-center"
              >
                Review files
              </Link>
              <Button
                size="lg"
                onClick={handleStartIndexing}
                isLoading={isStartingIndex}
                className="ring-2 ring-emerald-400 ring-offset-2 ring-offset-gray-950 animate-pulse"
              >
                Start indexing
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'done' && summary && summary.failed > 0 && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">
            {summary.failed} file(s) failed to upload. Fix the errors above and
            retry failed files, or return to the project to index the successful
            uploads.
          </p>
        </div>
      )}
    </div>
  )
}
