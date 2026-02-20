/**
 * Format error message based on environment.
 * Shows stack trace in development mode for debugging.
 * Shows only error message in production for security (secure by default).
 */
export function formatErrorMessage(error: unknown): string {
  return process.env['NODE_ENV'] === 'development'
    ? (error as Error).stack || (error as Error).message
    : (error as Error).message
}
