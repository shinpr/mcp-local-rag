// Narrowing helpers shared by the test suite.
//
// Tests are a specification an implementer reads, so a cast that misstates what
// a value actually is teaches a usage that does not hold. Each helper here
// replaces such a cast with either a real check or one named, documented
// exception.

import { expect } from 'vitest'

import { isRecord } from '../utils/type-guards.js'

/**
 * Present a partial stand-in as the full collaborator interface.
 *
 * `Partial<T>` type-checks every member the double DOES provide, so a renamed
 * method or a changed signature fails to compile — which an `as unknown as T`
 * cast does not. It does not check for missing members: `asDouble<T>({})`
 * compiles, and a double missing something the code calls fails at runtime.
 *
 * Prefer a narrower type where the used surface is known and stable — an
 * existing collaborator interface, or `Pick<T, 'method'>`. Reach for this only
 * when the double stands in for a whole collaborator.
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
 * and exposing it publicly would widen the production API for a test.
 *
 * Nothing is verified: `T` is whatever the caller writes, and a wrong shape
 * surfaces only when a member is used. This confines the cast to one place; it
 * does not make it safe. Keep `T` to the members the test actually reads.
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
 * caller declares.
 *
 * `T` is NOT verified against the parsed value: `parseJson<{ count: number }>`
 * of `{"count":"1"}` compiles and returns a lie. Only the fields the test then
 * asserts on are actually checked, so declare `T` as what the test reads and
 * assert on every field whose type the test depends upon.
 */
export function parseJson<T>(text: string): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a JSON payload's shape is only knowable from the assertions that follow
  return JSON.parse(text) as T
}

/** Read a value as an array, failing the test when it is not one. */
export function expectArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true)
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array, received ${String(value)}`)
  }
  return value
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
 * Returns the value itself, not a copy, so identity, inherited properties and
 * non-enumerable ones (`Error.cause`) all read as they do on the original.
 */
export function expectRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object')
  if (!isRecord(value)) {
    throw new Error(`Expected an object, received ${String(value)}`)
  }
  return value
}
