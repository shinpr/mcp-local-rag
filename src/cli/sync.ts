// CLI sync subcommand — incremental bulk file synchronization

import { resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import { DocumentParser } from '../parser/index.js'
import { executeSyncPlan, planSync } from '../utils/sync-runner.js'
import { createEmbedder, createVectorStore } from './common.js'
import { parseArgs, resolveConfig } from './ingest.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig } from './options.js'

const HELP_TEXT = `Usage: mcp-local-rag [global-options] sync [options] <path>

Incrementally synchronize a single file or a directory with the database.
Only changed files will be re-embedded. Deleted files will be pruned.

Options:
  --base-dir <path>        Base directory for documents (default: cwd)
  --max-file-size <n>      Max file size in bytes (default: 104857600)
  --chunk-min-length <n>   Minimum chunk length in characters (default: 50)
  -h, --help               Show this help

Global options (must appear before "sync"):
  --db-path <path>         LanceDB database path
  --cache-dir <path>       Model cache directory
  --model-name <name>      Embedding model`

export async function runSync(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  const { positional, options, help } = parseArgs(args)

  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  if (!positional) {
    console.error('Usage: mcp-local-rag sync [options] <path>')
    console.error('  Incrementally synchronize a directory with the database.')
    process.exit(1)
  }

  const targetPath = positional
  const globalConfig = resolveGlobalConfig(globalOptions)
  const config = resolveConfig(globalConfig, options)
  const excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]

  const embedder = createEmbedder(globalConfig)
  const vectorStore = createVectorStore(globalConfig)
  await vectorStore.initialize()

  const { plan, diskFiles } = await planSync(targetPath, excludePaths, vectorStore)

  console.error(`Sync Plan:`)
  console.error(`  - Upsert: ${plan.upsertList.length} file(s) (new or modified)`)
  console.error(`  - Prune:  ${plan.pruneList.length} file(s) (missing on disk)`)
  console.error(`  - Skip:   ${plan.skipList.length} file(s) (unchanged)`)

  if (plan.upsertList.length === 0 && plan.pruneList.length === 0) {
    console.error('\nDatabase is already up to date.')
    return
  }

  const parser = new DocumentParser({ baseDir: config.baseDir, maxFileSize: config.maxFileSize })
  const chunker = new SemanticChunker(
    config.chunkMinLength !== undefined ? { minChunkLength: config.chunkMinLength } : {}
  )

  const stats = await executeSyncPlan(
    plan,
    diskFiles,
    { vectorStore, parser, chunker, embedder },
    {
      onEvent: (event) => {
        switch (event.type) {
          case 'prune_start':
            console.error(`\nPruning ${event.count} file(s)...`)
            break
          case 'file_start':
            if (event.index === 1) console.error(`\nIngesting ${event.total} file(s)...`)
            break
          case 'file_ok':
            console.error(
              `[${event.index}/${event.total}] ${event.filePath} ... OK (${event.chunkCount} chunks)`
            )
            break
          case 'file_empty':
            console.error(
              `[${event.index}/${event.total}] ${event.filePath} ... SKIPPED (0 chunks)`
            )
            break
          case 'file_failed':
            console.error(
              `[${event.index}/${event.total}] ${event.filePath} ... FAILED: ${event.error}`
            )
            break
        }
      },
    }
  )

  console.error(
    `\nUpsert complete: ${stats.upsertCount} succeeded, ${stats.skippedEmpty} skipped (empty), ${stats.failedCount} failed, ${stats.totalChunks} total chunks.`
  )
  console.error('\nSync complete.')

  if (stats.failedCount > 0) {
    process.exitCode = 1
  }
}
