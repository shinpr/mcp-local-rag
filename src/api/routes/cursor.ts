// Cursor MCP configuration automation routes

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'

import { requireAuth } from '../middleware/auth.js'

interface McpServerEntry {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

interface CursorMcpConfig {
  mcpServers: Record<string, McpServerEntry>
}

function getCursorMcpPath(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

function getProjectRoot(): string {
  return process.cwd()
}

function getConfigInfo(configPath: string) {
  const exists = existsSync(configPath)
  let currentConfig: CursorMcpConfig | null = null
  let hasLocalRag = false

  if (exists) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      currentConfig = JSON.parse(raw) as CursorMcpConfig
      hasLocalRag = 'local-project-rag' in (currentConfig?.mcpServers ?? {})
    } catch {
      // File exists but is invalid JSON
    }
  }

  return { exists, currentConfig, hasLocalRag }
}

export function registerCursorRoutes(app: FastifyInstance): void {
  const mcpConfigPath = getCursorMcpPath()
  const projectRoot = getProjectRoot()

  // GET /cursor/config — Show current MCP server config info
  app.get('/cursor/config', { preHandler: [requireAuth] }, async () => {
    const { exists, hasLocalRag } = getConfigInfo(mcpConfigPath)

    const mcpCommand = 'node'
    const mcpArgs = ['dist/index.js']

    return {
      mcpConfigPath,
      projectRoot,
      mcpCommand,
      mcpArgs,
      configExists: exists,
      alreadyConfigured: hasLocalRag,
      mcpConfig: {
        mcpServers: {
          'local-project-rag': {
            command: mcpCommand,
            args: mcpArgs,
            cwd: projectRoot,
            env: {},
          },
        },
      },
    }
  })

  // POST /cursor/setup — Auto-add MCP server to Cursor config
  app.post('/cursor/setup', { preHandler: [requireAuth] }, async (_request, reply) => {
    const cursorDir = join(homedir(), '.cursor')

    // Ensure .cursor directory exists
    if (!existsSync(cursorDir)) {
      mkdirSync(cursorDir, { recursive: true })
    }

    let config: CursorMcpConfig = { mcpServers: {} }
    let backupPath: string | null = null

    // Read existing config or create new
    if (existsSync(mcpConfigPath)) {
      try {
        const raw = await readFile(mcpConfigPath, 'utf-8')
        config = JSON.parse(raw) as CursorMcpConfig
      } catch {
        return reply.code(500).send({
          error: 'Config Error',
          message: 'Existing mcp.json is not valid JSON. Fix it manually or delete it.',
        })
      }

      // Backup existing config
      backupPath = `${mcpConfigPath}.bak`
      await copyFile(mcpConfigPath, backupPath)
    }

    // Add or update local-project-rag entry
    if (!config.mcpServers) {
      config.mcpServers = {}
    }
    config.mcpServers['local-project-rag'] = {
      command: 'node',
      args: ['dist/index.js'],
      cwd: projectRoot,
      env: {},
    }

    // Atomic write: write to temp file in same dir, then rename
    const tmpPath = `${mcpConfigPath}.tmp`
    try {
      await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
      await rename(tmpPath, mcpConfigPath)
    } catch (err) {
      // Clean up temp file on failure
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
      throw err
    }

    return {
      success: true,
      message: 'MCP server added to Cursor config',
      mcpConfigPath,
      backupPath,
    }
  })
}
