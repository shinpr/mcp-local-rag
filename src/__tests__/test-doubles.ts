// Narrowing helpers shared by the test suite.
//
// Tests are a specification an implementer reads, so a cast that misstates what
// a value actually is teaches a usage that does not hold. Each helper here
// replaces such a cast with either a real check or one named, documented
// exception.

import { expect } from 'vitest'

/**
 * Present a partial stand-in as the full collaborator interface.
 *
 * A test double implements only the surface the code under test touches, and
 * the type system cannot express "the rest is never called". Unlike an
 * `as unknown as T` cast, `Partial<T>` still checks every member that IS
 * provided, so a renamed method or a changed signature fails to compile. A
 * double missing something the code does call fails as an ordinary runtime
 * error, which is the same signal the cast gave.
 */
export function asDouble<T>(double: Partial<T>): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a partial double is not expressible as the full interface
  return double as T
}

/**
 * Read the private members of an instance under test.
 *
 * Some tests must reach a collaborator the class owns privately — the rollback
 * path is only observable through the server's own `VectorStore`, for example —
 * and exposing it publicly would widen the production API for a test. The cast
 * is confined here so no individual test repeats it.
 */
export function privateMembers<T>(instance: object): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: private members are not expressible in the type system
  return instance as T
}

/** Assert a value is present, returning it narrowed. */
export function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined()
  expect(value).not.toBeNull()
  if (value === null || value === undefined) {
    throw new Error('Expected a defined value')
  }
  return value
}

/** Narrow a caught value to `Error`, failing the test when it is not one. */
export function expectError(value: unknown): Error {
  expect(value).toBeInstanceOf(Error)
  if (!(value instanceof Error)) {
    throw new Error(`Expected an Error, received ${String(value)}`)
  }
  return value
}

/** Narrow a value to `ctor`, failing the test when it is not an instance. */
export function expectInstanceOf<T>(value: unknown, ctor: new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(ctor)
  if (!(value instanceof ctor)) {
    throw new Error(`Expected an instance of ${ctor.name}, received ${String(value)}`)
  }
  return value
}

/**
 * Parse a JSON payload the code under test produced, typed as the shape the
 * assertions read. The shape is exactly what the test asserts about, so a
 * mismatch surfaces on the assertion that follows rather than silently passing.
 */
export function parseJson<T>(text: string): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a JSON payload's shape is only knowable from the assertions that follow
  return JSON.parse(text) as T
}

/** Read a value as a string, failing the test when it is not one. */
export function expectString(value: unknown): string {
  expect(typeof value).toBe('string')
  if (typeof value !== 'string') {
    throw new Error(`Expected a string, received ${String(value)}`)
  }
  return value
}

/**
 * Read a value as an indexable record, failing when it is not an object.
 *
 * Own non-enumerable properties are included, because the values tests reach
 * for this way — `Error.cause` most of all — are defined that way.
 */
export function expectRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object')
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected an object, received ${String(value)}`)
  }
  const record: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') {
      record[key] = Reflect.get(value, key)
    }
  }
  return record
}
