// Sensitive-path policy shared by the CLI and the MCP server entry point, so
// neither can drift: pre-multi-root code enforced it at the CLI surface only,
// which left `BASE_DIRS=["/etc"]` silently accepted in the server.
//
// Deliberately simple — a small exclusion list of system mount points and
// credential directories under `$HOME`, not a sandbox. `DocumentParser`
// remains the authoritative path-traversal / symlink-escape boundary.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

// Normalize a path for comparison: forward-slash separators throughout and
// lower-case on Windows (case-insensitive filesystem). Used by the security
// boundary checks below so `C:\Users\me\.ssh` and `c:/users/me/.ssh` resolve
// to the same comparable form.
function toComparable(p: string): string {
  const slashed = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

const SENSITIVE_PATH_LITERALS = ['/etc', '/usr', '/sys', '/proc', '/var'] as const

/**
 * The literal prefixes joined with their `realpath`-resolved forms. Without
 * canonicalization macOS would let `/etc` (which realpaths to `/private/etc`)
 * slip past. The literal is always kept, so a realpath failure cannot weaken
 * the policy.
 */
export function buildSensitivePrefixes(
  realpathSyncFn: (p: string) => string = realpathSync
): string[] {
  const set = new Set<string>()
  for (const literal of SENSITIVE_PATH_LITERALS) {
    set.add(literal)
    try {
      const canonical = realpathSyncFn(literal)
      if (typeof canonical === 'string' && canonical.length > 0) {
        set.add(canonical)
      }
    } catch {
      // realpath unavailable on this platform; literal already retained.
    }
  }
  return [...set]
}

const SENSITIVE_PATH_PREFIXES: ReadonlyArray<string> = buildSensitivePrefixes()

/**
 * Directories under `$HOME` that hold credentials and must never be opened
 * as document roots even when the user expands the path themselves.
 */
const SENSITIVE_HOME_PREFIXES = ['.ssh', '.gnupg']

/**
 * Returns a user-facing error string when `value` resolves to a sensitive
 * system or credential directory, `undefined` otherwise.
 *
 * `flagName` is interpolated so the rejection names the surface actually
 * consulted — `--base-dir`, `BASE_DIR`, or `BASE_DIRS`. The trailing-separator
 * check guards against a sibling like `/etcetera`, and both `~/.ssh` and its
 * expanded form are rejected so the policy holds when `$HOME` is unset.
 */
/** True when `pathCmp` is `prefixCmp` itself or sits underneath it. */
function isAtOrUnder(pathCmp: string, prefixCmp: string): boolean {
  return pathCmp === prefixCmp || pathCmp.startsWith(`${prefixCmp}/`)
}

/** True when `value` names one of the sensitive home subdirectories. */
function matchesSensitiveHomeDir(value: string, valueCmp: string, home: string): boolean {
  return SENSITIVE_HOME_PREFIXES.some((dir) => {
    if (home.length > 0 && isAtOrUnder(valueCmp, toComparable(`${home}/${dir}`))) {
      return true
    }
    // Unexpanded `~/...` form — caught even when `home` is empty.
    return value === `~/${dir}` || value.startsWith(`~/${dir}/`)
  })
}

export function checkSensitivePath(value: string, flagName: string): string | undefined {
  const home = process.env['HOME'] || homedir()
  const expanded = value.startsWith('~/') ? `${home}/${value.slice(2)}` : value
  const valueCmp = toComparable(expanded)

  const isSensitive =
    SENSITIVE_PATH_PREFIXES.some((prefix) => isAtOrUnder(valueCmp, toComparable(prefix))) ||
    matchesSensitiveHomeDir(value, valueCmp, home)

  return isSensitive ? `Refusing to use sensitive system path for ${flagName}: ${value}` : undefined
}
