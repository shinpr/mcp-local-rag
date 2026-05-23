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
export function checkSensitivePath(value: string, flagName: string): string | undefined {
  const home = process.env['HOME'] || homedir()
  const expanded = value.startsWith('~/') ? `${home}/${value.slice(2)}` : value
  const valueCmp = toComparable(expanded)

  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    const prefixCmp = toComparable(prefix)
    if (valueCmp === prefixCmp || valueCmp.startsWith(`${prefixCmp}/`)) {
      return `Refusing to use sensitive system path for ${flagName}: ${value}`
    }
  }

  for (const dir of SENSITIVE_HOME_PREFIXES) {
    if (home.length > 0) {
      const homePathCmp = toComparable(`${home}/${dir}`)
      if (valueCmp === homePathCmp || valueCmp.startsWith(`${homePathCmp}/`)) {
        return `Refusing to use sensitive system path for ${flagName}: ${value}`
      }
    }
    // Unexpanded `~/...` form — caught even when `home` is empty.
    if (value === `~/${dir}` || value.startsWith(`~/${dir}/`)) {
      return `Refusing to use sensitive system path for ${flagName}: ${value}`
    }
  }

  return undefined
}
