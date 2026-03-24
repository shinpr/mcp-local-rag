// CLI Global Options Tests
// Test Type: Unit Test
// Tests parseGlobalOptions and resolveGlobalConfig

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GLOBAL_DEFAULTS,
  parseGlobalOptions,
  ROOT_HELP_TEXT,
  resolveGlobalConfig,
  validateChunkMinLength,
  validateMaxFileSize,
  validateModelName,
  validatePath,
} from '../../cli/options.js'

describe('CLI global options', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  // ============================================
  // parseGlobalOptions
  // ============================================
  describe('parseGlobalOptions', () => {
    it('should return empty options and all args when no global flags present', () => {
      const result = parseGlobalOptions(['ingest', '/path'])
      expect(result.globalOptions).toEqual({})
      expect(result.remainingArgs).toEqual(['ingest', '/path'])
    })

    it('should extract --db-path before subcommand', () => {
      const result = parseGlobalOptions(['--db-path', '/my/db', 'ingest', '/path'])
      expect(result.globalOptions.dbPath).toBe('/my/db')
      expect(result.remainingArgs).toEqual(['ingest', '/path'])
    })

    it('should extract --cache-dir before subcommand', () => {
      const result = parseGlobalOptions(['--cache-dir', '/my/cache', 'ingest', '/path'])
      expect(result.globalOptions.cacheDir).toBe('/my/cache')
      expect(result.remainingArgs).toEqual(['ingest', '/path'])
    })

    it('should extract --model-name before subcommand', () => {
      const result = parseGlobalOptions(['--model-name', 'custom/model', 'ingest', '/path'])
      expect(result.globalOptions.modelName).toBe('custom/model')
      expect(result.remainingArgs).toEqual(['ingest', '/path'])
    })

    it('should extract all global options together', () => {
      const result = parseGlobalOptions([
        '--db-path',
        '/db',
        '--cache-dir',
        '/cache',
        '--model-name',
        'model',
        'ingest',
        '/path',
      ])
      expect(result.globalOptions).toEqual({
        dbPath: '/db',
        cacheDir: '/cache',
        modelName: 'model',
      })
      expect(result.remainingArgs).toEqual(['ingest', '/path'])
    })

    it('should stop parsing at first non-flag argument (subcommand boundary)', () => {
      // After 'ingest', everything else is passed through
      const result = parseGlobalOptions(['--db-path', '/db', 'ingest', '--base-dir', '/base'])
      expect(result.globalOptions.dbPath).toBe('/db')
      expect(result.remainingArgs).toEqual(['ingest', '--base-dir', '/base'])
    })

    it('should return empty remainingArgs when only global flags given', () => {
      const result = parseGlobalOptions(['--db-path', '/db'])
      expect(result.globalOptions.dbPath).toBe('/db')
      expect(result.remainingArgs).toEqual([])
    })

    it('should return empty options and empty remainingArgs for empty input', () => {
      const result = parseGlobalOptions([])
      expect(result.globalOptions).toEqual({})
      expect(result.remainingArgs).toEqual([])
    })

    it('should show root help and exit(0) when --help is before subcommand', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--help'])).toThrow('process.exit(0)')
        expect(errorSpy).toHaveBeenCalledWith(ROOT_HELP_TEXT)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should show root help and exit(0) when -h is before subcommand', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['-h'])).toThrow('process.exit(0)')
        expect(errorSpy).toHaveBeenCalledWith(ROOT_HELP_TEXT)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should show root help when --help is combined with global options', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--db-path', '/db', '--help'])).toThrow('process.exit(0)')
        expect(errorSpy).toHaveBeenCalledWith(ROOT_HELP_TEXT)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when flag value is missing for --db-path', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--db-path'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --db-path')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when flag value is missing for --cache-dir', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--cache-dir'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --cache-dir')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when flag value is missing for --model-name', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--model-name'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --model-name')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should treat empty string as valid value for --db-path', () => {
      const result = parseGlobalOptions(['--db-path', '', 'ingest'])
      expect(result.globalOptions.dbPath).toBe('')
      expect(result.remainingArgs).toEqual(['ingest'])
    })

    it('should pass --help after subcommand in remainingArgs', () => {
      const result = parseGlobalOptions(['ingest', '--help'])
      expect(result.globalOptions).toEqual({})
      expect(result.remainingArgs).toEqual(['ingest', '--help'])
    })

    it('should error on unknown global flag', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--unknown-flag', 'ingest'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Unknown global option: --unknown-flag')
        expect(errorSpy).toHaveBeenCalledWith('Run "mcp-local-rag --help" for available options.')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should detect flag value starting with dash as missing value', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => parseGlobalOptions(['--db-path', '--cache-dir'])).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith('Missing value for --db-path')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  // ============================================
  // resolveGlobalConfig
  // ============================================
  describe('resolveGlobalConfig', () => {
    afterEach(() => {
      delete process.env['DB_PATH']
      delete process.env['CACHE_DIR']
      delete process.env['MODEL_NAME']
    })

    it('should use defaults when no options or env vars', () => {
      const config = resolveGlobalConfig({})
      expect(config).toEqual({
        dbPath: GLOBAL_DEFAULTS.dbPath,
        cacheDir: GLOBAL_DEFAULTS.cacheDir,
        modelName: GLOBAL_DEFAULTS.modelName,
      })
    })

    it('should use CLI options over defaults', () => {
      const config = resolveGlobalConfig({
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli/model',
      })
      expect(config).toEqual({
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli/model',
      })
    })

    it('should use env vars over defaults', () => {
      process.env['DB_PATH'] = '/env/db'
      process.env['CACHE_DIR'] = '/env/cache'
      process.env['MODEL_NAME'] = 'env/model'

      const config = resolveGlobalConfig({})
      expect(config).toEqual({
        dbPath: '/env/db',
        cacheDir: '/env/cache',
        modelName: 'env/model',
      })
    })

    it('should use CLI options over env vars', () => {
      process.env['DB_PATH'] = '/env/db'
      process.env['CACHE_DIR'] = '/env/cache'
      process.env['MODEL_NAME'] = 'env/model'

      const config = resolveGlobalConfig({
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli/model',
      })
      expect(config).toEqual({
        dbPath: '/cli/db',
        cacheDir: '/cli/cache',
        modelName: 'cli/model',
      })
    })

    it('should mix CLI options and env vars for partial override', () => {
      process.env['CACHE_DIR'] = '/env/cache'

      const config = resolveGlobalConfig({ dbPath: '/cli/db' })
      expect(config.dbPath).toBe('/cli/db')
      expect(config.cacheDir).toBe('/env/cache')
      expect(config.modelName).toBe(GLOBAL_DEFAULTS.modelName)
    })
  })

  // ============================================
  // ROOT_HELP_TEXT content
  // ============================================
  describe('ROOT_HELP_TEXT', () => {
    it('should contain global options', () => {
      expect(ROOT_HELP_TEXT).toContain('--db-path')
      expect(ROOT_HELP_TEXT).toContain('--cache-dir')
      expect(ROOT_HELP_TEXT).toContain('--model-name')
      expect(ROOT_HELP_TEXT).toContain('-h, --help')
    })

    it('should contain available commands', () => {
      expect(ROOT_HELP_TEXT).toContain('ingest')
      expect(ROOT_HELP_TEXT).toContain('skills install')
    })

    it('should contain default values', () => {
      expect(ROOT_HELP_TEXT).toContain('./lancedb/')
      expect(ROOT_HELP_TEXT).toContain('./models/')
      expect(ROOT_HELP_TEXT).toContain('Xenova/all-MiniLM-L6-v2')
    })
  })

  // ============================================
  // validatePath
  // ============================================
  describe('validatePath', () => {
    it('should reject /etc paths', () => {
      expect(validatePath('/etc/config', '--db-path')).toContain('sensitive system path')
    })

    it('should reject /usr paths', () => {
      expect(validatePath('/usr/local/data', '--db-path')).toContain('sensitive system path')
    })

    it('should reject /sys paths', () => {
      expect(validatePath('/sys/block', '--cache-dir')).toContain('sensitive system path')
    })

    it('should reject /proc paths', () => {
      expect(validatePath('/proc/self', '--cache-dir')).toContain('sensitive system path')
    })

    it('should reject /var paths', () => {
      expect(validatePath('/var/log', '--db-path')).toContain('sensitive system path')
    })

    it('should reject ~/.ssh paths', () => {
      expect(validatePath('~/.ssh/keys', '--db-path')).toContain('sensitive system path')
    })

    it('should reject ~/.gnupg paths', () => {
      expect(validatePath('~/.gnupg/data', '--cache-dir')).toContain('sensitive system path')
    })

    it('should accept normal paths', () => {
      expect(validatePath('./data', '--db-path')).toBeUndefined()
      expect(validatePath('/home/user/project', '--db-path')).toBeUndefined()
      expect(validatePath('./lancedb/', '--db-path')).toBeUndefined()
    })

    it('should not reject paths that merely contain sensitive names as substrings', () => {
      expect(validatePath('/home/user/etc-backup', '--db-path')).toBeUndefined()
      expect(validatePath('/home/user/myvar', '--db-path')).toBeUndefined()
    })
  })

  // ============================================
  // validateModelName
  // ============================================
  describe('validateModelName', () => {
    it('should accept valid model names', () => {
      expect(validateModelName('Xenova/all-MiniLM-L6-v2')).toBeUndefined()
      expect(validateModelName('my_model.v1')).toBeUndefined()
      expect(validateModelName('simple')).toBeUndefined()
    })

    it('should reject model names with spaces', () => {
      expect(validateModelName('invalid model')).toContain('Invalid model name')
    })

    it('should reject model names with special characters', () => {
      expect(validateModelName('model@v1')).toContain('Invalid model name')
      expect(validateModelName('model;rm -rf /')).toContain('Invalid model name')
    })

    it('should reject model names with path traversal', () => {
      expect(validateModelName('../etc/passwd')).toContain('Path traversal')
      expect(validateModelName('foo/../bar')).toContain('Path traversal')
    })

    it('should accept local-style paths without traversal', () => {
      expect(validateModelName('my-org/my-model')).toBeUndefined()
      expect(validateModelName('./local/model')).toBeUndefined()
    })
  })

  // ============================================
  // validateMaxFileSize
  // ============================================
  describe('validateMaxFileSize', () => {
    it('should accept valid sizes', () => {
      expect(validateMaxFileSize(1)).toBeUndefined()
      expect(validateMaxFileSize(1024)).toBeUndefined()
      expect(validateMaxFileSize(524288000)).toBeUndefined()
    })

    it('should reject zero', () => {
      expect(validateMaxFileSize(0)).toContain('must be between 1 and 524288000')
    })

    it('should reject negative values', () => {
      expect(validateMaxFileSize(-1)).toContain('must be between 1 and 524288000')
    })

    it('should reject values exceeding 500MB', () => {
      expect(validateMaxFileSize(524288001)).toContain('must be between 1 and 524288000')
    })

    it('should reject NaN', () => {
      expect(validateMaxFileSize(NaN)).toContain('must be between 1 and 524288000')
    })
  })

  // ============================================
  // validateChunkMinLength
  // ============================================
  describe('validateChunkMinLength', () => {
    it('should accept valid values', () => {
      expect(validateChunkMinLength(1)).toBeUndefined()
      expect(validateChunkMinLength(200)).toBeUndefined()
      expect(validateChunkMinLength(10000)).toBeUndefined()
    })

    it('should reject zero', () => {
      expect(validateChunkMinLength(0)).toContain('must be between 1 and 10000')
    })

    it('should reject negative values', () => {
      expect(validateChunkMinLength(-1)).toContain('must be between 1 and 10000')
    })

    it('should reject values exceeding 10000', () => {
      expect(validateChunkMinLength(10001)).toContain('must be between 1 and 10000')
    })

    it('should reject NaN', () => {
      expect(validateChunkMinLength(NaN)).toContain('must be between 1 and 10000')
    })
  })

  // ============================================
  // resolveGlobalConfig with validation
  // ============================================
  describe('resolveGlobalConfig validation', () => {
    afterEach(() => {
      delete process.env['DB_PATH']
      delete process.env['CACHE_DIR']
      delete process.env['MODEL_NAME']
    })

    it('should error when DB_PATH env var points to sensitive path', () => {
      process.env['DB_PATH'] = '/etc/lancedb'
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveGlobalConfig({})).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sensitive system path'))
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when MODEL_NAME env var has invalid characters', () => {
      process.env['MODEL_NAME'] = 'model with spaces'
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveGlobalConfig({})).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid model name'))
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('should error when --db-path CLI flag points to sensitive path', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => resolveGlobalConfig({ dbPath: '/var/data' })).toThrow('process.exit(1)')
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sensitive system path'))
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
