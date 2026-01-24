import { useState } from 'react'
import { DropZone, ContentPaste } from '../components/Upload'
import { useUpload } from '../hooks'

type TabType = 'file' | 'content'

export function UploadPage() {
  const [activeTab, setActiveTab] = useState<TabType>('file')
  const {
    uploadFile,
    ingestData,
    isUploading,
    isIngesting,
    uploadError,
    ingestError,
    uploadResult,
    ingestResult,
    reset,
  } = useUpload()

  const handleFileSelect = (file: File) => {
    reset()
    uploadFile(file)
  }

  const handleIngest = (content: string, source: string, format: 'text' | 'html' | 'markdown') => {
    reset()
    ingestData({ content, source, format })
  }

  const result = uploadResult || ingestResult
  const error = uploadError || ingestError
  const isProcessing = isUploading || isIngesting

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Upload Content</h1>
        <p className="text-gray-600">
          Add documents to your knowledge base for semantic search.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6">
          <button
            onClick={() => setActiveTab('file')}
            className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'file'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Upload File
          </button>
          <button
            onClick={() => setActiveTab('content')}
            className={`py-3 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'content'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Paste Content
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        {activeTab === 'file' ? (
          <DropZone onFileSelect={handleFileSelect} isUploading={isUploading} />
        ) : (
          <ContentPaste onIngest={handleIngest} isIngesting={isIngesting} />
        )}
      </div>

      {/* Processing indicator */}
      {isProcessing && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
          <Spinner />
          <span className="text-blue-700">Processing content...</span>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          <p className="font-medium">Error</p>
          <p className="text-sm">{error.message}</p>
        </div>
      )}

      {/* Success message */}
      {result && !isProcessing && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-green-700">
          <p className="font-medium">Content Ingested Successfully</p>
          <div className="text-sm mt-1 space-y-1">
            <p>Chunks created: {result.chunkCount}</p>
            <p className="text-gray-500 truncate">{result.filePath}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}
