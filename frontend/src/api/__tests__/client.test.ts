import { describe, it, expect, beforeEach, vi } from 'vitest'
import { apiClient, ApiClientError } from '../client'

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('ApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  describe('request', () => {
    it('should make GET request with correct headers', async () => {
      const mockResponse = { data: 'test' }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await apiClient.get('/test')

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      expect(result).toEqual(mockResponse)
    })

    it('should include Authorization header when token exists', async () => {
      localStorage.setItem('token', 'test-token')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      })

      await apiClient.get('/test')

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
      })
    })

    it('should throw ApiClientError on failed request', async () => {
      const errorResponse = {
        error: 'Not Found',
        message: 'Resource not found',
      }
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve(errorResponse),
      })

      await expect(apiClient.get('/test')).rejects.toThrow(ApiClientError)
    })

    it('should handle network errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('Invalid JSON')),
      })

      await expect(apiClient.get('/test')).rejects.toThrow(ApiClientError)
    })
  })

  describe('post', () => {
    it('should make POST request with body', async () => {
      const requestBody = { name: 'test' }
      const mockResponse = { id: 1, name: 'test' }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await apiClient.post('/test', requestBody)

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      })
      expect(result).toEqual(mockResponse)
    })
  })

  describe('upload', () => {
    it('should upload file with FormData', async () => {
      const file = new File(['test content'], 'test.txt', {
        type: 'text/plain',
      })
      const mockResponse = { id: 1, filename: 'test.txt' }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await apiClient.upload('/upload', file)

      expect(mockFetch).toHaveBeenCalledWith('/api/upload', {
        method: 'POST',
        headers: {},
        body: expect.any(FormData),
      })
      expect(result).toEqual(mockResponse)
    })
  })
})
