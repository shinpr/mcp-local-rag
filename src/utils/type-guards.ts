// Narrowing helpers for values that arrive from outside the type system:
// parsed JSON, third-party library results, and `catch` bindings.
//
// Each one replaces a type assertion with a check the runtime actually
// performs, so the declared type stays true to what was verified.

/** True for any non-null object, narrowing it to an indexable record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * True for anything property access works on, functions included. Use this
 * where the value may be a callable third-party handle rather than a plain
 * object; {@link isRecord} covers the plain-object case.
 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/** True when `value` is one of `list`'s members, narrowing to that union. */
export function isMemberOf<T extends string>(list: readonly T[], value: string): value is T {
  return list.some((member) => member === value)
}

/** True for a finite integer, narrowing `unknown` to `number`. */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * The `code` a Node system error carries (`ENOENT`, `EACCES`, ...), or
 * `undefined` when the caught value is not one.
 */
export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined
  }
  const code = error['code']
  return typeof code === 'string' ? code : undefined
}
