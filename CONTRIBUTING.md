# Contributing to MCP Local RAG

Contributions welcome! This guide covers what you need to get started.

## Prerequisites

- Node.js >= 22
- [pnpm](https://pnpm.io/)

## Setup

```bash
git clone https://github.com/pradeepgudipati/mcp-local-rag-web.git
cd mcp-local-rag-web
pnpm install
```

The embedding model (~90MB) downloads on first test/run.

## Quality Checks

All PRs must pass the full quality check, which mirrors CI:

```bash
pnpm run check:all
```

This runs the following in order:

| Step | Command | What it checks |
|------|---------|----------------|
| Biome check | `pnpm run check` | Lint + format combined |
| Lint | `pnpm run lint` | Code quality rules |
| Format | `pnpm run format:check` | Code formatting |
| Unused exports | `pnpm run check:unused` | No dead exports |
| Circular deps | `pnpm run check:deps` | No circular dependencies |
| Build | `pnpm run build` | TypeScript compilation |
| Test | `pnpm run test` | All tests pass |

Fix lint/format issues automatically:

```bash
pnpm run check:fix
```

## PR Requirements

Before submitting a pull request:

1. **Add tests** for new features and bug fixes
2. **Run `pnpm run check:all`** and ensure everything passes
3. **Update documentation** if behavior changes
4. **Keep commits focused** — one logical change per PR
5. **Enable "Allow edits from maintainers"** when opening your PR — this lets us push small fixes directly and speeds up the review cycle

## Writing tests

`vitest.config.mjs` runs with `isolate: false`, `pool: 'forks'`, `maxWorkers: 1` — required by `onnxruntime-node`, which keeps native state that vitest's per-file sandbox can't reset. The whole suite therefore shares one module registry.

This affects `vi.mock`. A top-level `vi.mock(path, factory)` registers globally and applies to every other test file that imports the same path — including files that use the real module.

Rule of thumb:

- If the mocked path is touched only in this file, top-level `vi.mock` is fine.
- Otherwise, scope the mock to this file with `vi.doMock` inside `beforeAll` and clear it in `afterAll`. Import the target dynamically after `doMock`, since `doMock` is not hoisted:

```ts
const parserFactory = () => ({ /* ... */ })
const MOCKED_PATHS = ['../../parser/index.js'] as const

let runIngest: typeof import('../../cli/ingest.js').runIngest

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../../parser/index.js', parserFactory)
  ;({ runIngest } = await import('../../cli/ingest.js'))
})

afterAll(() => {
  for (const p of MOCKED_PATHS) vi.doUnmock(p)
  vi.resetModules()
})
```

Live examples: `src/__tests__/cli/ingest-default-mode.test.ts`, `src/__tests__/server/handleIngestFile-side-effects.test.ts`.

## What We Look For

This project's development standards — testing strategy, error handling, code organization, etc. — are published as agent skills:

- Claude Code: [claude-code-workflows/skills](https://github.com/shinpr/claude-code-workflows/tree/main/skills)
- Codex CLI / other Agent Skills–compatible agents: [codex-workflows/.agents/skills](https://github.com/shinpr/codex-workflows/tree/main/.agents/skills)

We share this upfront so you know what to expect in review, not after. You don't need to memorize these — but referencing them (or developing with them loaded into your agent) makes implementation smoother, since review follows the same standards. If feedback feels unexpected, that's where it comes from.

## Project Structure

```
src/
  index.ts        # Entry point
  server/         # MCP tool handlers
  parser/         # Document parsing (PDF, DOCX, TXT, Markdown, HTML)
  chunker/        # Semantic text chunking
  embedder/       # Transformers.js embeddings
  vectordb/       # LanceDB operations
  __tests__/      # Test suites
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
