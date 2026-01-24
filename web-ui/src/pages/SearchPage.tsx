import { SearchBox, SearchResults } from '../components/Search'
import { useSearch } from '../hooks'

export function SearchPage() {
  const { results, search, isLoading, error } = useSearch()

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Search Documents</h1>
        <p className="text-gray-600">
          Search through your ingested documents using semantic and keyword matching.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <SearchBox onSearch={search} isLoading={isLoading} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          <p className="font-medium">Search Error</p>
          <p className="text-sm">{error.message}</p>
        </div>
      )}

      {!isLoading && results.length === 0 && !error && (
        <div className="text-center py-12 text-gray-500">
          <p>Enter a search query to find relevant documents.</p>
        </div>
      )}

      <SearchResults results={results} />
    </div>
  )
}
