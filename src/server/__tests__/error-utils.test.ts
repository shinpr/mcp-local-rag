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
    it('should preserve message from object with string message property', () => {
      const error = { message: 'Custom error object', stack: undefined }
      process.env['NODE_ENV'] = 'production'
      const result = formatErrorMessage(error)
      expect(result).toBe('Custom error object')
    })
  })

  describe('with non-Error thrown values', () => {
    describe('in production mode', () => {
      beforeEach(() => {
        process.env['NODE_ENV'] = 'production'
      })

      it('should return "null" when error is null', () => {
        const result = formatErrorMessage(null)
        expect(result).toBe('null')
      })

      it('should return "undefined" when error is undefined', () => {
        const result = formatErrorMessage(undefined)
        expect(result).toBe('undefined')
      })

      it('should return the string itself when error is a string', () => {
        const result = formatErrorMessage('string error')
        expect(result).toBe('string error')
      })

      it('should return stringified number when error is a number', () => {
        const result = formatErrorMessage(42)
        expect(result).toBe('42')
      })

      it('should return empty string when error is empty string', () => {
        const result = formatErrorMessage('')
        expect(result).toBe('')
      })

      it('should return message when object has string message property', () => {
        const result = formatErrorMessage({ message: 'obj error' })
        expect(result).toBe('obj error')
      })

      it('should return stringified object when object has non-string message', () => {
        const result = formatErrorMessage({ message: 123 })
        expect(result).toBe('[object Object]')
      })

      it('should return stringified object when object has no message', () => {
        const result = formatErrorMessage({ custom: true })
        expect(result).toBe('[object Object]')
      })
    })
  })
})
