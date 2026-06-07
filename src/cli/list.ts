// CLI list subcommand — list files and ingestion status

import { resolve, sep } from 'node:path'

import { displayPath, legacyBaseDir } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { extractSourceFromPath, looksLikeRawDataPath } from '../utils/raw-data-utils.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'
import { createVectorStore, resolveCliBaseDirsOrExit } from './common.js'
import type { GlobalOptions } from './options.js'
import { consumeBaseDirArg, resolveGlobalConfig, validatePath } from './options.js'

// ============================================
// Helpers
// ============================================

/**
 * Result of scanning a single root: the supported file paths found plus a
 * non-fatal warning when applicable (depth limit hit, readdir error, ...).
 * Per-root errors no longer abort the entire `list` call (Finding #10): one
 * unreadable root must not hide files under the other roots.
 */
interface ScanRootResult {
  files: string[]
  warnings: string[]
}

/**
 * Bounded BFS scan of a single root, up to `MAX_SCAN_DEPTH` levels deep.
 * Delegates the traversal to {@link bfsCollectSupportedFiles} and renders the
 * `list`-specific warnings: per-directory read failures (Finding #10 — one
 * unreadable subtree must not hide files under another root) and the depth-
 * limit warning, both annotated with `displayPath`.
 */
async function scanRoot(root: string, excludePaths: string[]): Promise<ScanRootResult> {
  const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles(root, excludePaths)

  const warnings: string[] = []
  for (const { dirPath, code } of unreadableDirs) {
    warnings.push(`cannot read directory: ${displayPath(dirPath)} (${code})`)
  }
  if (depthLimited) {
    warnings.push(
      `some directories under ${displayPath(root)} were skipped because they exceed the maximum depth (${MAX_SCAN_DEPTH})`
    )
  }

  return { files, warnings }
}

// ============================================
// Types
// ============================================

interface ListCliOptions {
  /**
   * Collected `--base-dir` values in CLI order. Repeatable: each flag
   * occurrence appends one entry. `undefined` means the flag was not
   * provided.
   */
  baseDirs?: string[] | undefined
}

interface ParsedArgs {
  options: ListCliOptions
  help: boolean
}

interface FileEntry {
  filePath: string
  /**
   * Producing root for this file (one of `ListResult.baseDirs`). Mirrors the
   * MCP `list_files` response shape so a single client schema works for
   * both surfaces. Added in Finding #5 (post-launch review).
   */
  baseDir: string
  ingested: boolean
  chunkCount?: number
  timestamp?: string
}

interface SourceEntry {
  source?: string
  filePath?: string
  chunkCount: number
  timestamp: string
}

/**
 * CLI `list` JSON output.
 *
 * Multi-root shape (post-Finding-#5 alignment with the MCP `list_files`
 * response):
 *  - `baseDirs`: every effective root (after realpath + nested-pruning).
 *  - `baseDir`: legacy first-effective-root, preserved so single-root
 *    clients continue to work unchanged.
 *  - `files[].baseDir`: per-file producing root.
 *  - `sources`: raw-data and orphaned DB entries; never annotated with a
 *    producing root (matches the MCP contract).
 */
interface ListResult {
  baseDirs: string[]
  baseDir: string
  files: FileEntry[]
  sources: SourceEntry[]
}

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] list [options]

List files and their ingestion status.

Options:
  --base-dir <path>      Base directory to scan for files (repeatable: pass once per root; default: BASE_DIRS/BASE_DIR env or cwd)
  -h, --help             Show this help

