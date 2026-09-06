// Shared error taxonomy foundation.
//
// `AppError` is the abstract base every domain error class extends. It carries
// two discriminants — `layer` (which architectural layer raised it) and `kind`
// (the nature of the failure) — so a single boundary mapper can convert errors
// to client codes and to logs without each handler re-deriving identity.
//
// This module is behavior-preserving on its own: it adds the `layer`/`kind`
// metadata and centralizes `cause` storage, while the concrete classes keep
// their existing names, messages, and `cause` semantics.

/** Architectural layer that raised the error. */
export type AppErrorLayer = 'embedder' | 'parser' | 'vectordb' | 'config' | 'pdf-visual'

/** Nature of the failure, independent of layer. */
export type AppErrorKind = 'validation' | 'io' | 'config' | 'internal'

/**
 * Abstract base for every domain error. Stores the `layer`/`kind`
 * discriminants and the originating `cause`, leaving the concrete subclass to
 * own its public constructor signature and its `name`.
 */
export abstract class AppError extends Error {
  readonly layer: AppErrorLayer
  readonly kind: AppErrorKind
  // Declared explicitly so the type is `Error | undefined` (not `unknown`,
  // as on the native `Error.cause`) and assignment honors
  // `exactOptionalPropertyTypes`.
  override readonly cause?: Error

  protected constructor(
    message: string,
    layer: AppErrorLayer,
    kind: AppErrorKind,
    options?: { cause?: Error }
  ) {
    super(message)
    this.layer = layer
    this.kind = kind
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * Narrow a caught value to an `Error` so it can be stored as a `cause`. A
 * non-`Error` is wrapped as `String(value)`, so its text survives in the chain
 * but its structure does not.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Type guard: narrows an unknown value to the shared error taxonomy. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/**
 * Walks the `.cause` chain starting from `error`, returning errors in order
 * `[outer, cause, cause.cause, ...]`. The walk stops at the first link whose
 * `.cause` is not an `Error`. Self-referential chains are guarded against.
 */
export function getCauseChain(error: Error): Error[] {
  const chain: Error[] = []
  const seen = new Set<Error>()
  let current: Error | undefined = error
  while (current !== undefined && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    const next: unknown = current.cause
    current = next instanceof Error ? next : undefined
  }
  return chain
}
