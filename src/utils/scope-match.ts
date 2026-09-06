// Boundary-safe exact-or-descendant prefix matcher, shared by both BFS walkers
// and both list surfaces.
//
// The JS counterpart of `vectordb`'s SQL `buildPrefixPredicate`: same
// exact-or-descendant contract, same separator-boundary and trailing-separator
// normalization. A change to one must be mirrored in the other.

import { isAbsolute, sep as PATH_SEP } from 'node:path'

// A slash identifies slash-style paths even when a legal filename segment
// contains a backslash. Pure backslash-style paths retain Windows support.
function deriveSeparator(prefix: string): string {
  if (prefix.includes('/')) {
    return '/'
  }
  if (prefix.includes('\\')) {
    return '\\'
  }
  return PATH_SEP
}

// Strip trailing separators so `/a/b`, `/a/b/`, `/a/b//` normalize alike. A
// prefix of only separators (e.g. a lone posix root `/`) is kept as a single
// separator so its descendant boundary is `/<sep>` rather than empty.
function stripTrailingSeparators(prefix: string, separator: string): string {
  let end = prefix.length
  while (end > 0 && prefix[end - 1] === separator) {
    end--
  }
  if (end === 0) {
    return separator
  }
  return prefix.slice(0, end)
}

export interface NormalizedScopePrefix {
  exact: string
  descendant: string
}

/** Normalize one scope prefix for both in-memory and LanceDB matching. */
export function normalizeScopePrefix(prefix: string): NormalizedScopePrefix {
  const separator = deriveSeparator(prefix)
  const exact = stripTrailingSeparators(prefix, separator)
  return {
    exact,
    descendant: exact.endsWith(separator) ? exact : exact + separator,
  }
}

/**
 * True when `path` equals `prefix` or descends from it, with a separator
 * boundary so `/foo/bar` does not match `/foo/barista`. Trailing separators on
 * `prefix` are normalized; `path` is compared verbatim, matching the SQL
 * contract in `buildPrefixPredicate`.
 */
export function isUnderOrEqual(path: string, prefix: string): boolean {
  const { exact, descendant } = normalizeScopePrefix(prefix)
  return path === exact || path.startsWith(descendant)
}

/**
 * True when `path` is under-or-equal any prefix in `prefixes` (union). Empty or
 * undefined `prefixes` semantics are the caller's concern; an empty list yields
 * false (membership against no prefixes).
 */
export function matchesAnyScope(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => isUnderOrEqual(path, prefix))
}

/**
 * The prefixes in `scope` that are not absolute paths. Such a prefix matches
 * nothing under the exact-or-descendant contract, so both list surfaces warn
 * while keeping that "matches nothing" result.
 */
export function nonAbsolutePrefixes(scope: string[]): string[] {
  return scope.filter((prefix) => !isAbsolute(prefix))
}

/**
 * Directory-visit predicate for the scoped walk, shared by both walkers. Visit
 * `dir` when there is no scope, when it is in-scope, or when it is an ancestor
 * of a prefix and must be descended to reach the scoped subtree.
 */
export function shouldVisitDir(dir: string, scope?: string[]): boolean {
  if (!scope || scope.length === 0) {
    return true
  }
  return matchesAnyScope(dir, scope) || scope.some((prefix) => isUnderOrEqual(prefix, dir))
}

/**
 * File-collect predicate for the scoped BFS walk, shared by both walkers.
 * Collect `path` when there is no scope, or when `path` is in-scope. An absent
 * or empty `scope` collects every supported file (collection unchanged).
 */
export function isInScope(path: string, scope?: string[]): boolean {
  return !scope || scope.length === 0 || matchesAnyScope(path, scope)
}
