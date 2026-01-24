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
    testTimeout: 10000,        // 10 second timeout
    hookTimeout: 10000,        // Hook processing timeout 10 seconds
    teardownTimeout: 5000,     // Teardown timeout 5 seconds
    pool: 'forks',             // Use forks instead of threads for onnxruntime-node compatibility
    poolOptions: {
      forks: {
        singleFork: true,      // Single process execution to avoid onnxruntime-node threading issues
      }
    },
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, './src'),
    },
  },
})