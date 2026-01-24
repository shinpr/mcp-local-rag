import { useState } from 'react'
import type { FileInfo } from '../../api/client'

interface FileItemProps {
  file: FileInfo
  onDelete: (options: { filePath?: string; source?: string }) => void
  isDeleting: boolean
}

export function FileItem({ file, onDelete, isDeleting }: FileItemProps) {
  const [showConfirm, setShowConfirm] = useState(false)

  const displayName = file.source || file.filePath.split(/[/\\]/).pop() || file.filePath
  const isRawData = file.filePath.includes('raw-data')

  const handleDelete = () => {
    if (file.source) {
      onDelete({ source: file.source })
    } else {
      onDelete({ filePath: file.filePath })
    }
    setShowConfirm(false)
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-gray-900 truncate" title={file.source || file.filePath}>
          {displayName}
        </h3>
        <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
          <span>{file.chunkCount} chunks</span>
          {isRawData && <span className="text-blue-600">Ingested content</span>}
        </div>
        {file.source && (
          <p className="text-xs text-gray-400 truncate mt-1" title={file.filePath}>
            {file.filePath}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {showConfirm ? (
          <>
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              disabled={isDeleting}
              className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setShowConfirm(true)}
            className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
