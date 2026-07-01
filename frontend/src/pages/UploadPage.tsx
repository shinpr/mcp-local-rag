import { useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { uploadFile } from '../api/files'
import toast from 'react-hot-toast'

export default function UploadPage() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id)
  const navigate = useNavigate()

  const [files, setFiles] = useState<File[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<Record<string, boolean>>(
    {},
  )

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files))
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.files) {
      setFiles(Array.from(e.dataTransfer.files))
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (files.length === 0) return

    setIsUploading(true)
    const newProgress: Record<string, boolean> = {}
    files.forEach((f) => (newProgress[f.name] = false))
    setUploadProgress(newProgress)

    let successCount = 0
    let failCount = 0

    for (const file of files) {
      try {
        await uploadFile(projectId, file)
        setUploadProgress((prev) => ({ ...prev, [file.name]: true }))
        successCount++
      } catch (error) {
        failCount++
        toast.error(`Failed to upload ${file.name}`)
      }
    }

    setIsUploading(false)

    if (successCount > 0) {
      toast.success(`${successCount} file(s) uploaded successfully`)
    }

    if (failCount === 0) {
      navigate(`/projects/${projectId}`)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
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
          Upload documents to index for RAG search
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        className="bg-gray-900 border-2 border-dashed border-gray-700 rounded-xl p-12 text-center hover:border-emerald-500/50 transition-colors"
      >
        <div className="text-5xl mb-4">📁</div>
        <h3 className="text-lg font-semibold text-white mb-2">
          Drop files here
        </h3>
        <p className="text-sm text-gray-400 mb-4">
          or click to browse files
        </p>
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

      {/* File list */}
      {files.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl">
          <div className="p-4 border-b border-gray-800">
            <h3 className="font-semibold text-white">
              Selected Files ({files.length})
            </h3>
          </div>
          <div className="divide-y divide-gray-800">
            {files.map((file, index) => (
              <div
                key={`${file.name}-${index}`}
                className="flex items-center justify-between p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-gray-800 flex items-center justify-center text-sm">
                    {uploadProgress[file.name] ? '✓' : '📄'}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{file.name}</p>
                    <p className="text-xs text-gray-400">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                </div>
                {!isUploading && (
                  <button
                    onClick={() => removeFile(index)}
                    className="p-1 text-gray-500 hover:text-red-400 rounded"
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
            ))}
          </div>
          <div className="p-4 border-t border-gray-800 flex justify-end gap-3">
            <button
              onClick={() => navigate(`/projects/${projectId}`)}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={isUploading}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isUploading
                ? `Uploading... (${Object.values(uploadProgress).filter(Boolean).length}/${files.length})`
                : `Upload ${files.length} file(s)`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
