import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Husky is a devDependency; skip when hooks are disabled or husky is not installed
// (e.g. `pnpm install --production`, Docker with --ignore-scripts + HUSKY=0).
if (process.env.HUSKY === '0' || process.env.CI === 'true') {
  process.exit(0)
}

const huskyBin = join(process.cwd(), 'node_modules', '.bin', 'husky')
if (!existsSync(huskyBin)) {
  process.exit(0)
}

execSync('husky', { stdio: 'inherit' })
