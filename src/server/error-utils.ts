import type { Annotations } from '@modelcontextprotocol/sdk/types.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { getCauseChain, isAppError } from '../utils/errors.js'
import { isRecord } from '../utils/type-guards.js'

/**
 * The MCP content shapes this server emits. Defined here rather than reusing
 * the SDK's union, so an SDK addition cannot widen handler signatures.
 */
export type RagTextContentBlock = {
  type: 'text'
  text: string
  annotations?: Annotations
}

export type RagImageContentBlock = {
  type: 'image'
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  annotations?: Annotations
}

export type RagContentBlock = RagTextContentBlock | RagImageContentBlock

/**
 * Annotations for config-warning blocks: the audience covers the assistant and
 * the user, and priority 0.3 keeps the block secondary to the tool result.
 */
const WARNING_ANNOTATIONS: Annotations = {
  audience: ['user', 'assistant'],
  priority: 0.3,
}

/**
 * Annotations for the config-error block on `status`. The priority is above a
 * warning's because a degraded server leaves `status` as the only way to recover.
 */
const CONFIG_ERROR_ANNOTATIONS: Annotations = {
  audience: ['user', 'assistant'],
  priority: 0.9,
}

/**
 * The (zero or one) warning content block for the supplied warnings.
 *
 * `[]` when there are none, so a caller can spread it unconditionally. The
 * structured per-warning form lives in the configuration layer; this renders
 * one user-facing string. Every handler must go through here.
 */
function buildConfigWarningBlocks(warnings: readonly string[]): RagContentBlock[] {
  if (warnings.length === 0) {
    return []
  }
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
export function appendConfigWarnings<T extends RagContentBlock[]>(
  content: T,
  warnings: readonly string[]
): T {
  const blocks: RagContentBlock[] = content
  blocks.push(...buildConfigWarningBlocks(warnings))
  return content
}

/**
 * Diagnostic block exposing a config error, so `status` can report a degraded
 * server over MCP without the user inspecting stderr.
 */
export function buildConfigErrorBlock(message: string): RagTextContentBlock {
  return {
    type: 'text',
    text: `Configuration error: Tell the user to fix this. ${message}`,
    annotations: CONFIG_ERROR_ANNOTATIONS,
  }
}

/**
 * Coerce a thrown value into an `Error`, preserving a real one unchanged and
 * reconstructing from a `{ message: string }` shape. One rule for every boundary.
 */
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  if (isRecord(error) && typeof error['message'] === 'string') {
    return new Error(error['message'])
  }
  return new Error(String(error))
}

/**
 * Each handler's client-message policy. `prefix` applies to the native-error
 * fallback message only; prefix-less handlers omit it.
 */
export type ToMcpErrorContext = {
  prefix?: string
}

/**
 * The controlled message sent to the MCP client: only `.message`, regardless
 * of `NODE_ENV`, so no stack or cause chain can leak even in development.
 */
export function formatErrorForClient(error: unknown): string {
  return toError(error).message
}

/**
 * Full diagnostic string for stderr: every `.cause` link with its stack. Never
 * sent to the client — the log-side counterpart of {@link formatErrorForClient}.
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
 * Map a handler error to an `McpError` for the client boundary.
 *
 * An existing `McpError` passes through, preserving hand-built validation
 * codes. A recognized `AppError` maps by `kind` — `validation`/`config` to
 * `InvalidParams`, else `InternalError` — and keeps its own message raw, with
 * NO operation prefix even when `context.prefix` is set. Anything else becomes
 * `InternalError` with the prefix applied. The cause chain is never included.
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
