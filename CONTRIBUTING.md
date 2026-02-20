# Contributing to MCP Local RAG

Contributions welcome! This guide covers what you need to get started.

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io/)

## Setup

```bash
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag
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

## What We Look For

This project's development standards — testing strategy, error handling, code organization, etc. — are documented in [claude-code-workflows/skills](https://github.com/shinpr/claude-code-workflows/tree/main/skills).

We share this upfront so you know what to expect in review, not after. You don't need to memorize it, but if review feedback feels unexpected, that's where it comes from.

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
