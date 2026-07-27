// CLI Common Helpers Tests
// Test Type: Unit Test
// Tests createVectorStore and createEmbedder factory functions

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    VectorStore: vi.fn(),
    Embedder: vi.fn(),
  }
})

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const vectordbFactory = () => ({
  VectorStore: mocks.VectorStore,
})

const embedderFactory = () => ({
  Embedder: mocks.Embedder,
})

const MOCKED_PATHS = ['../../vectordb/index.js', '../../embedder/index.js'] as const

// ============================================
// Imports (dynamic, after vi.doMock in beforeAll)
// ============================================

let createEmbedder: typeof import('../../cli/common.js').createEmbedder
let formatCliError: typeof import('../../cli/common.js').formatCliError
type ResolvedGlobalConfig = import('../../cli/options.js').ResolvedGlobalConfig

// ============================================
// Test Data
// ============================================

function makeConfig(overrides: Partial<ResolvedGlobalConfig> = {}): ResolvedGlobalConfig {
  return {
    dbPath: './test-db/',
    cacheDir: './test-cache/',
    modelName: 'Xenova/all-MiniLM-L6-v2',
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

describe('cli/common', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../vectordb/index.js', vectordbFactory)
    vi.doMock('../../embedder/index.js', embedderFactory)
    // The vectordb mock stays installed so importing cli/common.js does not pull
    // in the real LanceDB module under `isolate: false`.
    ;({ createEmbedder, formatCliError } = await import('../../cli/common.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  describe('formatCliError', () => {
    it('renders the full cause chain with stacks for a nested error', () => {
      // Build a deterministic 3-link chain: outer → mid → root.
      const root = new Error('root disk failure')
      const mid = new Error('vector store write failed', { cause: root })
      const outer = new Error('Failed to ingest file', { cause: mid })

      const rendered = formatCliError(outer)

      // Every link's message appears.
      expect(rendered).toContain('Failed to ingest file')
      expect(rendered).toContain('vector store write failed')
      expect(rendered).toContain('root disk failure')
      // Deeper links are attributed as causes; the outer link is not.
      expect(rendered).toContain('Caused by: ')
      expect(rendered.indexOf('Caused by: ')).toBeGreaterThan(
        rendered.indexOf('Failed to ingest file')
      )
      // The chain is ordered outer → cause → cause.
      expect(rendered.indexOf('Failed to ingest file')).toBeLessThan(
        rendered.indexOf('vector store write failed')
      )
      expect(rendered.indexOf('vector store write failed')).toBeLessThan(
        rendered.indexOf('root disk failure')
      )
      // Stack frames are included for diagnostics (operator-facing).
      expect(rendered).toContain('at ')
    })

    it('renders message and stack for a single Error without a cause', () => {
      const err = new Error('lonely failure')

      const rendered = formatCliError(err)

      expect(rendered).toContain('lonely failure')
      expect(rendered).not.toContain('Caused by: ')
      expect(rendered).toContain('at ')
    })

    it('stringifies a non-Error thrown value', () => {
      const rendered = formatCliError('plain string failure')

      expect(rendered).toContain('plain string failure')
      expect(rendered).not.toContain('Caused by: ')
    })
  })

  describe('createEmbedder', () => {
    const originalDevice = process.env['RAG_DEVICE']
    const originalDtype = process.env['RAG_DTYPE']

    afterEach(() => {
      mocks.Embedder.mockReset()
      if (originalDevice === undefined) {
        delete process.env['RAG_DEVICE']
      } else {
        process.env['RAG_DEVICE'] = originalDevice
      }
      if (originalDtype === undefined) {
        delete process.env['RAG_DTYPE']
      } else {
        process.env['RAG_DTYPE'] = originalDtype
      }
    })

    it('defaults device to cpu when RAG_DEVICE is unset', () => {
      delete process.env['RAG_DEVICE']

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledOnce()
      expect(mocks.Embedder).toHaveBeenCalledWith({
        modelPath: 'custom/model',
        batchSize: 16,
        cacheDir: '/custom/cache',
        device: 'cpu',
      })
    })

    it('passes RAG_DEVICE through to the Embedder', () => {
      process.env['RAG_DEVICE'] = 'webgpu'

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledWith(expect.objectContaining({ device: 'webgpu' }))
    })

    it('omits dtype from the Embedder config when RAG_DTYPE is unset', () => {
      delete process.env['RAG_DTYPE']

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledOnce()
      const passedConfig = mocks.Embedder.mock.calls[0]?.[0]
      expect(passedConfig).not.toHaveProperty('dtype')
    })

    it('passes RAG_DTYPE through to the Embedder when set', () => {
      process.env['RAG_DTYPE'] = 'q8'

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledWith(expect.objectContaining({ dtype: 'q8' }))
    })

    it('omits dtype when RAG_DTYPE is whitespace-only', () => {
      process.env['RAG_DTYPE'] = '   '

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      const passedConfig = mocks.Embedder.mock.calls[0]?.[0]
      expect(passedConfig).not.toHaveProperty('dtype')
    })
  })
})
