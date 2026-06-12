// Test double for `formatCliError`, needed because CLI subcommand tests mock
// `../../cli/common.js` wholesale. Chain-walking delegates to the real
// `getCauseChain` (never mocked) so it can't drift; only the render format is
// re-implemented to mirror production.

import { getCauseChain } from '../../utils/errors.js'

export function formatCliErrorShim(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error))
  return getCauseChain(err)
    .map((link, index) => {
      const header = index === 0 ? '' : 'Caused by: '
      return `${header}${link.stack || `${link.name}: ${link.message}`}`
    })
    .join('\n')
}
