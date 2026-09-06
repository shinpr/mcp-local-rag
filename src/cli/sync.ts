// CLI sync subcommand — foreground incremental reconciliation.
//
// Composition root for `src/features/sync.ts`: supplies the real collaborators
// and renders the result. Planning, prune eligibility, execution order and the
// stop-on-first-error policy all live in the core, including the
// "inside a configured root" check.
//
// The run stays attached to the process: backgrounding and polling belong to
// the caller, so there is no daemon or watchdog here.

import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import {
  formatSyncError,
  runSync as runSyncCore,
  type SyncCollaborators,
  type SyncCoverage,
} from '../features/sync.js'
import { computeContentHash } from '../ingest/compute.js'
import { DocumentParser } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import {
  bfsCollectSupportedFiles,
  canonicalizeRequestedPath,
  classifyRequestedPath,
} from '../utils/scan.js'
import { createEmbedder, createVectorStore, formatCliError } from './common.js'
import { type IngestSingleFileOptions, ingestSingleFile, resolveConfig } from './ingest.js'
import type { GlobalOptions } from './options.js'
import { consumeBaseDirArg, resolveGlobalConfig } from './options.js'

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] sync [options] [path]

Reconcile the index with the files on disk: ingest new and changed files, leave
unchanged files alone, and remove index entries for files that are gone.

Runs in the foreground until it finishes. Use your shell to run it in the
background.

Arguments:
  <path>                 File or directory inside a configured base directory
                         (default: every configured base directory)

Options:
  --base-dir <path>      Document root (repeatable; overrides environment roots)
  --images               Store images for new/changed PDF and DOCX files
  -h, --help             Show this help

Without --base-dir, roots come from BASE_DIRS / BASE_DIR (default: current directory).

Global options (must appear before "sync"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

interface SyncArgs {
  help: boolean
  baseDirs: string[]
  path?: string
  images: boolean
}

/**
 * Parse sync-specific CLI arguments: repeatable roots, at most one positional
 * path, and -h/--help. Unknown flags still print the usage and exit 1.
 */
function parseArgs(args: string[]): SyncArgs {
  let help = false
  const baseDirs: string[] = []
  let path: string | undefined
  let images = false

  let index = 0
  while (index < args.length) {
    const arg = args[index] ?? ''
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        index++
        break
      case '--base-dir': {
        const valueIndex = consumeBaseDirArg(args, index, baseDirs)
        index = valueIndex + 1
        break
      }
      case '--images':
        images = true
        index++
        break
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        if (path !== undefined) {
          console.error(`Unexpected argument: ${arg}`)
          console.error(
            'Only one path is accepted. Omit it to sync every configured base directory.'
          )
          process.exit(1)
        }
        path = arg
        index++
        break
    }
  }

  const parsed: SyncArgs = { help, baseDirs, images }
  if (path !== undefined) {
    parsed.path = path
  }
  return parsed
}

// ============================================
// Reporting
// ============================================

/**
 * Render the scanner's coverage facts as operator warnings. Each unobserved
 * region is why prune was withheld there, so the path is named; the wording
 * itself is not a contract.
 */
