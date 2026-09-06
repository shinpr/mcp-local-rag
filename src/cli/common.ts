// Shared CLI component helpers — factory functions for VectorStore and Embedder
// plus base-directory resolution shared by every subcommand that scans files.

import { Embedder } from '../embedder/index.js'
import {
  type BaseDirsConfig,
  type BaseDirsConfigWarning,
  parseBaseDirsEnv,
  resolveBaseDirs,
} from '../utils/base-dirs.js'
import { getCauseChain } from '../utils/errors.js'
import { checkSensitivePath } from '../utils/sensitive-path.js'
import { VectorStore } from '../vectordb/index.js'
import { type ResolvedGlobalConfig, resolveDevice, resolveDtype, validatePath } from './options.js'

/**
 * Render an unknown caught value for a CLI failure site: every link of the
 * `.cause` chain (via {@link getCauseChain}) followed by its stack, joined so
 * the operator sees the full diagnostic. Deeper links are prefixed
 * `Caused by: `; the outermost link is not.
 *
 * The CLI is operator-facing, so — unlike the MCP client boundary, which never
 * leaks the cause chain — the full chain IS printed (Contract-Delta CLI row:
 * `message` → `message` + cause chain on stderr). Callers keep their own
 * operation prefix and exit-code policy; this function only produces the
 * rendered reason. Single source for the CLI catch-block error-rendering
 * pattern, replacing the former message-only renderer.
 */
export function formatCliError(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error))
  return getCauseChain(err)
    .map((link, index) => {
      const header = index === 0 ? '' : 'Caused by: '
      return `${header}${link.stack || `${link.name}: ${link.message}`}`
    })
    .join('\n')
}

/**
 * Create an uninitialized VectorStore from resolved global config.
 * Callers are responsible for calling initialize() before use.
 */
export function createVectorStore(config: ResolvedGlobalConfig): VectorStore {
  return new VectorStore({
    dbPath: config.dbPath,
    tableName: 'chunks',
  })
}

/**
 * Create an uninitialized Embedder from resolved global config.
 * Callers are responsible for managing the Embedder lifecycle.
 */
export function createEmbedder(config: ResolvedGlobalConfig): Embedder {
  const embedderConfig: ConstructorParameters<typeof Embedder>[0] = {
    modelPath: config.modelName,
    batchSize: 16,
    cacheDir: config.cacheDir,
    device: resolveDevice(process.env['RAG_DEVICE']),
  }
  // Set dtype only when RAG_DTYPE resolves to a defined value, mirroring the
  // server path — an unset RAG_DTYPE leaves config.dtype undefined so the
  // embedder applies its fp32 default.
  const dtype = resolveDtype(process.env['RAG_DTYPE'])
  if (dtype !== undefined) {
    embedderConfig.dtype = dtype
  }
  return new Embedder(embedderConfig)
}

/**
 * Result of {@link resolveCliBaseDirsOrExit}. Resolution warnings travel with
 * the config so subcommands can render them per their own UI contract (CLI
 * subcommands generally write them to stderr).
 */
export interface CliBaseDirsResolution {
  config: BaseDirsConfig
  warnings: BaseDirsConfigWarning[]
}

/**
 * Resolve effective base directories for a CLI subcommand using the shared
 * resolver, surfacing any configuration error as a process-level failure.
 *
 * Inputs (single source of truth for CLI precedence — kept here so per-
 * subcommand entry points don't each replicate the env-fallback chain):
 *  - `cliRoots`: repeated `--base-dir` flag values in CLI order. When non-
 *    empty, REPLACES env roots — no merge.
 *  - `process.env['BASE_DIRS']`: JSON array, used only when CLI roots are
 *    absent.
 *  - `process.env['BASE_DIR']`: single path, used only when CLI roots and
 *    `BASE_DIRS` are absent.
 *  - `process.cwd()`: final fallback.
 *
 * Failure mode: a `BaseDirsConfigError` (invalid `BASE_DIRS` JSON, missing
 * directory, not-a-directory, ...) is reported to stderr and exits with
 * code 1. This is intentional: the resolver explicitly does NOT fall back
 * (see §Technical Decisions → Resolution order in the multi-base-dirs
 * plan), so CLI consumers should fail fast rather than silently degrading
 * to `cwd`.
 *
 * Warnings (`base-dirs-overrides-base-dir`, `nested-root-pruned`) are
 * returned to the caller rather than written here, so each subcommand can
 * decide its own rendering (JSON-output subcommands like `list` may need
 * to keep stderr clean even when warnings are present).
 */
/** Report the first sensitive root among `roots` and stop. */
function exitOnSensitiveRoot(
  roots: readonly string[],
  check: (root: string, flag: string) => string | null | undefined,
  flag: string
): void {
  for (const root of roots) {
    const sensitive = check(root, flag)
    if (sensitive) {
      console.error(sensitive)
      process.exit(1)
    }
  }
}

/**
 * Screen the raw env-supplied roots before the resolver realpath-normalizes
 * them, so a literal `BASE_DIR=/etc` is rejected with the env var as the
 * attribution surface. Malformed `BASE_DIRS` surfaces later via resolveBaseDirs.
 */
function exitOnSensitiveEnvRoots(): void {
  const baseDirs = process.env['BASE_DIRS']
  if (baseDirs !== undefined && baseDirs.length > 0) {
    const parsed = parseBaseDirsEnv(baseDirs)
    if (parsed.ok) {
      exitOnSensitiveRoot(parsed.value, checkSensitivePath, 'BASE_DIRS')
    }
    return
  }
  const baseDir = process.env['BASE_DIR']
  if (baseDir !== undefined && baseDir.trim().length > 0) {
    exitOnSensitiveRoot([baseDir], checkSensitivePath, 'BASE_DIR')
  }
}

export async function resolveCliBaseDirsOrExit(cliRoots: string[]): Promise<CliBaseDirsResolution> {
  // Screen the raw env-supplied paths before the resolver realpath-
  // normalizes them, so a literal `BASE_DIR=/etc` is rejected with the
  // env var as the attribution surface.
  if (cliRoots.length === 0) {
    exitOnSensitiveEnvRoots()
  }

  const result = await resolveBaseDirs({
    cliRoots,
    envBaseDirs: process.env['BASE_DIRS'],
    envBaseDir: process.env['BASE_DIR'],
    cwd: process.cwd(),
  })

  if (!result.ok) {
    console.error(result.error.message)
    process.exit(1)
  }

  // Apply the sensitive-path policy uniformly to every effective root
  // (CLI, env, or cwd). Pre-multi-root code validated `BASE_DIR` here; the
  // same policy must continue to apply to `BASE_DIRS` entries and to CLI
  // roots that pre-validation in the subcommand may have missed (e.g.
  // realpath-resolved targets of symlinks). Reported under `--base-dir`
  // because that is the flag the user most directly controls.
  exitOnSensitiveRoot(result.config.baseDirs, validatePath, '--base-dir')

  return { config: result.config, warnings: result.warnings }
}
