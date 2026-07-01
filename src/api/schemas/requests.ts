// Fastify JSON Schema validators for request bodies

import type { FastifySchema } from 'fastify'

// ============================================
// Auth
// ============================================

export const registerSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['email', 'username', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      username: {
        type: 'string',
        minLength: 2,
        maxLength: 64,
        pattern: '^[A-Za-z][A-Za-z0-9_-]*$',
      },
      password: { type: 'string', minLength: 8, maxLength: 128 },
    },
    additionalProperties: false,
  },
}

export const loginSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string' },
      password: { type: 'string' },
    },
    additionalProperties: false,
  },
}

// ============================================
// Projects
// ============================================

export const createProjectSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      description: { type: 'string', maxLength: 1024 },
    },
    additionalProperties: false,
  },
}

// ============================================
// Search
// ============================================

export const searchSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['projectName', 'query'],
    properties: {
      projectName: { type: 'string', minLength: 1 },
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    },
    additionalProperties: false,
  },
}

// ============================================
// Ingest
// ============================================

const fileIdsBodySchema = {
  type: 'object',
  properties: {
    fileIds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      maxItems: 100,
    },
  },
  additionalProperties: false,
} as const

export const indexProjectSchema: FastifySchema = {
  body: fileIdsBodySchema,
}

export const reindexProjectSchema: FastifySchema = {
  body: fileIdsBodySchema,
}

export const emptyBodySchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
  },
}
