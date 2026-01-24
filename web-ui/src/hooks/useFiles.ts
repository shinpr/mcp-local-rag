import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listFiles, deleteFile } from '../api/client'

export function useFiles() {
  const queryClient = useQueryClient()

  const { data: files = [], isLoading, error } = useQuery({
    queryKey: ['files'],
    queryFn: listFiles,
  })

  const deleteMutation = useMutation({
    mutationFn: deleteFile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] })
    },
  })

  return {
    files,
    isLoading,
    error,
    deleteFile: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  }
}
