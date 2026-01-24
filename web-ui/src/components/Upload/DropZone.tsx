import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'

interface DropZoneProps {
  onFileSelect: (file: File) => void
  isUploading: boolean
}

const ACCEPTED_TYPES = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md'],
  'text/html': ['.html'],
  'application/json': ['.json'],
}

export function DropZone({ onFileSelect, isUploading }: DropZoneProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onFileSelect(acceptedFiles[0])
      }
    },
    [onFileSelect]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxFiles: 1,
    disabled: isUploading,
    maxSize: 100 * 1024 * 1024, // 100MB
  })

  return (
    <div
      {...getRootProps()}
      className={`
        border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
        ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}
        ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <input {...getInputProps()} />
      <UploadIcon className="w-12 h-12 mx-auto text-gray-400 mb-4" />
      {isDragActive ? (
        <p className="text-blue-600 font-medium">Drop the file here...</p>
      ) : (
        <>
          <p className="text-gray-600 font-medium mb-1">
            Drag and drop a file here, or click to select
          </p>
          <p className="text-sm text-gray-400">
            Supports PDF, DOCX, TXT, MD, HTML, JSON (max 100MB)
          </p>
        </>
      )}
    </div>
  )
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
      />
    </svg>
  )
}
