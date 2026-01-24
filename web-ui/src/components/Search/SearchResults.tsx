import type { SearchResult } from '../../api/client'

interface SearchResultsProps {
  results: SearchResult[]
}

export function SearchResults({ results }: SearchResultsProps) {
  if (results.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium text-gray-900">
        Results ({results.length})
      </h2>
      <div className="space-y-3">
        {results.map((result, index) => (
          <ResultCard key={`${result.filePath}-${result.chunkIndex}`} result={result} rank={index + 1} />
        ))}
      </div>
    </div>
  )
}

interface ResultCardProps {
  result: SearchResult
  rank: number
}

function ResultCard({ result, rank }: ResultCardProps) {
  const displaySource = result.source || result.filePath
  const scoreColor = getScoreColor(result.score)

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-400">#{rank}</span>
          <h3 className="font-medium text-gray-900 truncate" title={displaySource}>
            {formatSource(displaySource)}
          </h3>
        </div>
        <span
          className={`px-2 py-0.5 text-xs font-medium rounded-full ${scoreColor}`}
          title={`Distance score: ${result.score.toFixed(4)}`}
        >
          {formatScore(result.score)}
        </span>
      </div>

      <p className="text-sm text-gray-600 whitespace-pre-wrap line-clamp-4">
        {result.text}
      </p>

      <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
        <span>Chunk #{result.chunkIndex}</span>
        {result.source && (
          <span className="truncate" title={result.filePath}>
            {result.filePath.split('/').pop()}
          </span>
        )}
      </div>
    </div>
  )
}

function formatSource(source: string): string {
  // For file paths, show just the filename
  if (source.startsWith('/') || source.includes('\\')) {
    return source.split(/[/\\]/).pop() || source
  }
  // For URLs, show shortened version
  if (source.startsWith('http')) {
    try {
      const url = new URL(source)
      return url.hostname + url.pathname.slice(0, 30) + (url.pathname.length > 30 ? '...' : '')
    } catch {
      return source.slice(0, 40) + '...'
    }
  }
  return source
}

function formatScore(score: number): string {
  // Lower score = better match (distance metric)
  if (score < 0.3) return 'Excellent'
  if (score < 0.5) return 'Good'
  if (score < 0.7) return 'Fair'
  return 'Low'
}

function getScoreColor(score: number): string {
  if (score < 0.3) return 'bg-green-100 text-green-800'
  if (score < 0.5) return 'bg-blue-100 text-blue-800'
  if (score < 0.7) return 'bg-yellow-100 text-yellow-800'
  return 'bg-gray-100 text-gray-800'
}
