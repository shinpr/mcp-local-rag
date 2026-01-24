import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadFile, ingestData, type IngestResult } from '../api/client'

export function useUpload() {
  const queryClient = useQueryClient()

  const uploadMutation = useMutation({
    mutationFn: uploadFile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] })
    },
  })

  const ingestMutation = useMutation({
    mutationFn: ({
      content,
      source,
      format,
    }: {
      content: string
      source: string
      format: 'text' | 'html' | 'markdown'
    }) => ingestData(content, source, format),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] })
    },
  })

  return {
    uploadFile: uploadMutation.mutate,
    ingestData: ingestMutation.mutate,
    isUploading: uploadMutation.isPending,
    isIngesting: ingestMutation.isPending,
    uploadError: uploadMutation.error,
    ingestError: ingestMutation.error,
    uploadResult: uploadMutation.data as IngestResult | undefined,
    ingestResult: ingestMutation.data as IngestResult | undefined,
    reset: () => {
      uploadMutation.reset()
      ingestMutation.reset()
    },
  }
}
