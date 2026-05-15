// CLI entry point for subcommands (skills install, etc.)
import { run as runSkillsInstall } from './bin/install-skills.js'
import { runDelete } from './cli/delete.js'
import { runIngest } from './cli/ingest.js'
import { runList } from './cli/list.js'
import type { GlobalOptions } from './cli/options.js'
import { runQuery } from './cli/query.js'
import { runReadNeighbors } from './cli/read-neighbors.js'
import { runStatus } from './cli/status.js'

export const SUBCOMMANDS = [
  'skills',
  'ingest',
  'list',
  'query',
  'status',
  'delete',
  'read-neighbors',
] as const

export type Subcommand = (typeof SUBCOMMANDS)[number]

/**
 * Handle CLI subcommands. The caller is expected to have already validated
 * `subcommand` against `SUBCOMMANDS`; the union type makes the switch exhaustive.
 * @param subcommand - The validated subcommand name
 * @param args - Arguments following the subcommand (subcommand itself excluded)
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function handleCli(
  subcommand: Subcommand,
  args: string[],
  globalOptions: GlobalOptions = {}
): Promise<void> {
  switch (subcommand) {
    case 'skills':
      if (args[0] === 'install') {
        runSkillsInstall(args.slice(1))
        process.exit(0)
      } else {
        console.error(
          'Unknown skills subcommand. Usage: npx mcp-local-rag skills install [options]'
        )
        console.error('Run "npx mcp-local-rag skills install --help" for more information.')
        process.exit(1)
      }
      break

    case 'ingest':
      await runIngest(args, globalOptions)
      break

    case 'list':
      await runList(args, globalOptions)
      break

    case 'query':
      await runQuery(args, globalOptions)
      break

    case 'status':
      await runStatus(args, globalOptions)
      break

    case 'delete':
      await runDelete(args, globalOptions)
      break

    case 'read-neighbors':
      await runReadNeighbors(args, globalOptions)
      break
  }
}
