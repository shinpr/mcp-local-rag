import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Process management improvements
    testTimeout: 60000,        // 60 second timeout
    hookTimeout: 120000,       // Hook processing timeout 120 seconds
    teardownTimeout: 5000,     // Teardown timeout 5 seconds
    pool: 'forks',             // Use forks instead of threads for onnxruntime-node compatibility
    maxWorkers: 1,             // Single process execution to avoid onnxruntime-node threading issues
    isolate: true,             // Enabled to ensure test isolation and prevent mock leakage
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
    ],
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, './src'),
    },
  },
})