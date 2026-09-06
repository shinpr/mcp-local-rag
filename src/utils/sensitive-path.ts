// Sensitive-path policy shared by the CLI and the MCP server entry point.
//
// Both entry points must refuse to use system or credential directories as
// document roots: pre-multi-root code only enforced this at the CLI surface,
// which left a gap where `BASE_DIRS=["/etc"]` in the MCP server's environment
// would be silently accepted. This module owns the single source of truth
// for the policy so the CLI (`cli/options.ts` and `cli/common.ts`) and the
// server entry point (`server-main.ts`) cannot drift.
//
// The policy is intentionally simple — a small allow-list-by-exclusion of
// system mount points and credential directories under `$HOME`. It is not a
// general-purpose sandboxing mechanism; the parser layer (`DocumentParser`)
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
 * Returns the literal prefixes joined with their `realpath`-resolved forms.
 * Without canonicalization macOS would let `/etc` (which realpaths to
 * `/private/etc`) slip past once the resolver normalizes the path. The
 * literal is always kept so a realpath failure cannot weaken the policy.
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
 * system or credential directory. Returns `undefined` when the path is
 * acceptable.
 *
 * `flagName` is interpolated into the error message so the surfacing
 * surface (CLI flag, env var, ...) is visible at the call site. The CLI uses
 * `'--base-dir'`; the server entry point uses `'BASE_DIR'` or `'BASE_DIRS'`
 * to attribute the rejection to the env var actually consulted.
 *
 * The trailing-separator check on system prefixes guards against sibling
 * paths like `/etcetera`. Both the `~/.ssh` and the expanded form are
 * rejected so the policy holds when `$HOME` is unset.
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
