import { FileList } from '../components/Files'
import { useFiles } from '../hooks'

export function FilesPage() {
  const { files, isLoading, error, deleteFile, isDeleting } = useFiles()

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Ingested Files</h1>
          <p className="text-gray-600">
            Manage your knowledge base content.
          </p>
        </div>
        {files.length > 0 && (
          <span className="text-sm text-gray-500">
            {files.length} file{files.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
          <span className="ml-3 text-gray-500">Loading files...</span>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          <p className="font-medium">Error loading files</p>
          <p className="text-sm">{error.message}</p>
        </div>
      ) : (
        <FileList files={files} onDelete={deleteFile} isDeleting={isDeleting} />
      )}
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24">
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
