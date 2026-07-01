import type { ApiError } from '../types/api'

const API_BASE = '/api'

class ApiClient {
  private getToken(): string | null {
    return localStorage.getItem('token')
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = this.getToken()
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    }

    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      let error: ApiError
      try {
        error = await response.json()
      } catch {
        error = {
          error: 'Network Error',
          message: `HTTP ${response.status}: ${response.statusText}`,
        }
      }
      throw new ApiClientError(error.message, response.status, error)
    }

    return response.json()
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }

  async upload<T>(endpoint: string, file: File): Promise<T> {
    const token = this.getToken()
    const formData = new FormData()
    formData.append('file', file)

    const headers: HeadersInit = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    })

    if (!response.ok) {
      let error: ApiError
      try {
        error = await response.json()
      } catch {
        error = {
          error: 'Network Error',
          message: `HTTP ${response.status}: ${response.statusText}`,
        }
      }
      throw new ApiClientError(error.message, response.status, error)
    }

    return response.json()
  }
}

export class ApiClientError extends Error {
  status: number
  apiError: ApiError

  constructor(message: string, status: number, apiError: ApiError) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.apiError = apiError
  }
}

export const apiClient = new ApiClient()
