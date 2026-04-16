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

### read-neighbors

```bash
npx mcp-local-rag [global-options] read-neighbors [options]
```

Read N chunks before and after a target chunk within the same document.

| Option | Default | Description |
|--------|---------|-------------|
| `--file-path <abs-path>` | — | File path of ingested content (absolute path) |
| `--source <id>` | — | Source identifier (for content ingested via `ingest_data`) |
| `--chunk-index <n>` | — | Target chunk index (zero-based, required, non-negative integer) |
| `--before <n>` | `2` | Number of chunks before the target (non-negative integer) |
| `--after <n>` | `2` | Number of chunks after the target (non-negative integer) |
| `-h, --help` | — | Show usage |

Defaults: `before=2, after=2` (`grep -C 2` convention).

Either `--source` or `--file-path` is required, not both.

Example:

```bash
npx mcp-local-rag read-neighbors --file-path /abs/path/file.md --chunk-index 12 --before 3 --after 3
```

Output: JSON array to stdout, sorted ascending by `chunkIndex`. Each item includes `filePath`, `chunkIndex`, `text`, `isTarget`, and `fileTitle`. The item whose `chunkIndex` matches the requested value has `isTarget: true`; all other items (and every item when the target chunk does not exist) have `isTarget: false`. Items from documents ingested via `ingest_data` also include a `source` field.

Example output (truncated):

```json
[
  {
    "filePath": "/abs/path/raw-data/example.com/page.md",
    "chunkIndex": 10,
    "text": "Earlier context paragraph...",
    "isTarget": false,
    "fileTitle": "Page Title",
    "source": "https://example.com/page"
  },
  {
    "filePath": "/abs/path/raw-data/example.com/page.md",
    "chunkIndex": 12,
    "text": "Target chunk content...",
    "isTarget": true,
    "fileTitle": "Page Title",
    "source": "https://example.com/page"
  },
  {
    "filePath": "/abs/path/raw-data/example.com/page.md",
    "chunkIndex": 14,
    "text": "Later context paragraph...",
    "isTarget": false,
    "fileTitle": "Page Title",
    "source": "https://example.com/page"
  }
]
```

Out-of-range indices are filtered; only existing chunks within the document are returned. The response can be an empty array.

## Config Matching

When operating against an existing database, options must match the MCP server config — especially `--model-name`. Using a different embedding model produces vectors in a different space, silently degrading search quality.
