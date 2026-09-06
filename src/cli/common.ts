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
 * Render a caught value for a CLI failure: every `.cause` link with its stack,
 * deeper links prefixed `Caused by: `.
 *
 * The CLI is operator-facing, so unlike the MCP boundary the full chain IS
 * printed. Callers keep their own prefix and exit-code policy.
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
 * Resolve base directories for a CLI subcommand: `cliRoots` replaces the env
 * roots rather than merging, and a config error exits 1 rather than falling
 * back to cwd.
 *
 * Warnings are returned, not printed, so a JSON-output subcommand can keep
 * stderr clean.
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

  // The policy applies to every effective root, whatever its source: a CLI
  // root may be a symlink whose realpath-resolved target the subcommand's
  // pre-validation missed. Reported under `--base-dir`, the flag the user
  // most directly controls.
  exitOnSensitiveRoot(result.config.baseDirs, validatePath, '--base-dir')

  return { config: result.config, warnings: result.warnings }
}
