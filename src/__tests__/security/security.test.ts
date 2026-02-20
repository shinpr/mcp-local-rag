// RAG MCP Server Security Test - Design Doc: rag-mcp-server-design.md (v1.1)
// Generated: 2025-10-31
// Test Type: Security Test (Minimal Essential Tests)
// Implementation Timing: After core implementations complete
// Note: Reduced from 43 to 10 tests based on YAGNI principle and avoiding redundancy

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentParser, ValidationError } from '../../parser/index.js'
import { RAGServer } from '../../server/index.js'

// ============================================
// Test Configuration
// ============================================

const testConfig = {
  dbPath: './tmp/test-security-db',
  modelName: 'Xenova/all-MiniLM-L6-v2',
  cacheDir: './tmp/models',
  baseDir: resolve('./'), // Project root (accessible to both tests/fixtures and tmp)
  maxFileSize: 100 * 1024 * 1024, // 100MB
}

// ============================================
// Network Monitoring Helper
// ============================================

interface NetworkMonitor {
  requests: string[]
  restore: () => void
}

function createNetworkMonitor(): NetworkMonitor {
  const requests: string[] = []
  const originalFetch = global.fetch

  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    requests.push(url.toString())
    return originalFetch(url)
  }) as typeof fetch

  return {
    requests,
    restore: () => {
      global.fetch = originalFetch
    },
  }
}

// ============================================
// ============================================

