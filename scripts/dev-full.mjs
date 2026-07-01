import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import waitOn from 'wait-on'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

config({ path: resolve(root, '.env') })

const port = process.env.API_PORT ?? '3939'
const healthUrl = `http://127.0.0.1:${port}/health`
const waitTimeoutMs = Number.parseInt(
  process.env.DEV_API_WAIT_TIMEOUT_MS ?? '180000',
  10,
)

/** @type {import('node:child_process').ChildProcess | undefined} */
let apiProcess
/** @type {import('node:child_process').ChildProcess | undefined} */
let uiProcess
let shuttingDown = false

function spawnPnpm(args) {
  return spawn('pnpm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  })
}

function cleanup(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const proc of [uiProcess, apiProcess]) {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM')
    }
  }

  setTimeout(() => process.exit(exitCode), 100)
}

async function main() {
  console.log(`Starting API server (waiting for ${healthUrl})...`)
  apiProcess = spawnPnpm(['dev:api'])

  apiProcess.on('exit', (code) => {
    if (shuttingDown) return
    if (code !== 0 && code !== null) {
      console.error(`API server exited with code ${code}`)
      cleanup(code)
    }
  })

  try {
    await waitOn({
      resources: [healthUrl],
      timeout: waitTimeoutMs,
      interval: 500,
      verbose: true,
    })
  } catch {
    console.error(
      `API did not become healthy at ${healthUrl} within ${waitTimeoutMs}ms`,
    )
    cleanup(1)
    return
  }

  console.log('API is ready — starting UI...')
  uiProcess = spawnPnpm(['dev:ui'])

  uiProcess.on('exit', (code) => {
    cleanup(code ?? 0)
  })
}

process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

main().catch((error) => {
  console.error(error)
  cleanup(1)
})
