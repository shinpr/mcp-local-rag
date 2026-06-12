import type { Annotations } from '@modelcontextprotocol/sdk/types.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { getCauseChain, isAppError } from '../utils/errors.js'

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
  const err = toError(error)
  return process.env['NODE_ENV'] === 'development' ? err.stack || err.message : err.message
}

/**
 * Coerce an arbitrary thrown value into an `Error`. Preserves a real `Error`
 * unchanged (so its `name`/`cause`/`stack` survive); reconstructs from a
 * `{ message: string }` shape; otherwise stringifies. Centralized so every
 * boundary function shares one normalization rule.
 */
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return new Error((error as { message: string }).message)
  }
  return new Error(String(error))
}

/**
 * Context supplied by each handler to {@link toMcpError}, encoding that
 * handler's client-message policy. `prefix` is the operation prefix applied to
 * the generic/native fallback message (e.g. `'Failed to ingest file'`).
 * Prefix-less handlers (`query_documents`/`list_files`/`status`) omit it.
 */
export type ToMcpErrorContext = {
  prefix?: string
}

/**
 * Build the controlled, type-appropriate message sent to the MCP client.
 *
 * Honors the same secure-by-default environment behavior as
 * {@link formatErrorMessage} (stack only in development), but is the dedicated
 * client-facing API: it never appends the raw `.cause` chain, so internal
 * details cannot leak to the client. Full diagnostics belong in
 * {@link formatErrorForLog} (stderr only).
 */
export function formatErrorForClient(error: unknown): string {
  const err = toError(error)
  return process.env['NODE_ENV'] === 'development' ? err.stack || err.message : err.message
}

/**
 * Build the full diagnostic string for stderr logging: every link of the
 * `.cause` chain (via {@link getCauseChain}) followed by its stack. Never sent
 * to the client — this is the log-side counterpart of
 * {@link formatErrorForClient}.
 */
export function formatErrorForLog(error: unknown): string {
  const err = toError(error)
  return getCauseChain(err)
    .map((link, index) => {
      const header = index === 0 ? '' : 'Caused by: '
      return `${header}${link.stack || `${link.name}: ${link.message}`}`
    })
    .join('\n')
}

/**
 * Log an error to stderr with its operation context and full cause chain.
 * The only side-effecting boundary function — the formatters are pure so they
 * can be composed without emitting logs.
 */
export function logError(context: string, error: unknown): void {
  console.error(`[${context}] ${formatErrorForLog(error)}`)
}

/**
 * Map an arbitrary handler error to an `McpError` for the client boundary.
 *
 * - An existing `McpError` passes through unchanged (preserves hand-built
 *   input-validation codes).
 * - A recognized `AppError` maps by its `kind`: `validation`/`config` →
 *   `InvalidParams`, everything else → `InternalError`. Its own message is used
 *   raw — **no** operation prefix is applied, even when `context.prefix` is set
 *   (e.g. `DatabaseError` stays prefix-less).
 * - Any other value (native `Error` or non-`Error`) maps to `InternalError`,
 *   and `context.prefix`, when present, is prepended to the controlled
 *   client message. The raw cause chain is never included.
 */
export function toMcpError(error: unknown, context: ToMcpErrorContext): McpError {
  if (error instanceof McpError) {
    return error
  }
  if (isAppError(error)) {
    const code =
      error.kind === 'validation' || error.kind === 'config'
        ? ErrorCode.InvalidParams
        : ErrorCode.InternalError
    return new McpError(code, formatErrorForClient(error))
  }
  const message = formatErrorForClient(error)
  const clientMessage = context.prefix !== undefined ? `${context.prefix}: ${message}` : message
  return new McpError(ErrorCode.InternalError, clientMessage)
}
