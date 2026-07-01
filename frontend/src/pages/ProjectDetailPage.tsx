import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { getProject } from '../api/projects'
import {
  getProjectFiles,
  deleteFile,
  indexProject,
  reindexFile,
  reindexProject,
  getJobStatus,
  replaceFile,
  downloadFile,
} from '../api/files'
import type { ProjectDetailResponse, FileResponse } from '../types/api'
import { formatFileSize } from '../utils/format'
import StatusBadge from '../components/StatusBadge'
import Modal from '../components/Modal'
import Button from '../components/Button'
import toast from 'react-hot-toast'

const FILE_TYPE_ICONS: Record<string, string> = {
  pdf: '📕',
  docx: '📘',
  doc: '📘',
  txt: '📄',
  md: '📝',
  html: '🌐',
  json: '📋',
}

function getFileIcon(fileType: string): string {
  return FILE_TYPE_ICONS[fileType] ?? '📃'
}

function isFileSelectable(file: FileResponse, isIndexing: boolean): boolean {
  return !(file.indexingStatus === 'indexing' && isIndexing)
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id)
  const location = useLocation()
  const highlightIndex =
    (location.state as { highlightIndex?: boolean } | null)?.highlightIndex ??
    false

  const [project, setProject] = useState<ProjectDetailResponse | null>(null)
  const [files, setFiles] = useState<FileResponse[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexingJob, setIndexingJob] = useState<{
    jobId: number
    filesQueued: number
    filesProcessed: number
  } | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [replacingFileId, setReplacingFileId] = useState<number | null>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const [replaceTarget, setReplaceTarget] = useState<FileResponse | null>(null)
  const [reindexModal, setReindexModal] = useState<{
    isOpen: boolean
    fileId: number | null
    fileName: string
    afterReplace?: boolean
  }>({ isOpen: false, fileId: null, fileName: '' })
  const [reindexAllModal, setReindexAllModal] = useState(false)
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean
    fileId: number | null
    fileName: string
  }>({ isOpen: false, fileId: null, fileName: '' })
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)

  const fetchData = useCallback(async () => {
    try {
      const [projectData, filesData] = await Promise.all([
        getProject(projectId),
        getProjectFiles(projectId),
      ])
      setProject(projectData)
      setFiles(filesData)
    } catch {
      toast.error('Failed to load project')
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    setSelectedFileIds((prev) => {
      const validIds = new Set(files.map((f) => f.id))
      const next = new Set([...prev].filter((id) => validIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [files])

  useEffect(() => {
    if (!isIndexing) return
    setSelectedFileIds((prev) => {
      const next = new Set(
        [...prev].filter((id) => {
          const file = files.find((f) => f.id === id)
          return file ? isFileSelectable(file, isIndexing) : false
        }),
      )
      return next.size === prev.size ? prev : next
    })
  }, [isIndexing, files])

  const handleDeleteFile = async () => {
    if (!deleteModal.fileId) return

    try {
      await deleteFile(deleteModal.fileId)
      toast.success('File deleted')
      setDeleteModal({ isOpen: false, fileId: null, fileName: '' })
      fetchData()
    } catch {
      toast.error('Failed to delete file')
    }
  }

  const openDeleteModal = (fileId: number, fileName: string) => {
    setDeleteModal({ isOpen: true, fileId, fileName })
  }

  const refreshLiveData = useCallback(async () => {
    const [projectData, filesData] = await Promise.all([
      getProject(projectId),
      getProjectFiles(projectId),
    ])
    setProject(projectData)
    setFiles(filesData)
  }, [projectId])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const pollJob = useCallback(
    (jobId: number, filesQueued: number) => {
      stopPolling()
      setIndexingJob({ jobId, filesQueued, filesProcessed: 0 })

      const poll = async () => {
        try {
          const job = await getJobStatus(jobId)
          setIndexingJob({
            jobId,
            filesQueued,
            filesProcessed: job.filesProcessed ?? 0,
          })
          await refreshLiveData()

          if (job.status === 'completed' || job.status === 'failed') {
            stopPolling()
            setIsIndexing(false)
            setIndexingJob(null)
            if (job.status === 'completed') {
              toast.success('Indexing completed!')
            } else {
              toast.error(`Indexing failed: ${job.errorMessage}`)
            }
          }
        } catch {
          stopPolling()
          setIsIndexing(false)
          setIndexingJob(null)
        }
      }

      void poll()
      pollIntervalRef.current = setInterval(poll, 2000)
    },
    [refreshLiveData, stopPolling],
  )

  const startIndexingJob = useCallback(
    async (
      startJob: () => Promise<{ jobId: number; filesQueued: number }>,
      successMessage: string,
    ) => {
      setIsIndexing(true)
      try {
        const result = await startJob()
        toast.success(`${successMessage}: ${result.filesQueued} file(s) queued`)
        pollJob(result.jobId, result.filesQueued)
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Failed to start indexing',
        )
        setIsIndexing(false)
      }
    },
    [pollJob],
  )

  const handleIndex = async (fileIds?: number[]) => {
    await startIndexingJob(
      () => indexProject(projectId, fileIds),
      'Indexing started',
    )
  }

  const handleRetryFailed = async (fileIds?: number[]) => {
    const ids =
      fileIds ??
      files
        .filter(
          (f) => f.indexingStatus === 'failed' || f.indexingStatus === 'indexing',
        )
        .map((f) => f.id)
    if (ids.length === 0) return

    await startIndexingJob(
      () => indexProject(projectId, ids),
      'Retry started',
    )
  }

  const handleRetryStuck = async (fileIds?: number[]) => {
    const ids =
      fileIds ??
      files.filter((f) => f.indexingStatus === 'indexing').map((f) => f.id)
    if (ids.length === 0) return

    await startIndexingJob(
      () => indexProject(projectId, ids),
      'Retry started',
    )
  }

  const handleReindexFile = async (fileId: number) => {
    await startIndexingJob(
      () => reindexFile(fileId),
      'Reindex started',
    )
  }

  const handleReindexAll = async () => {
    setReindexAllModal(false)
    await startIndexingJob(
      () => reindexProject(projectId),
      'Reindex started',
    )
  }

  const clearSelection = () => setSelectedFileIds(new Set())

  const toggleFileSelection = (fileId: number) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const handleDownload = async (file: FileResponse) => {
    try {
      await downloadFile(file.id, file.originalFilename)
    } catch {
      toast.error('Failed to download file')
    }
  }

  const openReplacePicker = (file: FileResponse) => {
    setReplaceTarget(file)
    replaceInputRef.current?.click()
  }

  const handleReplaceSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFile = e.target.files?.[0]
    e.target.value = ''
    if (!newFile || !replaceTarget) return

    const target = replaceTarget
    setReplacingFileId(target.id)
    const toastId = toast.loading(`Replacing "${target.originalFilename}"…`)
    try {
      await replaceFile(target.id, newFile)
      toast.success(`"${newFile.name}" replaced successfully`, { id: toastId })
      setReplaceTarget(null)
      await fetchData()
      setReindexModal({
        isOpen: true,
        fileId: target.id,
        fileName: newFile.name,
        afterReplace: true,
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to replace file',
        { id: toastId },
      )
    } finally {
      setReplacingFileId(null)
    }
  }

  const handleReindexAfterReplace = async () => {
    if (!reindexModal.fileId) return

    const fileId = reindexModal.fileId
    setReindexModal({ isOpen: false, fileId: null, fileName: '' })
    await handleIndex([fileId])
  }

  const selectableFiles = useMemo(
    () => files.filter((f) => isFileSelectable(f, isIndexing)),
    [files, isIndexing],
  )
  const selectedFiles = useMemo(
    () => files.filter((f) => selectedFileIds.has(f.id)),
    [files, selectedFileIds],
  )
  const selectedPending = selectedFiles.filter((f) => f.indexingStatus === 'pending')
  const selectedIndexed = selectedFiles.filter((f) => f.indexingStatus === 'indexed')
  const selectedRetryable = selectedFiles.filter(
    (f) =>
      f.indexingStatus === 'failed' ||
      (f.indexingStatus === 'indexing' && !isIndexing),
  )
  const allSelectableSelected =
    selectableFiles.length > 0 &&
    selectableFiles.every((f) => selectedFileIds.has(f.id))
  const someSelectableSelected = selectableFiles.some((f) =>
    selectedFileIds.has(f.id),
  )

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someSelectableSelected && !allSelectableSelected
    }
  }, [someSelectableSelected, allSelectableSelected])

  const handleSelectAll = () => {
    if (allSelectableSelected) {
      clearSelection()
      return
    }
    setSelectedFileIds(new Set(selectableFiles.map((f) => f.id)))
  }

  const handleIndexSelected = async () => {
    const ids = selectedPending.map((f) => f.id)
    if (ids.length === 0) return
    clearSelection()
    await handleIndex(ids)
  }

  const handleReindexSelected = async () => {
    const ids = selectedIndexed.map((f) => f.id)
    if (ids.length === 0) return
    clearSelection()
    await startIndexingJob(
      () => reindexProject(projectId, ids),
      'Reindex started',
    )
  }

  const handleRetrySelected = async () => {
    const ids = selectedRetryable.map((f) => f.id)
    if (ids.length === 0) return
    clearSelection()
    await startIndexingJob(
      () => indexProject(projectId, ids),
      'Retry started',
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-400">Project not found</p>
        <Link
          to="/projects"
          className="text-emerald-400 hover:text-emerald-300 mt-2 inline-block"
        >
          Back to projects
        </Link>
      </div>
    )
  }

  const pendingFiles = files.filter((f) => f.indexingStatus === 'pending')
  const indexingFiles = files.filter((f) => f.indexingStatus === 'indexing')
  const stuckFiles = files.filter(
    (f) => f.indexingStatus === 'indexing' && !isIndexing,
  )
  const indexedFiles = files.filter((f) => f.indexingStatus === 'indexed')
  const failedFiles = files.filter((f) => f.indexingStatus === 'failed')
  const hasPendingFiles = pendingFiles.length > 0
  const hasFailedFiles = failedFiles.length > 0
  const hasStuckFiles = stuckFiles.length > 0
  const hasIndexedFiles = indexedFiles.length > 0
  const showReindexAll =
    files.length > 0 &&
    (hasIndexedFiles || hasStuckFiles || hasFailedFiles) &&
    !isIndexing
  const canReindexAll = files.length > 0 && !isIndexing
  const indexingProgress = indexingJob
    ? Math.min(indexingJob.filesProcessed, indexingJob.filesQueued)
    : 0

  return (
    <div className="space-y-6">
      <input
        ref={replaceInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.md,.txt,.html,.docx,.json"
        aria-label="Replace document file"
        onChange={handleReplaceSelected}
      />

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/projects" className="text-gray-400 hover:text-white">
              <svg
                className="w-5 h-5"
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
            </Link>
            <h1 className="text-2xl font-bold text-white">{project.name}</h1>
          </div>
          {project.description && (
            <p className="text-gray-400 mt-2 ml-8">{project.description}</p>
          )}
        </div>
        <div className="flex gap-3 flex-shrink-0 flex-wrap justify-end">
          <Link
            to={`/projects/${projectId}/upload`}
            className="px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded-lg hover:bg-gray-600 transition-colors"
          >
            Upload Files
          </Link>
          {hasFailedFiles && (
            <Button
              onClick={() => handleRetryFailed()}
              disabled={isIndexing}
              className="bg-red-600 hover:bg-red-700"
            >
              {isIndexing ? 'Indexing...' : `Retry failed (${failedFiles.length})`}
            </Button>
          )}
          {hasStuckFiles && (
            <Button
              onClick={() => handleRetryStuck()}
              disabled={isIndexing}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isIndexing ? 'Indexing...' : `Retry stuck (${stuckFiles.length})`}
            </Button>
          )}
          {showReindexAll && (
            <Button
              onClick={() => setReindexAllModal(true)}
              disabled={isIndexing || !canReindexAll}
              variant="secondary"
            >
              Reindex all
            </Button>
          )}
          <Button
            onClick={() => handleIndex()}
            disabled={isIndexing || !hasPendingFiles}
            className={
              hasPendingFiles && !isIndexing && highlightIndex
                ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-gray-950 animate-pulse'
                : hasPendingFiles && !isIndexing
                  ? 'ring-2 ring-emerald-400 ring-offset-2 ring-offset-gray-950'
                  : undefined
            }
          >
            {isIndexing ? 'Indexing...' : `Start indexing (${pendingFiles.length})`}
          </Button>
        </div>
      </div>

      {isIndexing && indexingJob && (
        <div className="rounded-xl border border-blue-500/50 bg-blue-500/10 px-4 py-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-sm text-blue-200">
              Indexing {indexingProgress} of {indexingJob.filesQueued} file
              {indexingJob.filesQueued === 1 ? '' : 's'}
              {indexingFiles.length > 0 && (
                <span className="text-blue-300/80">
                  {' '}
                  · {indexingFiles[0]?.originalFilename ?? 'processing'}
                </span>
              )}
            </p>
            <p className="text-xs text-blue-300/70">
              {indexedFiles.length} ready · {failedFiles.length} failed
            </p>
          </div>
          <div className="mt-3 h-1.5 rounded-full bg-blue-950/60 overflow-hidden">
            <div
              className="h-full bg-blue-400 transition-all duration-500 ease-out"
              style={{
                width: `${indexingJob.filesQueued > 0 ? (indexingProgress / indexingJob.filesQueued) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {hasStuckFiles && !isIndexing && (
        <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-amber-200">
            {stuckFiles.length} file(s) appear stuck in indexing. Retry to
            re-process them.
          </p>
          <Button
            size="sm"
            onClick={() => handleRetryStuck()}
            className="bg-amber-600 hover:bg-amber-700"
          >
            Retry stuck ({stuckFiles.length})
          </Button>
        </div>
      )}

      {hasFailedFiles && !isIndexing && (
        <div className="rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-red-200">
            {failedFiles.length} file(s) failed to index. Review the errors below
            and retry when ready.
          </p>
          <Button
            size="sm"
            onClick={() => handleRetryFailed()}
            className="bg-red-600 hover:bg-red-700"
          >
            Retry failed ({failedFiles.length})
          </Button>
        </div>
      )}

      {hasPendingFiles && !isIndexing && (
        <div
          className={`rounded-xl border px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
            highlightIndex
              ? 'border-2 border-emerald-500 bg-emerald-500/10 shadow-lg shadow-emerald-500/10'
              : 'border-emerald-500/50 bg-emerald-500/10'
          }`}
        >
          <p className="text-sm text-emerald-200">
            {pendingFiles.length} file(s) uploaded and waiting to be indexed.
          </p>
          <Button size="sm" onClick={() => handleIndex()}>
            Start indexing now
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Total Files</p>
          <p className="mt-2 text-3xl font-bold text-white">
            {project.stats.documentCount}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Total Chunks</p>
          <p className="mt-2 text-3xl font-bold text-white">
            {files.reduce((sum, f) => sum + f.chunkCount, 0)}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Ready</p>
          <p className="mt-2 text-3xl font-bold text-emerald-400">
            {indexedFiles.length}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm font-medium text-gray-400">Failed</p>
          <p
            className={`mt-2 text-3xl font-bold ${failedFiles.length > 0 ? 'text-red-400' : 'text-white'}`}
          >
            {failedFiles.length}
          </p>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl">
        <div className="p-6 border-b border-gray-800 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Files</h2>
            <p className="text-sm text-gray-400 mt-1">
              Download originals, replace a document to update content, or delete
              to remove chunks and files.
            </p>
          </div>
          {files.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer flex-shrink-0 select-none">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelectableSelected}
                onChange={handleSelectAll}
                disabled={selectableFiles.length === 0}
                className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-emerald-600 focus:ring-emerald-500 focus:ring-offset-gray-900 disabled:opacity-40"
              />
              Select all
            </label>
          )}
        </div>

        {selectedFileIds.size > 0 && (
          <div className="px-6 py-3 border-b border-gray-800 bg-emerald-500/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-emerald-200">
              {selectedFileIds.size} file{selectedFileIds.size === 1 ? '' : 's'}{' '}
              selected
            </p>
            <div className="flex flex-wrap gap-2">
              {selectedPending.length > 0 && (
                <Button
                  size="sm"
                  onClick={handleIndexSelected}
                  disabled={isIndexing}
                >
                  Index selected ({selectedPending.length})
                </Button>
              )}
              {selectedIndexed.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleReindexSelected}
                  disabled={isIndexing}
                >
                  Reindex selected ({selectedIndexed.length})
                </Button>
              )}
              {selectedRetryable.length > 0 && (
                <Button
                  size="sm"
                  onClick={handleRetrySelected}
                  disabled={isIndexing}
                  className="bg-red-600 hover:bg-red-700"
                >
                  Retry selected ({selectedRetryable.length})
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Clear selection
              </Button>
            </div>
          </div>
        )}

        {files.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-5xl mb-4">📄</div>
            <h3 className="text-lg font-semibold text-white mb-2">
              No files uploaded
            </h3>
            <p className="text-sm text-gray-400 mb-4">
              Upload documents to start indexing
            </p>
            <Link
              to={`/projects/${projectId}/upload`}
              className="inline-flex items-center px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
            >
              Upload Files
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {files.map((file) => {
              const selectable = isFileSelectable(file, isIndexing)
              return (
              <div
                key={file.id}
                className={`flex items-center justify-between p-4 hover:bg-gray-800/50 transition-colors gap-4 ${
                  selectedFileIds.has(file.id) ? 'bg-emerald-500/5' : ''
                }`}
              >
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={selectedFileIds.has(file.id)}
                    onChange={() => toggleFileSelection(file.id)}
                    disabled={!selectable}
                    aria-label={`Select ${file.originalFilename}`}
                    className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-emerald-600 focus:ring-emerald-500 focus:ring-offset-gray-900 disabled:opacity-40 flex-shrink-0"
                  />
                  <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center text-lg flex-shrink-0">
                    {getFileIcon(file.fileType)}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-white truncate">
                      {file.originalFilename}
                    </p>
                    <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
                      <span>{file.fileType.toUpperCase()}</span>
                      <span>·</span>
                      <span>{formatFileSize(file.fileSize)}</span>
                      {file.chunkCount > 0 && (
                        <>
                          <span>·</span>
                          <span>{file.chunkCount} chunks</span>
                        </>
                      )}
                    </div>
                    {file.indexingStatus === 'failed' && file.errorMessage && (
                      <p className="text-xs text-red-400 mt-1 truncate">
                        {file.errorMessage}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={file.indexingStatus} />
                  <button
                    onClick={() => handleDownload(file)}
                    className="p-2 text-gray-500 hover:text-emerald-400 rounded-lg hover:bg-gray-800 transition-colors"
                    title="Download original"
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
                        d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"
                      />
                    </svg>
                  </button>
                  {file.indexingStatus !== 'indexing' && (
                    <button
                      onClick={() => openReplacePicker(file)}
                      disabled={replacingFileId === file.id}
                      className="p-2 text-gray-500 hover:text-amber-400 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
                      title="Replace document (clears old chunks, re-index after)"
                      aria-label={`Replace ${file.originalFilename}`}
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
                          d="M4 4v6h6M20 20v-6h-6M5 19a9 9 0 0114-7.5M19 5A9 9 0 015 12.5"
                        />
                      </svg>
                    </button>
                  )}
                  {file.indexingStatus === 'pending' && (
                    <button
                      onClick={() => handleIndex([file.id])}
                      disabled={isIndexing}
                      className="px-2 py-1 text-xs text-emerald-400 hover:text-emerald-300 hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                    >
                      Index
                    </button>
                  )}
                  {file.indexingStatus === 'failed' && (
                    <button
                      onClick={() => handleRetryFailed([file.id])}
                      disabled={isIndexing}
                      className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                    >
                      Retry
                    </button>
                  )}
                  {file.indexingStatus === 'indexing' && !isIndexing && (
                    <button
                      onClick={() => handleRetryStuck([file.id])}
                      disabled={isIndexing}
                      className="px-2 py-1 text-xs text-amber-400 hover:text-amber-300 hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                    >
                      Retry
                    </button>
                  )}
                  {file.indexingStatus === 'indexed' && (
                    <button
                      onClick={() => handleReindexFile(file.id)}
                      disabled={isIndexing}
                      className="px-2 py-1 text-xs text-amber-400 hover:text-amber-300 hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
                    >
                      Reindex
                    </button>
                  )}
                  <button
                    onClick={() => openDeleteModal(file.id, file.originalFilename)}
                    className="p-2 text-gray-500 hover:text-red-400 rounded-lg hover:bg-gray-800 transition-colors"
                    title="Delete file"
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
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            )})}
          </div>
        )}
      </div>

      <Modal
        isOpen={reindexAllModal}
        onClose={() => setReindexAllModal(false)}
        title="Reindex all files?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            This will clear existing search chunks and re-process every file in
            this project.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setReindexAllModal(false)}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <Button onClick={handleReindexAll} disabled={isIndexing}>
              Reindex all
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={reindexModal.isOpen}
        onClose={() =>
          setReindexModal({ isOpen: false, fileId: null, fileName: '' })
        }
        title="Re-index document?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            <span className="font-semibold text-white">
              {reindexModal.fileName}
            </span>{' '}
            {reindexModal.afterReplace
              ? 'was replaced. Old search chunks were cleared. Start indexing now to make the new content searchable?'
              : 'will be reindexed. Existing search chunks will be replaced.'}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() =>
                setReindexModal({ isOpen: false, fileId: null, fileName: '' })
              }
              className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            >
              Later
            </button>
            <Button onClick={handleReindexAfterReplace} disabled={isIndexing}>
              Re-index now
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={deleteModal.isOpen}
        onClose={() =>
          setDeleteModal({ isOpen: false, fileId: null, fileName: '' })
        }
        title="Delete File"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-white">
              {deleteModal.fileName}
            </span>
            ? This removes the stored original and all indexed vectors for this
            document.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() =>
                setDeleteModal({ isOpen: false, fileId: null, fileName: '' })
              }
              className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteFile}
              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
