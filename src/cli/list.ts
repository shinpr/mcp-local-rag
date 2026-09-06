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

/** Lexicographic order, independent of locale. */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  return a > b ? 1 : 0
}

/**
 * One root's scan result. A per-root error does not abort the whole `list`
 * call: one unreadable root must not hide files under the others.
 */
interface ScanRootResult {
  files: string[]
  warnings: string[]
}

/**
 * Delegates traversal to {@link bfsCollectSupportedFiles} and renders the
 * `list`-specific warnings, annotated with `displayPath`.
 */
async function scanRoot(
  root: string,
  excludePaths: string[],
  scope?: string[]
): Promise<ScanRootResult> {
  const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles(
    root,
    excludePaths,
    {
      scope,
    }
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
   * Repeatable `--scope` prefixes in CLI order; multiple flags union.
   * `undefined` means no scope. Trailing-separator equivalence is
   * `scope-match.ts`'s job.
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
 * CLI `list` JSON output, matching the MCP `list_files` response shape:
 * `baseDir` remains the first effective root for single-root clients, each file
 * names its producing root, and `sources` never carries one.
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

/** No positional arguments; an unknown flag exits 1. */
export function parseArgs(args: string[]): ParsedArgs {
  const options: ListCliOptions = {}
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i] ?? ''
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

  // Resolver errors exit non-zero and do NOT fall back. Warnings go to stderr,
  // so the JSON-only stdout contract survives.
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
    files.sort((a, b) => compareStrings(a.filePath, b.filePath))
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
