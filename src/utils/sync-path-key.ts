// Sync-only comparison-key generation.
//
// This module deliberately holds no boundary logic. Containment is delegated to
// the unchanged `isUnderOrEqual` in `scope-match.ts`, composed by the caller as
// `isUnderOrEqual(toSyncPathKey(candidate), toSyncPathKey(prefix))`, so the
// exact-or-descendant, separator-boundary, and trailing-separator semantics
// stay in exactly one place.

import { posix, win32 } from 'node:path'

/**
 * Resolve `path` into the absolute, normalized key sync reconciles with.
 * Windows keys are case-folded, POSIX keys keep their case.
 *
 * `platform` is a parameter and selects the resolver as well as the case-fold,
 * so the Windows branch is provable on POSIX — the host-bound `resolve()` would
 * otherwise turn a Windows path into a cwd-relative POSIX one.
 *
 * Purely lexical: symbolic links are not followed, and a path no longer on disk
 * must still yield a key. This is an internal reconciliation identity — never a
 * replacement for the verbatim stored spellings used for deletion.
 */
export function toSyncPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return win32.resolve(path).toLowerCase()
  }
  return posix.resolve(path)
}
