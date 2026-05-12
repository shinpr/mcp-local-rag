// CLI sync subcommand — incremental bulk file synchronization

import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import { DocumentParser } from '../parser/index.js'
import { createSyncPlan, type SyncFileMetadata } from '../utils/sync-utils.js'
import { createEmbedder, createVectorStore } from './common.js'
import { collectFiles, ingestSingleFile, parseArgs, resolveConfig } from './ingest.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig } from './options.js'

// ============================================
// Help
// ============================================

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

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the sync CLI subcommand.
 */
export async function runSync(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Reuse ingest argument parsing
  const { positional, options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Validate positional argument
  if (!positional) {
    console.error('Usage: mcp-local-rag sync [options] <path>')
    console.error('  Incrementally synchronize a directory with the database.')
    process.exit(1)
  }

  const targetPath = positional

  // Validate path exists
  try {
    await stat(targetPath)
  } catch {
    console.error(`Error: path does not exist: ${targetPath}`)
    process.exit(1)
  }

  // Resolve config
  const globalConfig = resolveGlobalConfig(globalOptions)
  const config = resolveConfig(globalConfig, options)
  const excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]

  // Initialize components
  const embedder = createEmbedder(globalConfig)
  const vectorStore = createVectorStore(globalConfig)
  await vectorStore.initialize()

  // 1. Get Disk State
  const diskFileInfos = await collectFiles(targetPath, excludePaths)
  const diskFiles = new Map<string, SyncFileMetadata>(
    diskFileInfos.map((f) => [f.filePath, { fileModifiedAt: f.mtime, fileSize: f.size }])
  )

  // 2. Get DB State
  const dbFiles = await vectorStore.getFileManifest()

  // 3. Create Sync Plan
  const plan = createSyncPlan(diskFiles, dbFiles)

  console.error(`Sync Plan:`)
  console.error(`  - Upsert: ${plan.upsertList.length} file(s) (new or modified)`)
  console.error(`  - Prune:  ${plan.pruneList.length} file(s) (missing on disk)`)
  console.error(`  - Skip:   ${plan.skipList.length} file(s) (unchanged)`)

  if (plan.upsertList.length === 0 && plan.pruneList.length === 0) {
    console.error('\nDatabase is already up to date.')
    return
  }

  // 4. Execute Pruning
  if (plan.pruneList.length > 0) {
    console.error(`\nPruning ${plan.pruneList.length} file(s)...`)
    await vectorStore.deleteFiles(plan.pruneList)
  }

  // 5. Execute Upsert (Ingestion)
  if (plan.upsertList.length > 0) {
    console.error(`\nIngesting ${plan.upsertList.length} file(s)...`)

    const parser = new DocumentParser({
      baseDir: config.baseDir,
      maxFileSize: config.maxFileSize,
    })
    const chunker = new SemanticChunker(
      config.chunkMinLength !== undefined ? { minChunkLength: config.chunkMinLength } : {}
    )

    let succeeded = 0
    let totalChunks = 0

    for (let i = 0; i < plan.upsertList.length; i++) {
      const filePath = plan.upsertList[i]!
      const label = `[${i + 1}/${plan.upsertList.length}]`
      const mtime = diskFiles.get(filePath)?.fileModifiedAt

      try {
        const chunkCount = await ingestSingleFile(
          filePath,
          parser,
          chunker,
          embedder,
          vectorStore,
          mtime
        )
        console.error(`${label} ${filePath} ... OK (${chunkCount} chunks)`)
        succeeded++
        totalChunks += chunkCount
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`${label} ${filePath} ... FAILED: ${reason}`)
      }
    }

    console.error(`\nUpsert complete: ${succeeded} succeeded, ${totalChunks} total chunks.`)
  }

  // Optimize once at end
  await vectorStore.optimize()
  console.error('\nSync complete.')
}
