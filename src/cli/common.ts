// Shared CLI component helpers — factory functions for VectorStore and Embedder
// plus base-directory resolution shared by every subcommand that scans files.

import { Embedder } from '../embedder/index.js'
import {
  type BaseDirsConfig,
  type BaseDirsConfigWarning,
  parseBaseDirsEnv,
  resolveBaseDirs,
} from '../utils/base-dirs.js'
import { checkSensitivePath } from '../utils/sensitive-path.js'
import { VectorStore } from '../vectordb/index.js'
import { type ResolvedGlobalConfig, resolveDevice, validatePath } from './options.js'

/**
 * Extract a human-readable message from an unknown caught value. Returns
 * `error.message` for `Error` instances and `String(error)` otherwise.
 * Single source for the CLI catch-block error-rendering pattern.
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  return new Embedder({
    modelPath: config.modelName,
    batchSize: 16,
    cacheDir: config.cacheDir,
    device: resolveDevice(process.env['RAG_DEVICE']),
  })
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
export async function resolveCliBaseDirsOrExit(cliRoots: string[]): Promise<CliBaseDirsResolution> {
  // Screen the raw env-supplied paths before the resolver realpath-
  // normalizes them, so a literal `BASE_DIR=/etc` is rejected with the
  // env var as the attribution surface.
  if (cliRoots.length === 0) {
    if (process.env['BASE_DIRS'] !== undefined && process.env['BASE_DIRS'].length > 0) {
      const parsed = parseBaseDirsEnv(process.env['BASE_DIRS'])
      if (parsed.ok) {
        for (const raw of parsed.value) {
          const sensitive = checkSensitivePath(raw, 'BASE_DIRS')
          if (sensitive) {
            console.error(sensitive)
            process.exit(1)
          }
        }
      }
      // Malformed BASE_DIRS surfaces below via resolveBaseDirs.
    } else if (process.env['BASE_DIR'] !== undefined && process.env['BASE_DIR'].trim().length > 0) {
      const sensitive = checkSensitivePath(process.env['BASE_DIR'], 'BASE_DIR')
      if (sensitive) {
        console.error(sensitive)
        process.exit(1)
      }
    }
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
  for (const root of result.config.baseDirs) {
    const sensitive = validatePath(root, '--base-dir')
    if (sensitive) {
      console.error(sensitive)
      process.exit(1)
    }
  }

  return { config: result.config, warnings: result.warnings }
}
