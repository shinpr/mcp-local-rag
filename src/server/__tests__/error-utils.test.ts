import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatErrorMessage } from '../error-utils.js'

describe('formatErrorMessage', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env['NODE_ENV']
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      process.env['NODE_ENV'] = undefined
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
  })

  describe('in production mode (NODE_ENV !== "development")', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production'
    })

    it('should return only the error message', () => {
      const error = new Error('Something went wrong')
      const result = formatErrorMessage(error)
      expect(result).toBe('Something went wrong')
    })

    it('should return the error message even when stack is available', () => {
      const error = new Error('Production error')
      // Ensure stack exists
      expect(error.stack).toBeDefined()
      const result = formatErrorMessage(error)
      expect(result).toBe('Production error')
    })
  })

  describe('in development mode (NODE_ENV === "development")', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'development'
    })

    it('should return the stack trace when available', () => {
      const error = new Error('Dev error')
      const result = formatErrorMessage(error)
      // Stack trace includes the message and file info
      expect(result).toContain('Dev error')
      expect(result).toContain('Error:')
    })

    it('should return the error message when stack is not available', () => {
      const error = new Error('No stack error')
      error.stack = undefined
      const result = formatErrorMessage(error)
      expect(result).toBe('No stack error')
    })
  })

  describe('when NODE_ENV is not set', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = undefined
    })

    it('should return only the error message (secure by default)', () => {
      const error = new Error('Default mode error')
      const result = formatErrorMessage(error)
      expect(result).toBe('Default mode error')
    })
  })

  describe('with non-Error objects', () => {
    it('should handle string errors cast as Error', () => {
      // The function casts to Error, matching the original inline pattern behavior
      const error = { message: 'Custom error object', stack: undefined }
      process.env['NODE_ENV'] = 'production'
      const result = formatErrorMessage(error)
      expect(result).toBe('Custom error object')
    })
  })
})
