export function getTestDevice(): string {
  return process.env['RAG_DEVICE'] || 'cpu'
}

// Test runners own device selection. Passing through this helper deliberately
// overrides any fixture-local device so CPU/WebGPU runs exercise the same tests.
export function withTestDevice<T extends object>(config: T): T & { device: string } {
  return {
    ...config,
    device: getTestDevice(),
  }
}
