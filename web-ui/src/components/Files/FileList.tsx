import type { FileInfo } from '../../api/client'
import { FileItem } from './FileItem'

interface FileListProps {
  files: FileInfo[]
  onDelete: (options: { filePath?: string; source?: string }) => void
  isDeleting: boolean
}

export function FileList({ files, onDelete, isDeleting }: FileListProps) {
  if (files.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p>No files ingested yet.</p>
        <p className="text-sm mt-1">Upload a file or paste content to get started.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {files.map((file) => (
        <FileItem
          key={file.filePath}
          file={file}
          onDelete={onDelete}
          isDeleting={isDeleting}
        />
      ))}
    </div>
  )
}
