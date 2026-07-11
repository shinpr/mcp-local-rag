// CLI list subcommand — list files and ingestion status

import { resolve, sep } from 'node:path'

import { listDocuments } from '../features/list.js'
import { displayPath } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'
import { nonAbsolutePrefixes } from '../utils/scope-match.js'
import { createVectorStore, formatCliError, resolveCliBaseDirsOrExit } from './common.js'
import type { GlobalOptions } from './options.js'
import {
  consumeBaseDirArg,
  requireFlagValue,
  resolveGlobalConfig,
  validatePath,
} from './options.js'

// ============================================
// Helpers
// ============================================

/**
 * Result of scanning a single root: the supported file paths found plus a
 * non-fatal warning when applicable (depth limit hit, readdir error, ...).
 * Per-root errors do not abort the entire `list` call: one unreadable root
 * must not hide files under the other roots.
 */
interface ScanRootResult {
  files: string[]
  warnings: string[]
}

/**
 * Bounded BFS scan of a single root, up to `MAX_SCAN_DEPTH` levels deep.
 * Delegates the traversal to {@link bfsCollectSupportedFiles} and renders the
 * `list`-specific warnings: per-directory read failures and the depth-limit
 * warning, both annotated with `displayPath`.
 */
async function scanRoot(
  root: string,
  excludePaths: string[],
  scope?: string[]
): Promise<ScanRootResult> {
  // `scope` threads into the walker as the 4th positional arg (after `maxDepth`);
  // pass `undefined` for `maxDepth` to keep the default bound.
  const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles(
    root,
    excludePaths,
    undefined,
    scope
  )

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
  /**
   * Collected `--scope` path prefixes in CLI order. Repeatable: multiple flags
   * union. Each value is trimmed and validated non-empty at parse time.
   * `undefined` means no scope (list every file); trailing-separator
   * equivalence is applied downstream by `scope-match.ts`.
   */
  scope?: string[] | undefined
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
   * both surfaces.
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
 *  - `baseDirs`: every effective root (normal resolve() form, nested-pruned).
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
  --scope <prefix>       Restrict results to a path prefix (must be absolute; a relative prefix matches nothing; repeatable for multiple prefixes)
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
      case '--scope': {
        // Repeatable prefix filter (mirrors `query --scope`). Trim and reject
        // empty/whitespace locally — the same non-empty check `normalizeScope`
        // applies at the MCP boundary, kept module-private there. Trailing-
        // separator equivalence is handled downstream in `scope-match.ts`.
        const value = requireFlagValue(args, i, '--scope').trim()
        if (value.length === 0) {
          console.error('--scope value must not be empty')
          process.exit(1)
        }
        const scope = options.scope ?? []
        scope.push(value)
        options.scope = scope
        i += 2
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

  // A non-absolute `--scope` prefix matches nothing (scan matching is
  // absolute-path based) but silently yields an empty result for that prefix.
  // Surface it as a non-fatal stderr warning without changing result semantics
  // or the exit code — relative is unhelpful, not an error.
  if (options.scope) {
    for (const prefix of nonAbsolutePrefixes(options.scope)) {
      console.error(`Warning [scope]: "${prefix}" is not an absolute path; it matches nothing.`)
    }
  }

  // Scan/display the normal-path roots (`rawBaseDirs`) so scanned paths match
  // the resolve()-stored DB keys; the realpath'd `baseDirs` are the security
  // boundary, not used here. `rawBaseDirs[0]` is the legacy `baseDir` field.
  const rawBaseDirs = baseDirsConfig.rawBaseDirs
  const firstRawBaseDir = rawBaseDirs[0]
  if (firstRawBaseDir === undefined) {
    // Cannot happen in non-degraded mode: the resolver always returns at least
    // one effective root. Surface as a programming error rather than emitting
    // an empty `baseDir` field.
    throw new Error('internal: resolver returned no effective base directories')
  }
  const baseDir = firstRawBaseDir

  const vectorStore = createVectorStore(globalConfig)
  try {
    await vectorStore.initialize()

    // Build exclude paths (resolved to absolute, platform-aware trailing
    // separator). Applied uniformly to every root so dbPath/cacheDir remain
    // excluded under each root even when they happen to live below one of
    // them.
    const excludePaths = [
      `${resolve(globalConfig.dbPath)}${sep}`,
      `${resolve(globalConfig.cacheDir)}${sep}`,
    ]

    const ingested = await vectorStore.listFiles()
    const listed = await listDocuments({
      roots: rawBaseDirs,
      dbPath: globalConfig.dbPath,
      ingested,
      scope: options.scope,
      scan: (root, scope) => scanRoot(root, excludePaths, scope),
    })
    for (const warning of listed.warnings) {
      console.error(`Warning [${warning.baseDir}]: ${warning.message}`)
    }

    const files: FileEntry[] = listed.files
    files.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))
    const sources: SourceEntry[] = listed.sources

    const result: ListResult = {
      baseDirs: [...rawBaseDirs],
      baseDir,
      files,
      sources,
    }

    // Output JSON to stdout
    process.stdout.write(JSON.stringify(result, null, 2))
  } catch (error) {
    const message = formatCliError(error)
    console.error(`Failed to list files: ${message}`)
    process.exitCode = 1
  } finally {
    await vectorStore.close()
  }
}
