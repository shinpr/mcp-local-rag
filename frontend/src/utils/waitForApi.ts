const API_BASE = '/api'

interface WaitForApiOptions {
  maxAttempts?: number
  initialDelayMs?: number
  retryDelayMs?: number
  backoffMultiplier?: number
  maxRetryDelayMs?: number
}

const DEFAULT_OPTIONS: Required<WaitForApiOptions> = {
  maxAttempts: 12,
  initialDelayMs: 3000,
  retryDelayMs: 2000,
  backoffMultiplier: 1.8,
  maxRetryDelayMs: 10000,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollApiHealth(options: WaitForApiOptions = {}): Promise<boolean> {
  const {
    maxAttempts,
    initialDelayMs,
    retryDelayMs,
    backoffMultiplier,
    maxRetryDelayMs,
  } = { ...DEFAULT_OPTIONS, ...options }

  await sleep(initialDelayMs)

  let delay = retryDelayMs

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${API_BASE}/health`)
      if (response.ok) return true
    } catch {
      // API not ready yet — expected during dev:full startup
    }

    if (attempt < maxAttempts - 1) {
      await sleep(delay)
      delay = Math.min(delay * backoffMultiplier, maxRetryDelayMs)
    }
  }

  return false
}

let apiReadyPromise: Promise<boolean> | null = null

/** Poll /health until the API is reachable (dev startup race). */
export function waitForApiReady(options?: WaitForApiOptions): Promise<boolean> {
  if (!apiReadyPromise) {
    apiReadyPromise = pollApiHealth(options)
  }
  return apiReadyPromise
}
