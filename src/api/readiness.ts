// API readiness state — gates business routes until startup completes

let apiReady = false

export function isApiReady(): boolean {
  return apiReady
}

export function markApiReady(): void {
  apiReady = true
}

/** Reset readiness (for tests). */
export function resetApiReady(): void {
  apiReady = false
}
