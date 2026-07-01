#!/usr/bin/env node

/**
 * Stage 0 verification script.
 * Smoke-tests the ingest → query pipeline against temp directories.
 * Usage: node scripts/verify-stage0.mjs
 * Exit 0 = pass, exit 1 = fail.
 */

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = resolve(ROOT, 'tmp/verify-stage0')
const DB = resolve(TMP, 'lancedb')
const DOCS = resolve(TMP, 'docs')

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 }).trim()
}

try {
  // Setup
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(DOCS, { recursive: true })

  writeFileSync(
    resolve(DOCS, 'sample.txt'),
    'TypeScript provides static type checking at compile time. ' +
      'It catches common bugs before runtime and improves developer tooling. ' +
      'TypeScript is widely adopted in large-scale applications.'
  )

  console.log('[verify-stage0] Ingesting sample document...')
  run(`pnpm exec tsx src/index.ts --db-path ${DB} ingest ${DOCS}`)
  console.log('[verify-stage0] Ingest OK')

  console.log('[verify-stage0] Querying...')
  const output = run(`pnpm exec tsx src/index.ts --db-path ${DB} query "TypeScript type checking"`)
  const results = JSON.parse(output)

  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Expected non-empty results array, got: ${JSON.stringify(results)}`)
  }

  const topResult = results[0]
  if (!topResult.text || !topResult.text.includes('TypeScript')) {
    throw new Error(`Top result does not contain expected text: ${topResult.text}`)
  }

  console.log(`[verify-stage0] Query OK — ${results.length} results, top score: ${topResult.score}`)
  console.log('[verify-stage0] PASSED')
  process.exit(0)
} catch (err) {
  console.error('[verify-stage0] FAILED:', err.message)
  process.exit(1)
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
