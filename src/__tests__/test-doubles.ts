// Narrowing helpers shared by the test suite.

import { expect } from 'vitest'

import { isRecord } from '../utils/type-guards.js'

/**
 * Present a partial stand-in as the full collaborator interface.
 *
 * Provided members are checked; missing ones are not — `asDouble<T>({})`
 * compiles. Prefer `Pick<T, 'method'>` where the used surface is stable.
 */
export function asDouble<T>(double: Partial<T>): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: a partial double is not expressible as the full interface
  return double as T
}

/**
 * Read the private members of an instance under test, so a test need not widen
 * the production API. Nothing is verified — keep `T` to what the test reads.
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
 * Parse a JSON payload as the shape the caller declares. `T` is not verified,
 * so assert on every field the test depends upon.
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
 * Read a value as an indexable record. Returns the value itself, so identity
 * and non-enumerable members (`Error.cause`) survive.
 */
export function expectRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object')
  if (!isRecord(value)) {
    throw new Error(`Expected an object, received ${String(value)}`)
  }
  return value
}
