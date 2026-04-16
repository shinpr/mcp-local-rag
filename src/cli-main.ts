// CLI entry point for subcommands (skills install, etc.)
import { run as runSkillsInstall } from './bin/install-skills.js'
import { runDelete } from './cli/delete.js'
import { runIngest } from './cli/ingest.js'
import { runList } from './cli/list.js'
import type { GlobalOptions } from './cli/options.js'
import { runQuery } from './cli/query.js'
import { runReadNeighbors } from './cli/read-neighbors.js'
import { runStatus } from './cli/status.js'

/**
 * Handle CLI subcommands
 * @param args - Command line arguments starting with the subcommand name
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function handleCli(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'skills':
      if (args[1] === 'install') {
        runSkillsInstall(args.slice(2))
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
      await runIngest(args.slice(1), globalOptions)
      break

    case 'list':
      await runList(args.slice(1), globalOptions)
      break

    case 'query':
      await runQuery(args.slice(1), globalOptions)
      break

    case 'status':
      await runStatus(args.slice(1), globalOptions)
      break

    case 'delete':
      await runDelete(args.slice(1), globalOptions)
      break

    case 'read-neighbors':
      await runReadNeighbors(args.slice(1), globalOptions)
      break

    default:
      console.error(`Unknown command: ${subcommand}`)
      console.error(
        'Available commands: skills, ingest, list, query, status, delete, read-neighbors'
      )
      process.exit(1)
  }
}
