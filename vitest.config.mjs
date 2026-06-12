import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Process management improvements
    testTimeout: 10000,
    teardownTimeout: 5000,     // Teardown timeout 5 seconds
    pool: 'forks',             // Use forks instead of threads for onnxruntime-node compatibility
    maxWorkers: 1,             // Single process execution to avoid onnxruntime-node threading issues
    isolate: false,            // Disabled for onnxruntime-node compatibility (re-init crashes in isolated contexts)
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/tmp/**',
    ],
  },
})
