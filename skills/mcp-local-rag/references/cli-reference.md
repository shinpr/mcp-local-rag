# CLI Reference

Core usage is in SKILL.md. This covers command options, config matching, and output conventions.

## Global Options

Shared across all CLI subcommands.

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `--db-path <path>` | `DB_PATH` | `./lancedb/` | LanceDB database path |
| `--cache-dir <path>` | `CACHE_DIR` | `./models/` | Model cache directory |
| `--model-name <name>` | `MODEL_NAME` | `Xenova/all-MiniLM-L6-v2` | Embedding model |
| `-h, --help` | — | — | Show global usage |

Priority: CLI flags > environment variables > defaults.

## Commands

### ingest

```bash
npx mcp-local-rag [global-options] ingest [options] <path>
```

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `--base-dir <path>` | `BASE_DIR` | cwd | Base directory for documents |
| `--max-file-size <n>` | `MAX_FILE_SIZE` | `104857600` | Max file size in bytes (1–500MB) |

Output to stderr. Exit 0 = all succeeded, exit 1 = one or more failed. `SKIPPED (0 chunks)` = empty or too-short file, counted as success.

### query

```bash
npx mcp-local-rag [global-options] query [--limit <n>] <text>
```

| Option | Default | Description |
|--------|---------|-------------|
| `--limit <n>` | `10` | Max results (1–20) |

Output: JSON array to stdout.

### list

```bash
npx mcp-local-rag [global-options] list [--base-dir <path>]
```

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `--base-dir <path>` | `BASE_DIR` | cwd | Base directory to scan |

Output: JSON to stdout.

### status

```bash
npx mcp-local-rag [global-options] status
```

No options. Output: JSON to stdout.

### delete

```bash
npx mcp-local-rag [global-options] delete [--source <url>] [<file-path>]
```

Either `--source` or `<file-path>`, not both. Idempotent (non-existent target exits 0).

Output: JSON to stdout.

## Config Matching

When operating against an existing database, options must match the MCP server config — especially `--model-name`. Using a different embedding model produces vectors in a different space, silently degrading search quality.