Global options (must appear before "list"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse list-specific CLI arguments.
 * Flags: --base-dir, -h/--help
 * No positional arguments accepted.
 * Unknown flags cause exit(1).
 */
export function parseArgs(args: string[]): ParsedArgs {
  const options: ListCliOptions = {}
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        i++
        break
      case '--base-dir': {
        // Repeatable: each `--base-dir <path>` occurrence appends one entry
        // to `options.baseDirs`. The accumulator is lazily initialized so an
        // absent flag leaves `options.baseDirs` as `undefined`, which the
        // resolver treats as "fall through to env / cwd".
        if (options.baseDirs === undefined) {
          options.baseDirs = []
        }
        const valueIndex = consumeBaseDirArg(args, i, options.baseDirs)
        i = valueIndex + 1
        break
      }
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        console.error(`Unexpected argument: ${arg}`)
        console.error('The list command does not accept positional arguments.')
        process.exit(1)
    }
  }

  return { options, help }
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the list CLI subcommand.
 * @param args - Arguments after "list"
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runList(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Resolve global config
  const globalConfig = resolveGlobalConfig(globalOptions)

  // Validate CLI-supplied paths against the sensitive-path policy BEFORE
  // calling the resolver, so the user sees a `--base-dir`-attributed error
  // without an unnecessary realpath round-trip on a rejected path.
  const cliBaseDirs = options.baseDirs ?? []
  for (const root of cliBaseDirs) {
    const baseDirError = validatePath(root, '--base-dir')
    if (baseDirError) {
      console.error(baseDirError)
      process.exit(1)
    }
  }

  // Resolve effective base directories via the shared CLI resolver
  // (CLI > BASE_DIRS > BASE_DIR > cwd). Resolver errors (invalid BASE_DIRS,
  // missing directory, ...) exit non-zero with a clear stderr message and
  // do NOT fall back. Resolver warnings (`base-dirs-overrides-base-dir`,
  // `nested-root-pruned`) are routed to stderr so the JSON-only stdout
  // contract is preserved.
  const { config: baseDirsConfig, warnings: baseDirsWarnings } =
    await resolveCliBaseDirsOrExit(cliBaseDirs)
  for (const warning of baseDirsWarnings) {
    console.error(warning.message)
  }

  // Scan every effective root (P2-T2). `legacyBaseDir` still surfaces the
  // first effective root as the JSON `baseDir` field for response back-compat;
  // the `list_files` MCP response evolves to add `baseDirs` and per-file
  // annotations in P3-T2, which is intentionally out of scope here.
  const baseDir = legacyBaseDir(baseDirsConfig)

  try {
    // Initialize VectorStore only (no Embedder needed for list)
    const vectorStore = createVectorStore(globalConfig)
    await vectorStore.initialize()

    // Build exclude paths (resolved to absolute, platform-aware trailing
    // separator). Applied uniformly to every root so dbPath/cacheDir remain
    // excluded under each root even when they happen to live below one of
    // them (AC-011).
    const excludePaths = [
      `${resolve(globalConfig.dbPath)}${sep}`,
      `${resolve(globalConfig.cacheDir)}${sep}`,
    ]

    // Get all ingested entries from the vector store
    const ingested = await vectorStore.listFiles()
    const ingestedMap = new Map(ingested.map((f) => [f.filePath, f]))

    // Scan every effective root, recording the producing root for each
    // file path. Disjoint roots can still surface the same file through
    // symlinks or bind mounts; the first-occurrence-wins dedup preserves
    // root iteration order, mirroring the MCP `list_files` contract.
    // Per-root errors are non-fatal (Finding #10): we collect them as stderr
    // warnings and continue with the remaining roots so one unreadable
    // root does not hide the others.
    const fileToRoot = new Map<string, string>()
    for (const root of baseDirsConfig.baseDirs) {
      const { files: perRoot, warnings: rootWarnings } = await scanRoot(root, excludePaths)
      for (const warning of rootWarnings) {
        console.error(`Warning [${root}]: ${warning}`)
      }
      for (const filePath of perRoot) {
        if (!fileToRoot.has(filePath)) {
          fileToRoot.set(filePath, root)
        }
      }
    }
    const baseDirFiles = [...fileToRoot.keys()].sort()
    const baseDirSet = new Set(baseDirFiles)

    // Files with ingestion status and producing-root annotation. The
    // producing root is guaranteed to be present because the path came from
    // the scan above; the non-null assertion below documents the invariant.
    const files: FileEntry[] = baseDirFiles.map((filePath) => {
      const producingRoot = fileToRoot.get(filePath)
      if (producingRoot === undefined) {
        // Cannot happen by construction (the key came from the same map).
        // Surface as a programming error rather than silently shipping an
        // empty `baseDir` field.
        throw new Error(`internal: missing producing root for ${filePath}`)
      }
      const entry = ingestedMap.get(filePath)
      return entry
        ? {
            filePath,
            baseDir: producingRoot,
            ingested: true,
            chunkCount: entry.chunkCount,
            timestamp: entry.timestamp,
          }
        : { filePath, baseDir: producingRoot, ingested: false }
    })

    // Content ingested via ingest_data (web pages, clipboard, etc.) plus any
    // orphaned DB entries whose files no longer exist on disk. Sources are
    // never annotated with a producing root — matches the MCP contract.
    const sources: SourceEntry[] = ingested
      .filter((f) => !baseDirSet.has(f.filePath))
      .map((f) => {
        if (looksLikeRawDataPath(f.filePath)) {
          const source = extractSourceFromPath(f.filePath)
          if (source) return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
        }
        return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
      })

    const result: ListResult = {
      baseDirs: [...baseDirsConfig.baseDirs],
      baseDir,
      files,
      sources,
    }

    // Output JSON to stdout
    process.stdout.write(JSON.stringify(result, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Failed to list files: ${message}`)
    process.exit(1)
  }
}
