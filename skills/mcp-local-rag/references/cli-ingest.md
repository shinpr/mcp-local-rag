# CLI Ingest Reference

## Command

```bash
npx mcp-local-rag ingest [options] <path>
```

## Options

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `--db-path <path>` | `DB_PATH` | `./lancedb/` | LanceDB database path |
| `--base-dir <path>` | `BASE_DIR` | cwd | Base directory for documents |
| `--cache-dir <path>` | `CACHE_DIR` | `./models/` | Model cache directory |
| `--model-name <name>` | `MODEL_NAME` | `Xenova/all-MiniLM-L6-v2` | Embedding model |
| `--max-file-size <n>` | `MAX_FILE_SIZE` | `104857600` | Max file size in bytes |
| `-h, --help` | — | — | Show usage with defaults |

Priority: CLI flags > environment variables > defaults.

## Config Matching

When ingesting into an existing database, options **must match** the MCP server config — especially `--model-name`. Using a different embedding model against an existing database produces vectors in a different space, silently degrading search quality.

## Output

Output goes to stderr. Summary block:

```
--- Ingest Summary ---
Succeeded: 12
Failed:    1
Total chunks: 247
```

- Exit code 0: all succeeded
- Exit code 1: one or more failed
- `SKIPPED (0 chunks)`: empty or too-short file, counted as success

## Supported Formats

Same as MCP tools: `.pdf`, `.docx`, `.txt`, `.md`, `.html`

Directory mode recursively scans for these extensions, excluding `dbPath` and `cacheDir` paths.
