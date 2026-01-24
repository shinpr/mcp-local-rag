import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { searchDocuments, type SearchResult } from '../api/client'

export function useSearch() {
  const [results, setResults] = useState<SearchResult[]>([])

  const mutation = useMutation({
    mutationFn: ({ query, limit }: { query: string; limit?: number }) =>
      searchDocuments(query, limit),
    onSuccess: (data) => {
      setResults(data)
    },
  })

  const search = (query: string, limit?: number) => {
    mutation.mutate({ query, limit })
  }

  const clear = () => {
    setResults([])
  }

  return {
    results,
    search,
    clear,
    isLoading: mutation.isPending,
    error: mutation.error,
  }
}
