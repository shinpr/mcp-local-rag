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
