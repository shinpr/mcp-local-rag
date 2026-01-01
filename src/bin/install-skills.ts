#!/usr/bin/env node

/**
 * MCP Local RAG Skills Installer
 *
 * Installs skills to various AI coding assistants:
 * - Claude Code (project or global)
 * - OpenAI Codex
 * - Custom path
 *
 * Usage:
 *   npx mcp-local-rag-skills --claude-code          # Project-level
 *   npx mcp-local-rag-skills --claude-code --global # User-level
 *   npx mcp-local-rag-skills --codex                # Codex
 *   npx mcp-local-rag-skills --path /custom/path    # Custom
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ============================================
// Constants
// ============================================

// Skills source directory (relative to dist/bin when compiled)
// dist/bin/install-skills.js -> dist/skills/mcp-local-rag
// But skills are actually in package root: skills/mcp-local-rag
// So from dist/bin, go up twice: ../.. then skills/mcp-local-rag
const SKILLS_SOURCE = resolve(__dirname, '..', '..', 'skills', 'mcp-local-rag')

// Codex home directory (supports CODEX_HOME environment variable)
// https://developers.openai.com/codex/local-config/
const CODEX_HOME = process.env['CODEX_HOME'] || join(homedir(), '.codex')

// Installation targets
const TARGETS = {
  'claude-code-project': './.claude/skills/mcp-local-rag',
  'claude-code-global': join(homedir(), '.claude', 'skills', 'mcp-local-rag'),
  'codex-project': './.codex/skills/mcp-local-rag',
  'codex-global': join(CODEX_HOME, 'skills', 'mcp-local-rag'),
} as const

// ============================================
// CLI Argument Parsing
// ============================================

interface Options {
  target: 'claude-code-project' | 'claude-code-global' | 'codex-project' | 'codex-global' | 'custom'
  customPath?: string
  help: boolean
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    target: 'claude-code-project',
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break

      case '--claude-code':
        // Check for --global flag
        if (args[i + 1] === '--global') {
          options.target = 'claude-code-global'
          i++ // Skip next arg
        } else {
          options.target = 'claude-code-project'
        }
        break

      case '--codex':
        // Check for --project or --global flag
        if (args[i + 1] === '--project') {
          options.target = 'codex-project'
          i++ // Skip next arg
        } else if (args[i + 1] === '--global') {
          options.target = 'codex-global'
          i++ // Skip next arg
        } else {
          // Default to global (matches previous behavior)
          options.target = 'codex-global'
        }
        break

      case '--path': {
        const pathArg = args[i + 1]
        if (!pathArg) {
          console.error('Error: --path requires a path argument')
          process.exit(1)
        }
        options.target = 'custom'
        options.customPath = pathArg
        i++ // Skip next arg
        break
      }

      default:
        if (arg?.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          process.exit(1)
        }
    }
  }

  return options
}

// ============================================
// Help Message
// ============================================

function printHelp(): void {
  console.log(`
MCP Local RAG Skills Installer

Usage:
  npx mcp-local-rag-skills [options]

Options:
  --claude-code          Install to project-level Claude Code skills
                         (./.claude/skills/)

  --claude-code --global Install to user-level Claude Code skills
                         (~/.claude/skills/)

  --codex                Install to user-level Codex skills (default)
                         ($CODEX_HOME/skills/ or ~/.codex/skills/)

  --codex --project      Install to project-level Codex skills
                         (./.codex/skills/)

  --codex --global       Install to user-level Codex skills
                         ($CODEX_HOME/skills/ or ~/.codex/skills/)

  --path <path>          Install to custom path

  --help, -h             Show this help message

Examples:
  npx mcp-local-rag-skills --claude-code
  npx mcp-local-rag-skills --claude-code --global
  npx mcp-local-rag-skills --codex
  npx mcp-local-rag-skills --codex --project
  npx mcp-local-rag-skills --path ./my-skills/
`)
}

// ============================================
// Installation
// ============================================

function getTargetPath(options: Options): string {
  if (options.target === 'custom') {
    if (!options.customPath) {
      console.error('Error: Custom path not specified')
      process.exit(1)
    }
    return resolve(options.customPath, 'mcp-local-rag')
  }

  return TARGETS[options.target]
}

function install(targetPath: string): void {
  // Check source exists
  if (!existsSync(SKILLS_SOURCE)) {
    console.error(`Error: Skills source not found at ${SKILLS_SOURCE}`)
    process.exit(1)
  }

  // Create target directory
  const targetDir = dirname(targetPath)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
    console.log(`Created directory: ${targetDir}`)
  }

  // Copy skills
  cpSync(SKILLS_SOURCE, targetPath, { recursive: true })
  console.log(`Installed skills to: ${targetPath}`)
}

// ============================================
// Main
// ============================================

function main(): void {
  const args = process.argv.slice(2)

  // Default to help if no args
  if (args.length === 0) {
    printHelp()
    process.exit(0)
  }

  const options = parseArgs(args)

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  const targetPath = getTargetPath(options)

  console.log('Installing MCP Local RAG skills...')
  console.log(`Target: ${options.target}`)
  console.log(`Path: ${targetPath}`)
  console.log()

  install(targetPath)

  console.log()
  console.log('Installation complete!')
  console.log()
  console.log('The following skills are now available:')
  console.log('  - mcp-local-rag (SKILL.md)')
  console.log('  - references/html-ingestion.md')
  console.log('  - references/query-optimization.md')
  console.log('  - references/result-refinement.md')
}

main()