function coverageWarnings(coverage: SyncCoverage, maxFileSize: number): string[] {
  return [
    ...coverage.unreadableDirs.map(
      ({ dirPath, code }) =>
        `Warning: cannot read directory (${code}), so its indexed files were kept: ${dirPath}`
    ),
    ...coverage.depthLimitedDirs.map(
      (dirPath) =>
        `Warning: not scanned because it exceeds the maximum depth (${MAX_SCAN_DEPTH}), so its indexed files were kept: ${dirPath}`
    ),
    ...coverage.skippedSymlinks.map(
      (linkPath) =>
        `Warning: symbolic link not followed, so its indexed files were kept: ${linkPath}`
    ),
    ...coverage.oversizedFiles.map(
      (filePath) =>
        `Warning: not read because it exceeds the maximum file size (${maxFileSize} bytes), so its indexed chunks were kept: ${filePath}`
    ),
  ]
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the sync CLI subcommand.
 */
export async function runSync(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  const globalConfig = resolveGlobalConfig(globalOptions)
  // Shared with `ingest`: CLI roots replace BASE_DIRS / BASE_DIR / cwd; an empty
  // array preserves that environment fallback. Size/chunk settings share the
  // same resolution and validation path.
  const config = await resolveConfig(globalConfig, { baseDirs: parsed.baseDirs })

  for (const warning of config.baseDirsWarnings) {
    console.error(warning.message)
  }

  const excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]
  const vectorStore = createVectorStore(globalConfig)
  // The parser's realpath check is the security boundary, so it takes the
  // realpath'd roots; scanning uses the resolve()-only `rawBaseDirs` so scanned
  // paths match the resolve()-stored DB keys (same split as `list`).
  const parser = new DocumentParser({
    baseDirs: config.baseDirs.baseDirs,
    maxFileSize: config.maxFileSize,
  })
  const chunker = new SemanticChunker(
    config.chunkMinLength !== undefined ? { minChunkLength: config.chunkMinLength } : {}
  )

  // Built on the first upsert only: a run with nothing to ingest must not pay
  // for the embedding model.
  let embedder: Embedder | undefined
  const ensureEmbedder = (): Embedder => {
    embedder ??= createEmbedder(globalConfig)
    return embedder
  }

  const collaborators: SyncCollaborators = {
    // The containment boundary for a requested path: the core compares this
    // canonical form against the realpath'd roots, which is the only way to see
    // that an intermediate component is a symbolic link out of the root.
    canonicalizeRequestedPath,
    // The walker's own predicates, so an explicitly requested path is subject to
    // the same rules as a discovered one and is refused before it is read.
    classifyPath: async (path: string) => await classifyRequestedPath(path, excludePaths),
    // No `scope` argument, on purpose: a scope-pruned directory appears in none
    // of the coverage arrays, which would hide an unobserved region and make
    // prune unsafe.
    scanDir: async (rootPath: string) =>
      await bfsCollectSupportedFiles(rootPath, excludePaths, { maxDepth: MAX_SCAN_DEPTH }),
    // Size first, bytes second: `MAX_FILE_SIZE` is otherwise enforced inside
    // the parser, long after the whole file is already in memory here.
    // Declining (`null`) keeps the rest of the run usable rather than aborting
    // every future sync of the root over one oversized file.
    //
    // The bound holds only against a non-racing filesystem: a writer that grows
    // the file between the `stat` and the `readFile` restores the unbounded
    // read. That actor already has local write access as this user and can
    // reach the database directly, so this is a recorded limitation.
    hashFile: async (filePath: string) => {
      if ((await stat(filePath)).size > config.maxFileSize) {
        return null
      }
      return computeContentHash(await readFile(filePath))
    },
    loadDbManifest: async () => await vectorStore.listChunkHashes(),
    // Named as it happens, so a long run shows which file it is on and the
    // counters alone are not the only record of what changed. A zero-chunk file
    // already reports itself from inside `ingestSingleFile`.
    ingestFile: async (filePath: string, images: boolean) => {
      const ingestOptions: IngestSingleFileOptions = images
        ? { visual: false, images: true }
        : { visual: false, images: false }
      const chunkCount = await ingestSingleFile(
        filePath,
        { parser, chunker, embedder: ensureEmbedder(), vectorStore },
        ingestOptions
      )
      if (chunkCount > 0) {
        console.error(`upserted ${filePath} (${chunkCount} chunks)`)
      }
      return chunkCount
    },
    deleteExactPath: async (filePath: string) => await vectorStore.deleteChunks(filePath),
    optimize: async () => {
      await vectorStore.optimize()
    },
  }

  try {
    await vectorStore.initialize()

    const result = await runSyncCore({
      roots: config.baseDirs.rawBaseDirs,
      // The realpath'd counterpart of the same roots, which is what the core
      // decides requested-path containment in (the parser's boundary domain).
      canonicalRoots: config.baseDirs.baseDirs,
      dbPath: config.dbPath,
      excludePaths,
      platform: process.platform,
      // resolve() (never realpath) so the requested path is spelled like the
      // stored DB keys; the core validates it against the configured roots.
      ...(parsed.path === undefined ? {} : { requestedPath: resolve(parsed.path) }),
      ...(parsed.images ? { images: true } : {}),
      collaborators,
    })

    for (const prunedPath of result.prunedPaths) {
      console.error(`pruned ${prunedPath}`)
    }

    for (const warning of coverageWarnings(result.coverage, config.maxFileSize)) {
      console.error(warning)
    }

    if (result.error !== null) {
      console.error(`Error: ${formatSyncError(result.error)}`)
      process.exitCode = 1
      return
    }

    process.stdout.write(
      JSON.stringify({
        upserted: result.upserted,
        skipped: result.skipped,
        empty: result.empty,
        pruned: result.pruned,
      })
    )
  } catch (error) {
    console.error(`Error: ${formatCliError(error)}`)
    process.exitCode = 1
  } finally {
    if (embedder !== undefined) {
      await embedder.dispose()
    }
    await vectorStore.close()
  }
}
