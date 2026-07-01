import { useState, useEffect } from 'react'
import { getProjects } from '../api/projects'
import { searchProject } from '../api/search'
import type { ProjectResponse, SearchResultItem } from '../types/api'
import toast from 'react-hot-toast'

export default function SearchPage() {
  const [projects, setProjects] = useState<ProjectResponse[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(10)
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchWarning, setSearchWarning] = useState<string | null>(null)

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const data = await getProjects()
        setProjects(data)
        if (data.length > 0 && !selectedProject) {
          setSelectedProject(data[0].name)
        }
      } catch (error) {
        toast.error('Failed to load projects')
      }
    }
    fetchProjects()
  }, [selectedProject])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedProject || !query.trim()) return

    setIsSearching(true)
    setHasSearched(true)
    setSearchWarning(null)

    try {
      const response = await searchProject(selectedProject, query, limit)
      setResults(response.results)
      setSearchWarning(response.warning ?? null)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Search failed',
      )
      setResults([])
      setSearchWarning(null)
    } finally {
      setIsSearching(false)
    }
  }

  const formatScore = (score: number) => {
    return (score * 100).toFixed(1)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Search</h1>
        <p className="text-gray-400 mt-1">
          Search across your indexed documents
        </p>
      </div>

      {/* Search Form */}
      <form onSubmit={handleSearch} className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Query
            </label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              required
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
              placeholder="What are you looking for?"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Project
            </label>
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.name}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Limit
            </label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              min={1}
              max={20}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={isSearching || !selectedProject}
            className="px-6 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSearching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      {/* Results */}
      {hasSearched && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl">
          <div className="p-6 border-b border-gray-800">
            <h2 className="text-lg font-semibold text-white">
              Results ({results.length})
            </h2>
          </div>

          {results.length === 0 ? (
            <div className="p-12 text-center">
              <div className="text-5xl mb-4">🔍</div>
              <h3 className="text-lg font-semibold text-white mb-2">
                No results found
              </h3>
              {searchWarning ? (
                <p className="text-sm text-amber-400 max-w-xl mx-auto">
                  {searchWarning}
                </p>
              ) : (
                <p className="text-sm text-gray-400">
                  Try a different query or project
                </p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {results.map((result, index) => (
                <div key={index} className="p-6">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-gray-400">
                        {result.filename}
                      </span>
                      <span className="text-xs text-gray-600">
                        chunk #{result.chunkIndex}
                      </span>
                    </div>
                    <span className="px-2 py-1 bg-emerald-500/20 text-emerald-400 text-xs font-medium rounded">
                      {formatScore(result.score)}% match
                    </span>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-4">
                    <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans">
                      {result.content}
                    </pre>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    Source: {result.source}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
