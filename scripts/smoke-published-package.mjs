// Smoke-test the PUBLISHED package, installed in isolation, by loading its full
// production import graph using only declared `dependencies`. This catches a
// production module importing an undeclared or dev-only dependency — which
// installs fine here (devDependencies are present) but crashes at a consumer's
// runtime — and any packaging change that breaks module resolution.
//
// Usage: node smoke-published-package.mjs <installDir>
//   <installDir> is a directory where `npm install <tarball>` has been run.
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const installDir = resolve(process.argv[2] ?? '.')
const distRoot = join(installDir, 'node_modules', 'mcp-local-rag', 'dist')

// One entry per production-dependency cluster. server/index.js statically pulls
// jsdom, @mozilla/readability, turndown (html-parser), mammoth (parser),
// @lancedb/lancedb (vectordb) and @huggingface/transformers (embedder).
// pdf-visual/detector.js pulls mupdf, which the parser otherwise imports only
// dynamically on the PDF path.
const entries = ['server/index.js', 'pdf-visual/detector.js']

try {
  await Promise.all(entries.map((e) => import(pathToFileURL(join(distRoot, e)).href)))
  console.log('smoke OK: published package loads all production dependencies')
} catch (err) {
  console.error(`smoke FAIL: ${err.code ?? ''} ${err.message.split('\n')[0]}`)
  process.exit(1)
}
