import type { Annotations } from '@modelcontextprotocol/sdk/types.js'

/**
 * Shape of a single MCP content block used by RAG server handlers. Mirrors
 * the SDK's `TextContent` minus the strictly internal fields — defined here
 * (rather than imported) because the SDK exposes the type through a
 * widely-imported union; using a local alias keeps handler signatures stable
 * if the SDK widens the union later.
 */
export type RagContentBlock = {
  type: 'text'
  text: string
  annotations?: Annotations
}

/**
 * Annotations applied to config-warning blocks. The audience covers both
 * the assistant (so it can decide to mention the warning to the user) and
 * the user (so MCP clients that render annotations visibly know to surface
 * it). Priority 0.3 keeps the block secondary to the primary tool result.
 */
const WARNING_ANNOTATIONS: Annotations = {
  audience: ['user', 'assistant'],
  priority: 0.3,
}

/**
 * Annotations applied to the config-error diagnostic block on `status`. The
 * priority is raised relative to a warning because a config error means the
 * server is degraded — `status` is the only tool still callable, and the
 * user needs to see the error message to recover.
 */
const CONFIG_ERROR_ANNOTATIONS: Annotations = {
  audience: ['user', 'assistant'],
  priority: 0.9,
}

/**
 * Build the (zero or one) warning content block for the supplied warnings.
 *
 * Returns `[]` when no warnings exist so the caller can spread the result
 * unconditionally without producing a spurious block. The single emitted
 * block joins all warnings with ` | ` so MCP clients display them together
 * — the per-warning structured form lives in the configuration layer
 * (`BaseDirsConfigWarning`); here we render a single user-facing string.
 *
 * Centralizing this in one helper keeps the warning content shape consistent
 * across handlers. Every handler must use this helper.
 */
function buildConfigWarningBlocks(warnings: readonly string[]): RagContentBlock[] {
  if (warnings.length === 0) return []
  return [
    {
      type: 'text',
      text: `Warning: Tell the user about this configuration issue. ${warnings.join(' | ')}`,
      annotations: WARNING_ANNOTATIONS,
    },
  ]
}

/**
 * Append config-warning blocks to an existing content array. Returns the
 * same `content` reference for chainability (handlers typically build the
 * array first, then call this once before returning).
 */
export function appendConfigWarnings(
  content: RagContentBlock[],
  warnings: readonly string[]
): RagContentBlock[] {
  content.push(...buildConfigWarningBlocks(warnings))
  return content
}

/**
 * Build a diagnostic content block exposing the supplied config-error
 * message. Used by `status` when the server is in degraded mode (invalid
 * `BASE_DIRS`) so the user can read the error via the MCP response without
 * inspecting stderr.
 */
export function buildConfigErrorBlock(message: string): RagContentBlock {
  return {
    type: 'text',
    text: `Configuration error: Tell the user to fix this. ${message}`,
    annotations: CONFIG_ERROR_ANNOTATIONS,
  }
}

/**
 * Format error message based on environment.
 * Shows stack trace in development mode for debugging.
 * Shows only error message in production for security (secure by default).
 */
export function formatErrorMessage(error: unknown): string {
  let err: Error
  if (error instanceof Error) {
    err = error
  } else if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    err = new Error((error as { message: string }).message)
  } else {
    err = new Error(String(error))
  }
  return process.env['NODE_ENV'] === 'development' ? err.stack || err.message : err.message
}
