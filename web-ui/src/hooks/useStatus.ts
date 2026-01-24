import { useQuery } from '@tanstack/react-query'
import { getStatus } from '../api/client'

export function useStatus() {
  const { data: status, isLoading, error, refetch } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 30000, // Refresh every 30 seconds
  })

  return {
    status,
    isLoading,
    error,
    refetch,
  }
}
