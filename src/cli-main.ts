// CLI entry point for subcommands (skills install, etc.)
import { run as runSkillsInstall } from './bin/install-skills.js'
import { runIngest } from './cli/ingest.js'
import type { GlobalOptions } from './cli/options.js'

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

    default:
      console.error(`Unknown command: ${subcommand}`)
      console.error('Available commands: skills, ingest')
      process.exit(1)
  }
}
