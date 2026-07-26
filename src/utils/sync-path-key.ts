// Sync-only comparison-key generation.
//
// This module deliberately holds no boundary logic. Containment is delegated to
// the unchanged `isUnderOrEqual` in `scope-match.ts`, composed by the caller as
// `isUnderOrEqual(toSyncPathKey(candidate), toSyncPathKey(prefix))`, so the
// exact-or-descendant, separator-boundary, and trailing-separator semantics
// stay in exactly one place.

import { posix, win32 } from 'node:path'

/**
 * Resolve `path` into the absolute, normalized key sync uses to reconcile disk
 * state against database state. Windows keys are case-folded because its
 * filesystem is case-insensitive; POSIX keys keep their case.
 *
 * `platform` is a parameter rather than a direct `process.platform` read, and it
 * selects the resolver as well as the case-fold, so the Windows branch is
 * provable on a macOS/Linux machine — the host-bound `resolve()` would otherwise
 * turn a Windows path into a cwd-relative POSIX one.
 *
 * Resolution is purely lexical, with no filesystem canonicalization: symbolic
 * links are intentionally not followed, and a path that no longer exists on disk
 * must still yield a key.
 *
 * The key is an internal reconciliation identity. It never replaces the verbatim
 * stored `filePath` spellings used for deletion, nor the shared scope contract
 * used by the query, list, and source-classification flows.
 */
export function toSyncPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return win32.resolve(path).toLowerCase()
  }
  return posix.resolve(path)
}
