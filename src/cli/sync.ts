// CLI sync subcommand — foreground incremental reconciliation of the index.
//
// Composition root for `src/features/sync.ts`: this file supplies the real
// collaborators (filesystem, scanner, hasher, store, ingestion) and renders the
// result. Planning, prune eligibility, execution order, and the stop-on-first-
// error policy all live in the core and are not reproduced here — including the
// "inside a configured root" check, which the core answers by composing
// `toSyncPathKey` with the unchanged `isUnderOrEqual`.
//
// The run stays attached to the process until it completes: backgrounding and
// polling belong to the caller (SYNC-005), so there is no daemon, poller, or
// watchdog here.

import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import {
  runSync as runSyncCore,
  type SyncCollaborators,
  type SyncCoverage,
} from '../features/sync.js'
import { computeContentHash } from '../ingest/compute.js'
import { DocumentParser } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles, classifyRequestedPath } from '../utils/scan.js'
import { createEmbedder, createVectorStore, formatCliError } from './common.js'
import { ingestSingleFile, resolveConfig } from './ingest.js'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig } from './options.js'

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] sync [path]

Reconcile the index with the files on disk: ingest new and changed files, leave
unchanged files alone, and remove index entries for files that are gone.

Runs in the foreground until it finishes. Use your shell to run it in the
background.

Arguments:
  <path>                 File or directory inside a configured base directory
                         (default: every configured base directory)

Options:
  -h, --help             Show this help

Base directories come from BASE_DIRS / BASE_DIR (default: current directory).

Global options (must appear before "sync"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

interface SyncArgs {
  help: boolean
  path?: string
}

/**
 * Parse sync-specific CLI arguments: at most one positional path plus -h/--help.
 * Deliberately accepts no other flag — there is no visual, dry-run, or force
 * mode — so an unknown flag prints the usage and exits 1.
 */
function parseArgs(args: string[]): SyncArgs {
  let help = false
  let path: string | undefined

  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`)
      console.error(HELP_TEXT)
      process.exit(1)
    } else if (path !== undefined) {
      console.error(`Unexpected argument: ${arg}`)
      console.error('Only one path is accepted. Omit it to sync every configured base directory.')
      process.exit(1)
    } else {
      path = arg
    }
  }

  const parsed: SyncArgs = { help }
  if (path !== undefined) parsed.path = path
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
 * @param args - Arguments after "sync"
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runSync(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  const globalConfig = resolveGlobalConfig(globalOptions)
  // Shared with `ingest`: base-dir precedence (BASE_DIRS / BASE_DIR / cwd) plus
  // MAX_FILE_SIZE and CHUNK_MIN_LENGTH resolution and validation.
  const config = await resolveConfig(globalConfig)

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
    // The walker's own predicates, so an explicitly requested path is subject to
    // the same rules as a discovered one and is refused before it is read.
    classifyPath: async (path: string) => await classifyRequestedPath(path, excludePaths),
    // No `scope` argument, on purpose: a scope-pruned directory appears in none
    // of the coverage arrays, which would hide an unobserved region and make
    // prune unsafe.
    scanDir: async (rootPath: string) =>
      await bfsCollectSupportedFiles(rootPath, excludePaths, MAX_SCAN_DEPTH),
    // Size first, bytes second: `MAX_FILE_SIZE` is otherwise enforced inside the
    // parser, which runs long after the whole file would already be in memory
    // here. Declining (`null`) keeps the rest of the run usable instead of
    // aborting every future sync of the whole root on one oversized file.
    hashFile: async (filePath: string) => {
      if ((await stat(filePath)).size > config.maxFileSize) return null
      return computeContentHash(await readFile(filePath))
    },
    loadDbManifest: async () => await vectorStore.listChunkHashes(),
    ingestFile: async (filePath: string) =>
      await ingestSingleFile(filePath, parser, chunker, ensureEmbedder(), vectorStore, {
        visual: false,
      }),
    deleteExactPath: async (filePath: string) => await vectorStore.deleteChunks(filePath),
    optimize: async () => {
      await vectorStore.optimize()
    },
  }

  try {
    await vectorStore.initialize()

    const result = await runSyncCore({
      roots: config.baseDirs.rawBaseDirs,
      dbPath: config.dbPath,
      excludePaths,
      platform: process.platform,
      // resolve() (never realpath) so the requested path is spelled like the
      // stored DB keys; the core validates it against the configured roots.
      ...(parsed.path === undefined ? {} : { requestedPath: resolve(parsed.path) }),
      collaborators,
    })

    for (const warning of coverageWarnings(result.coverage, config.maxFileSize)) {
      console.error(warning)
    }

    if (result.error !== null) {
      const { message, filePath } = result.error
      // Scope and existence errors already name the path in the message; a
      // per-file ingest failure ("Missing embedding for chunk 1") does not, and
      // there the suffix is the only thing identifying the file.
      const location = filePath === null || message.includes(filePath) ? '' : ` (${filePath})`
      console.error(`Error: ${message}${location}`)
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
