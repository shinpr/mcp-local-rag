import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'

export function getTestDevice(): string {
  return process.env['RAG_DEVICE'] || 'cpu'
}

// Pre-warmed by CI's prepare-models job and scripts/prewarm-embedder-cache.mjs.
const SHARED_MODEL_CACHE = './tmp/models'
const MODEL_NAMESPACE = 'Xenova'

// A cacheDir holding the pre-warmed model so the embedder never hits the network.
// With a path, the model is linked in via a junction (Windows-safe) that rmSync
// removes without touching the shared cache.
export function testModelCacheDir(isolatedPath?: string): string {
  if (!isolatedPath) {
    return SHARED_MODEL_CACHE
  }
  mkdirSync(isolatedPath, { recursive: true })
  const link = resolve(isolatedPath, MODEL_NAMESPACE)
  if (!existsSync(link)) {
    symlinkSync(resolve(SHARED_MODEL_CACHE, MODEL_NAMESPACE), link, 'junction')
  }
  return isolatedPath
}

// Test runners own device selection. Passing through this helper deliberately
// overrides any fixture-local device so CPU/WebGPU runs exercise the same tests.
export function withTestDevice<T extends object>(config: T): T & { device: string } {
  return {
    ...config,
    device: getTestDevice(),
  }
}
