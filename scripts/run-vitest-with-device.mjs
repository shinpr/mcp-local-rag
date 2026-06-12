import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')

const [device, ...rawVitestArgs] = process.argv.slice(2)

if (!device) {
  console.error('Usage: node scripts/run-vitest-with-device.mjs <device> [vitest args...]')
  process.exit(1)
}

const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs')
const vitestArgs = rawVitestArgs.filter((arg) => arg !== '--')
const result = spawnSync(process.execPath, [vitestBin, ...vitestArgs], {
  cwd: repoRoot,
  env: {
    ...process.env,
    RAG_DEVICE: device,
  },
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
