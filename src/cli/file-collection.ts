// CLI ingest file collection.
//
// Resolves the positional ingest path into the concrete list of supported
// files to ingest. Single-file mode validates the extension; directory mode
// confirms the path is inside a configured root and delegates the bounded
// BFS walk to `bfsCollectSupportedFiles`. Out-of-root directory targets exit
// the process (preserved from the original inline implementation).

import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'

export async function collectFiles(
  targetPath: string,
  baseDirs: readonly string[],
  excludePaths: string[]
): Promise<string[]> {
  const resolved = resolve(targetPath)
  const info = await stat(resolved)

  if (info.isFile()) {
    const ext = extname(resolved).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.error(
        `Unsupported file extension: ${ext} (supported: ${[...SUPPORTED_EXTENSIONS].join(', ')})`
      )
      return []
    }
    return [resolved]
  }

  if (info.isDirectory()) {
    // realpath both sides so a symlinked positional path still matches a
    // root whose realpath agrees. baseDirs from resolveCliBaseDirsOrExit
    // are already realpath-normalized with a trailing sep.
    const realResolved = await realpath(resolved)
    const realResolvedWithSep = realResolved.endsWith(sep) ? realResolved : realResolved + sep
    const insideAnyRoot = baseDirs.some(
      (root) => realResolvedWithSep === root || realResolvedWithSep.startsWith(root)
    )
    if (!insideAnyRoot) {
      console.error(
        `Error: ${targetPath} is not under any configured base directory. ` +
          `Allowed roots: ${baseDirs.join(', ')}. ` +
          `Provide a path inside one of the configured roots, or set BASE_DIRS / --base-dir to include the desired tree.`
      )
      process.exit(1)
    }

    const {
      files: collected,
      unreadableDirs,
      depthLimited,
    } = await bfsCollectSupportedFiles(resolved, excludePaths)

    for (const { dirPath } of unreadableDirs) {
      console.error(`Warning: cannot read directory: ${dirPath}`)
    }

    if (depthLimited) {
      console.error(
        `Warning: some directories were skipped because they exceed the maximum depth (${MAX_SCAN_DEPTH})`
      )
    }

    return [...new Set(collected)].sort()
  }

  return []
}