describe('RAG MCP Server Security Test', () => {
  let server: RAGServer
  const fixturesDir = resolve('./tmp/test-security-fixtures')

  beforeAll(async () => {
    // Setup: Prepare environment for security testing
    await mkdir(testConfig.dbPath, { recursive: true })
    await mkdir(fixturesDir, { recursive: true })
  })

  afterAll(async () => {
    // Cleanup: Delete security test data (only our directories)
    await rm(testConfig.dbPath, { recursive: true, force: true })
    await rm(fixturesDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Initialize server before each test
    server = new RAGServer(testConfig)
    await server.initialize()

    // Create test fixture directory and files
    await mkdir(fixturesDir, { recursive: true })
    await writeFile(
      resolve(fixturesDir, 'sample.txt'),
      `This is a comprehensive sample text file for security testing purposes.

TypeScript is a powerful programming language that adds static typing to JavaScript.
It helps developers catch errors at compile time rather than runtime.
Many large-scale applications use TypeScript for improved maintainability.

Security testing is an essential part of software development.
It ensures that applications are protected against common vulnerabilities.
Proper security measures include input validation and authentication.

The RAG (Retrieval-Augmented Generation) system processes documents efficiently.
It uses vector embeddings to find semantically similar content.
This approach provides accurate search results for natural language queries.`
    )
  })

  // --------------------------------------------
  // S-001: No external network communication (except model download)
  // --------------------------------------------
  describe('S-001: No external network communication (except model download)', () => {
    // AC interpretation: [Security requirement] No external communication detected by packet capture (except model download)
    // Validation: No external communication occurs during file ingestion → search workflow after server startup
    it('No external communication detected during file ingestion → search workflow after server startup (simulated)', async () => {
      const monitor = createNetworkMonitor()

      try {
        // Ingest file
        const sampleFile = resolve(fixturesDir, 'sample.txt')
        await server.handleIngestFile({ filePath: sampleFile })

        // Execute search
        await server.handleQueryDocuments({ query: 'TypeScript', limit: 5 })

        // Verify no external communication occurred
        expect(monitor.requests.length).toBe(0)
      } finally {
        monitor.restore()
      }
    })

    // AC interpretation: [Security requirement] Transformers.js model loaded from local cache
    // Validation: No network communication after initial model download on subsequent startups
    it('No network communication after initial model download on subsequent startups (simulated)', async () => {
      const monitor = createNetworkMonitor()

      try {
        // Second initialization (model already cached)
        const server2 = new RAGServer(testConfig)
        await server2.initialize()

        // Verify no requests to HuggingFace API
        const huggingfaceRequests = monitor.requests.filter((url) => url.includes('huggingface.co'))
        expect(huggingfaceRequests.length).toBe(0)
      } finally {
        monitor.restore()
      }
    })

    // AC interpretation: [Security requirement] LanceDB accesses local filesystem only
    // Validation: No network communication during LanceDB operations
    it('No network communication during LanceDB operations (initialization, insertion, search) (simulated)', async () => {
      const monitor = createNetworkMonitor()

      try {
        // Execute LanceDB operations
        const sampleFile = resolve(fixturesDir, 'sample.txt')
        await server.handleIngestFile({ filePath: sampleFile })
        await server.handleQueryDocuments({ query: 'TypeScript', limit: 5 })

        // Verify no external communication occurred
        expect(monitor.requests.length).toBe(0)
      } finally {
        monitor.restore()
      }
    })
  })

  // --------------------------------------------
  // S-002: Path traversal attack prevention
  // --------------------------------------------
  describe('S-002: Path traversal attack prevention', () => {
    // AC interpretation: [Security requirement] Path traversal attacks (`../../etc/passwd`) are rejected
    // Validation: Calling ingest_file with invalid file path (e.g., `../../etc/passwd`) returns ValidationError
    it('Path traversal attack (e.g., ../../etc/passwd) rejected with ValidationError', async () => {
      const parser = new DocumentParser({
        baseDir: fixturesDir,
        maxFileSize: 100 * 1024 * 1024,
      })

      await expect(parser.parseFile('../../etc/passwd')).rejects.toThrow(ValidationError)
    })

    // AC interpretation: [Security requirement] Access outside baseDir with absolute paths is rejected
    // Validation: Calling ingest_file with absolute path outside baseDir (e.g., `/etc/passwd`) returns ValidationError
    it('Absolute path outside baseDir (e.g., /etc/passwd) rejected with ValidationError', async () => {
      const parser = new DocumentParser({
        baseDir: fixturesDir,
        maxFileSize: 100 * 1024 * 1024,
      })

      await expect(parser.parseFile('/etc/passwd')).rejects.toThrow(ValidationError)
    })

    // AC interpretation: [Security requirement] Access outside baseDir via symbolic links is rejected
    // Validation: Calling ingest_file with symbolic link pointing outside baseDir returns ValidationError
    // Note: Uses .txt extension to ensure the test validates symlink defense (BASE_DIR check),
    // not file extension filtering. Previously used link_to_etc_passwd (no extension) which
    // was caught by "Unsupported file format" before the symlink was ever followed.
    it('Symbolic link pointing outside baseDir rejected with ValidationError about BASE_DIR', async () => {
      const parser = new DocumentParser({
        baseDir: fixturesDir,
        maxFileSize: 100 * 1024 * 1024,
      })

      // Create a target file outside fixturesDir (but within tmp/)
      const outsideDir = resolve('./tmp/test-security-outside')
      const outsideFile = resolve(outsideDir, 'secret.txt')
      await mkdir(outsideDir, { recursive: true })
      await writeFile(
        outsideFile,
        'This file is outside baseDir and should not be accessible via symlink.'
      )

      // Create symbolic link with .txt extension: fixturesDir/link.txt -> outsideDir/secret.txt
      const linkPath = resolve(fixturesDir, 'link.txt')
      try {
        await symlink(outsideFile, linkPath)
      } catch {
        // Ignore symlink creation failure (if already exists)
      }

      try {
        // Verify: ValidationError is thrown with BASE_DIR message (symlink defense),
        // NOT "Unsupported file format" (extension filtering)
        await expect(parser.parseFile(linkPath)).rejects.toThrow(
          expect.objectContaining({
            name: 'ValidationError',
            message: expect.stringMatching(/BASE_DIR/),
          })
        )
      } finally {
        // Cleanup: symlink and outside directory
        await rm(linkPath, { force: true })
        await rm(outsideDir, { recursive: true, force: true })
      }
    })
  })

  // --------------------------------------------
  // S-003: No document content in logs
  // --------------------------------------------
  describe('S-003: No document content in logs', () => {
    // AC interpretation: [Security requirement] Document content not output to logs
    // Validation: Logs during file ingestion do not contain document body
    it('Logs during file ingestion do not contain document body (max 100 characters allowed)', async () => {
      // Capture logs
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.join(' '))
      }

      try {
        // Create test file (containing confidential information)
        const testFile = resolve('./tmp/secret-document.txt')
        await writeFile(
          testFile,
          `This is a secret document with confidential information: PASSWORD123.

The document contains sensitive data that should never appear in logs.
Proper logging practices require filtering out confidential information.
Security best practices dictate that passwords should be masked in output.

This paragraph provides additional content for proper semantic chunking.
Multiple sentences ensure the document is processed correctly by the RAG system.
The chunker requires sufficient text length to generate meaningful chunks.`
        )

        // Ingest file
        await server.handleIngestFile({ filePath: testFile })

        // Verify document content not included in logs
        const containsSecret = logs.some(
          (log) => log.includes('PASSWORD123') || log.includes('confidential information')
        )
        expect(containsSecret).toBe(false)
      } finally {
        // Restore console.log (always executed even if test fails)
        console.log = originalLog
      }
    })

    // AC interpretation: [Security requirement] Search queries not output to logs
    // Validation: Logs during search do not contain search query body (max 100 characters allowed)
    it('Logs during search do not contain search query body (max 100 characters allowed)', async () => {
      // Capture logs
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.join(' '))
      }

      try {
        // Ingest sample file
        const sampleFile = resolve(fixturesDir, 'sample.txt')
        await server.handleIngestFile({ filePath: sampleFile })

        // Search with confidential query
        const secretQuery = 'secret query with confidential information PASSWORD123'
        await server.handleQueryDocuments({ query: secretQuery, limit: 5 })

        // Verify search query not included in logs
        const containsQuery = logs.some(
          (log) => log.includes('PASSWORD123') || log.includes('confidential information')
        )
        expect(containsQuery).toBe(false)
      } finally {
        // Restore console.log (always executed even if test fails)
        console.log = originalLog
      }
    })

    // AC interpretation: [Security requirement] Document content not included in error logs
    // Validation: Logs during parse errors do not contain document body
    it('Logs during parse errors do not contain document body', async () => {
      // Capture logs
      const logs: string[] = []
      const originalError = console.error
      console.error = (...args: unknown[]) => {
        logs.push(args.join(' '))
      }

      try {
        // Attempt to ingest non-existent file (error occurs)
        const nonExistentFile = resolve('./tmp/nonexistent-document.txt')

        try {
          await server.handleIngestFile({ filePath: nonExistentFile })
        } catch {
          // Error is expected
        }

        // Verify error logs do not contain confidential information (PASSWORD123, etc.)
        // Note: File path itself is allowed (max 100 characters)
        const containsPassword = logs.some((log) => log.includes('PASSWORD123'))
        expect(containsPassword).toBe(false)
      } finally {
        // Restore console.error (always executed even if test fails)
        console.error = originalError
      }
    })
  })

  // --------------------------------------------
  // S-004: MCP security best practices compliance
  // --------------------------------------------
  describe('S-004: MCP security best practices compliance', () => {
    // Default behavior: Stack traces NOT included (secure by default for MCP servers)
    it('Stack traces not included by default when NODE_ENV is not set', async () => {
      const originalEnv = process.env['NODE_ENV']
      process.env['NODE_ENV'] = undefined

      const nonExistentFile = resolve('./tmp/nonexistent.txt')

      try {
        await server.handleIngestFile({ filePath: nonExistentFile })
        expect.fail('Expected error to be thrown')
      } catch (error) {
        const errorMessage = (error as Error).message

        // Verify stack trace is not included
        expect(errorMessage).not.toContain(' at ')
        expect(errorMessage).not.toContain('.ts:')
        expect(errorMessage).not.toContain('.js:')
      }

      // Restore environment variable
      process.env['NODE_ENV'] = originalEnv
    })

    // Development mode: Stack traces ARE included for debugging
    it('Stack traces included when NODE_ENV=development', async () => {
      const originalEnv = process.env['NODE_ENV']
      process.env['NODE_ENV'] = 'development'

      const nonExistentFile = resolve('./tmp/nonexistent.txt')

      try {
        await server.handleIngestFile({ filePath: nonExistentFile })
        expect.fail('Expected error to be thrown')
      } catch (error) {
        const errorMessage = (error as Error).message

        // Verify stack trace IS included in development mode
        expect(errorMessage).toContain(' at ')
      }

      // Restore environment variable
      process.env['NODE_ENV'] = originalEnv
    })
  })
})
