import { apiClient } from './client'
import type { AuthDefaultsResponse, AuthResponse, UserResponse } from '../types/api'

export async function register(
  email: string,
  username: string,
  password: string,
): Promise<AuthResponse> {
  return apiClient.post<AuthResponse>('/auth/register', {
    email,
    username,
    password,
  })
}

export async function login(
  email: string,
  password: string,
): Promise<AuthResponse> {
  return apiClient.post<AuthResponse>('/auth/login', { email, password })
}

export async function getMe(): Promise<UserResponse> {
  return apiClient.get<UserResponse>('/auth/me')
}

export async function getAuthDefaults(): Promise<AuthDefaultsResponse> {
  return apiClient.get<AuthDefaultsResponse>('/auth/defaults')
}
