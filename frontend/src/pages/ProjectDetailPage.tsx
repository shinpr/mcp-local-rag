import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getProject } from '../api/projects'
import {
  getProjectFiles,
  deleteFile,
  indexProject,
  getJobStatus,
} from '../api/files'
import type { ProjectDetailResponse, FileResponse } from '../types/api'
import { formatFileSize, formatDate } from '../utils/format'
import StatusBadge from '../components/StatusBadge'
import Modal from '../components/Modal'
import toast from 'react-hot-toast'

const FILE_TYPE_ICONS: Record<string, string> = {
  pdf: '📕',
  docx: '📘',
  doc: '📘',
  txt: '📄',
  md: '📝',
}

function getFileIcon(fileType: string): string {
  return FILE_TYPE_ICONS[fileType] ?? '📃'
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id)

  const [project, setProject] = useState<ProjectDetailResponse | null>(null)
  const [files, setFiles] = useState<FileResponse[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isIndexing, setIsIndexing] = useState(false)
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean
    fileId: number | null
    fileName: string
  }>({ isOpen: false, fileId: null, fileName: '' })

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

  const handleIndex = async () => {
    setIsIndexing(true)
    try {
      const result = await indexProject(projectId)
      toast.success(`Indexing started: ${result.filesQueued} files queued`)

      // Poll job status
      const pollInterval = setInterval(async () => {
        try {
          const job = await getJobStatus(result.jobId)
          if (job.status === 'completed' || job.status === 'failed') {
            clearInterval(pollInterval)
            setIsIndexing(false)
            fetchData()
            if (job.status === 'completed') {
              toast.success('Indexing completed!')
            } else {
              toast.error(`Indexing failed: ${job.errorMessage}`)
            }
          }
        } catch {
          clearInterval(pollInterval)
          setIsIndexing(false)
        }
      }, 2000)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to start indexing',
      )
      setIsIndexing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
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
  const indexedFiles = files.filter((f) => f.indexingStatus === 'indexed')
  const failedFiles = files.filter((f) => f.indexingStatus === 'failed')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Link
              to="/projects"
              className="text-gray-400 hover:text-white"
            >
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
        <div className="flex gap-3">
          <Link
            to={`/projects/${projectId}/upload`}
            className="px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded-lg hover:bg-gray-600 transition-colors"
          >
            Upload Files
          </Link>
          <button
            onClick={handleIndex}
            disabled={isIndexing || pendingFiles.length === 0}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isIndexing ? 'Indexing...' : `Index ${pendingFiles.length} files`}
          </button>
        </div>
      </div>

      {/* Stats */}
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
            {project.stats.chunkCount}
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
          <p className={`mt-2 text-3xl font-bold ${failedFiles.length > 0 ? 'text-red-400' : 'text-white'}`}>
            {failedFiles.length}
          </p>
        </div>
      </div>

      {/* Files List */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl">
        <div className="p-6 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">Files</h2>
        </div>

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
            {files.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between p-4 hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-center gap-4 flex-1 min-w-0">
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
                    {file.indexingStatus === 'failed' && (file as any).errorMessage && (
                      <p className="text-xs text-red-400 mt-1 truncate">
                        {(file as any).errorMessage}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                  <StatusBadge status={file.indexingStatus} />
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
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, fileId: null, fileName: '' })}
        title="Delete File"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-white">{deleteModal.fileName}</span>?
            This will also remove all indexed vectors for this file.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteModal({ isOpen: false, fileId: null, fileName: '' })}
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
