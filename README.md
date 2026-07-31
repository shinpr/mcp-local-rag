<p align="center">
  <img src="assets/banner.jpg" alt="MCP Local RAG — Search below the surface." width="600" />
</p>

# MCP Local RAG

[![GitHub stars](https://img.shields.io/github/stars/shinpr/mcp-local-rag?style=social)](https://github.com/shinpr/mcp-local-rag)
[![npm version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-green.svg)](https://registry.modelcontextprotocol.io/)

Search private documents from an MCP client or the terminal without sending them to an
embedding API.

mcp-local-rag indexes PDF, DOCX, Markdown, and text files on your machine. Search combines
semantic similarity with keyword matching, so queries can match both intent and exact technical
terms such as API names, class names, and error codes.

## Features

- **Runs locally** — document parsing, embeddings, storage, and search run on your machine.
  After the initial model download, text ingestion and search work offline.
- **Hybrid search** — semantic retrieval finds related concepts, while keyword matching boosts
  exact technical terms.
- **Semantic chunking** — documents are split at topic boundaries instead of fixed character
  counts. Markdown code blocks stay intact.
- **MCP and CLI** — use the same index from an AI coding tool or directly from the terminal.

No API key, Docker, Python, or external database is required.

## Quick Start

### Requirements

- Node.js 22 or later
- Internet access on first use to download the npm package and embedding model
- A directory containing the documents you want to search

Set `BASE_DIR` to that directory. It is also the security boundary for file operations. Replace
`/absolute/path/to/your/documents` below with the directory's absolute path.

mcp-local-rag uses the standard MCP protocol over a local stdio server, so it works with AI
coding tools and other MCP hosts that support local MCP servers.

Use one of the examples below, or register `npx -y mcp-local-rag` and set `BASE_DIR` using your
client's MCP configuration format.

**For Claude Code** — Run this command:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/absolute/path/to/your/documents -- npx -y mcp-local-rag
```

**For Codex** — Add to `~/.codex/config.toml`:

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/absolute/path/to/your/documents"
```

**For OpenCode** — Add to `~/.config/opencode/opencode.json` (or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "local-rag": {
      "type": "local",
      "command": ["npx", "-y", "mcp-local-rag"],
      "environment": {
        "BASE_DIR": "/absolute/path/to/your/documents"
      }
    }
  }
}
```

**For Cursor** — Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/absolute/path/to/your/documents"
      }
    }
  }
}
```

Restart the client, then ask it to build the index:

```text
Sync all documents in the configured root and wait until it finishes.
```

The first sync downloads the default embedding model (about 90 MB) and may take 1–2 minutes
before ingestion starts. Later runs use the local cache.

Once the sync completes:

```text
What does the API documentation say about authentication?
```

### CLI Quick Start

To use the CLI without an MCP client:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag query "authentication API"
```

The CLI uses the current directory as its document root by default. Run both commands from the
same directory so they use the same default index, or set `BASE_DIR` and `DB_PATH` explicitly.

## Why This Exists

Some document sets cannot be sent to a hosted embedding service because of confidentiality or
organizational policy. Keeping the index local makes them searchable without adding a per-query
API cost.

Semantic search alone can miss exact identifiers that matter in technical documentation.
Keyword reranking keeps those terms visible without giving up natural-language retrieval.

## Supported Content

| Input | How to ingest |
|---|---|
| PDF, DOCX, TXT, Markdown | File ingestion or directory sync |
| HTML already fetched by the client | `ingest_data`; cleaned with Readability and converted to Markdown |
| Plain text or Markdown held in memory | `ingest_data` with a stable source identifier |

HTML fetching is not built into the server. An MCP client can fetch a page and pass its HTML to
`ingest_data`.

Excel, PowerPoint, standalone images, and source-code file extensions are not supported by file
ingestion. PDFs can optionally use a local vision model to describe figures, but this is not OCR
or image search.

## MCP Tools

| Tool | Purpose |
|---|---|
| `sync_start` | Reconcile the index with all configured roots or one path |
| `sync_status` | Poll a running sync job |
| `ingest_file` | Ingest or replace one file |
| `ingest_data` | Ingest text, Markdown, or HTML already held by the client |
| `query_documents` | Search with semantic matching and keyword boost |
| `read_chunk_neighbors` | Read surrounding chunks from a search result |
| `list_files` | Show supported files and their ingestion state |
| `delete_file` | Delete an indexed file or an `ingest_data` item |
| `status` | Show index and search status |

### Syncing a Document Root

`sync_start` ingests new and changed files, skips byte-identical files, and removes index entries
for files that no longer exist:

```text
Sync everything under the configured document roots and wait for completion.
```

The tool returns a `jobId` immediately. Clients should poll `sync_status` until its state becomes
`succeeded` or `failed`. There is no visual mode during sync; changed PDFs are ingested as text.

Only one sync job is retained by the server process. A newer job replaces a finished record, and
restarting the server discards it.

### Ingesting One File

`ingest_file` accepts PDF, DOCX, TXT, and Markdown. MCP file paths must be absolute and must stay
inside a configured document root:

```text
Ingest the document at /Users/me/docs/api-spec.pdf.
```

Re-ingesting the same path replaces its existing chunks.

### Searching and Reading More Context

```text
What does the API documentation say about authentication?
Find the documented behavior of ERR_CONNECTION_REFUSED.
```

Results contain the text, source path, title, chunk index, and relevance score. Pass the
`chunkIndex` and either `filePath` or `source` from a result to `read_chunk_neighbors` when the
answer needs more context:

```text
Read the surrounding chunks for that authentication result.
```

Both `query_documents` and `list_files` accept an optional absolute `scope` path prefix, or a
list of prefixes. A prefix matches the exact path and its descendants.

### Ingesting HTML

Use `ingest_data` after the MCP client fetches a page:

```text
Fetch https://example.com/docs and ingest the HTML.
```

The server extracts the main article, converts it to Markdown, and stores it under the supplied
source identifier. Reusing the same source updates the existing content.

Respect the source site's terms and copyright when indexing external content.

### PDF Figures

Visual mode adds a generated caption for figure-heavy PDF pages. It is opt-in and does not load
a vision model during normal ingestion.

```text
Ingest /Users/me/docs/research-paper.pdf with visual: true.
```

```bash
npx mcp-local-rag ingest ./docs/research-paper.pdf --visual
```

| Profile | Model cache | Use case |
|---|---:|---|
| `fast` (default) | about 250 MB | Lightweight visual indexing |
| `quality` | about 2.9 GB | Figures containing labels, annotations, or other in-image text |

Select the larger model with `visualQuality: "quality"` over MCP or
`--visual-quality quality` over CLI. Measured CPU inference was about twice as slow as `fast`,
though results depend on hardware and model updates.

Captions are auxiliary text, not faithful transcriptions. Treat retrieved captions and document
text as untrusted input rather than instructions.

## CLI

The CLI uses the same parser, embedder, and vector store without an MCP client:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag sync ./docs/
npx mcp-local-rag query "authentication API"
npx mcp-local-rag query "auth" --scope /docs/api --scope /docs/guide
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5
npx mcp-local-rag list
npx mcp-local-rag status
npx mcp-local-rag delete ./docs/old.pdf
npx mcp-local-rag delete --source "https://example.com/docs"
```

Global options such as `--db-path`, `--cache-dir`, and `--model-name` go before the subcommand.
Subcommand options go after it:

```bash
npx mcp-local-rag --db-path ./my-db query "authentication"
```

Run `npx mcp-local-rag --help` for the complete command reference.

The CLI does not read MCP client configuration. Set the same environment variables or flags if
both interfaces should share an index. In particular, `MODEL_NAME` and the CLI `--model-name`
must match for a shared database.

## Search Tuning

Keyword boost is enabled by default. Relevance-gap grouping and the distance and file filters are
optional controls for corpora that need tighter result selection.

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Keyword boost factor (0.0–1.0). 0 disables keyword reranking; 1 applies the maximum boost. |
| `RAG_GROUPING` | (not set) | `similar` keeps the first relevance group; `related` keeps up to two, using significant vector-distance gaps as boundaries. |
| `RAG_MAX_DISTANCE` | (not set) | Filter out low-relevance results (e.g., `0.5`). |
| `RAG_MAX_FILES` | (not set) | Limit results to top N files (e.g., `1` for single best file). |

For API specifications and other documents containing many identifiers, a stronger keyword
weight can improve exact-term ranking:

```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7"
}
```

- `0.7` — slightly stronger exact-term reranking than the default
- `1.0` — maximum keyword boost

## How It Works

During ingestion:

1. The parser extracts text for the input format.
2. The semantic chunker finds topic boundaries and preserves Markdown code blocks.
3. Transformers.js creates embeddings locally.
4. LanceDB stores the chunks, metadata, vectors, and full-text index.

During search:

1. The query is embedded with the same model.
2. Vector search retrieves semantically related chunks.
3. Optional distance and relevance-group filters narrow the candidates when configured.
4. Full-text matches boost exact query terms.

## Agent Skills

[Agent Skills](https://agentskills.io/) provide query and ingestion guidance for AI assistants:

```bash
npx mcp-local-rag skills install --claude-code
npx mcp-local-rag skills install --claude-code --global
npx mcp-local-rag skills install --codex
```

Installed skills cover query formulation, result refinement, and HTML ingestion. Ask the
assistant to use the mcp-local-rag skill explicitly if it does not activate automatically.

## Configuration

The MCP server reads environment variables. The CLI accepts the same variables plus the listed
flags, with CLI flags taking precedence.

| Environment Variable | CLI Flag | Default | Description |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` | Current directory | One document root; the CLI flag is repeatable on `ingest` and `list` |
| `BASE_DIRS` | — | (unset) | JSON array of document roots; takes precedence over `BASE_DIR` |
| `DB_PATH` | `--db-path` | `./lancedb/` | Vector database location |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Model cache directory |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | Hugging Face embedding model |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100MB) | Maximum file size in bytes |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Minimum chunk length in characters (1–10000) |
| `RAG_DEVICE` | — | `cpu` | ONNX Runtime execution device |
| `RAG_DTYPE` | — | `fp32` | Embedding dtype supplied by the selected model |

### Document Roots (`BASE_DIR` and `BASE_DIRS`)

mcp-local-rag only allows file operations inside configured roots. For multiple roots,
`BASE_DIRS` must be a JSON array of non-empty paths:

```bash
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

Root configuration is resolved in this order:

1. CLI `--base-dir <path>` flags (repeatable on `ingest` and `list`)
2. `BASE_DIRS`
3. `BASE_DIR`
4. Current directory

Each source replaces the lower-priority source rather than merging with it. Invalid `BASE_DIRS`
configuration fails instead of falling back to `BASE_DIR` or the current directory. `status`
remains available in MCP so the client can report the configuration error.

```bash
npx mcp-local-rag ingest --base-dir /Users/me/work --base-dir /Users/me/specs /Users/me/work/readme.md
npx mcp-local-rag list --base-dir /Users/me/work --base-dir /Users/me/specs
BASE_DIRS='["/Users/me/work","/Users/me/specs"]' npx mcp-local-rag list
```

### Storage and Models

`DB_PATH` and `CACHE_DIR` are relative to the process working directory by default. Set absolute
paths when the MCP client may start the server from different project directories.

Changing `MODEL_NAME`, `RAG_DEVICE`, or `RAG_DTYPE` can make existing vectors incompatible.
Use a new `DB_PATH` or delete the existing index and re-ingest after changing the embedding
configuration.

Model examples:

- Multilingual documents: `onnx-community/embeddinggemma-300m-ONNX`
- Scientific papers: `sentence-transformers/allenai-specter`

## Security and Operation

- File access is restricted to `BASE_DIR`, `BASE_DIRS`, or CLI `--base-dir` roots.
- Symlinks that resolve outside every configured root are rejected.
- Document processing and search make no network requests after the required models are cached.
- The server is designed for one local user and does not provide authentication or access control.
- Do not run multiple CLI or MCP writers against the same `DB_PATH`. Read-only queries can run
  while a sync is active.
- Back up an index by copying its `DB_PATH` directory while no writer is active.

<details>
<summary><strong>Troubleshooting</strong></summary>

### "No results found"

Documents must be ingested first. Run `"List all ingested files"` to verify.

### Model download failed

Check internet connection. If behind a proxy, configure network settings. The model can also be [downloaded manually](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

Default limit is 100MB. Split large files or increase `MAX_FILE_SIZE`.

### Slow queries

Check chunk count with `status`. Large documents with many chunks may slow queries. Consider splitting very large files.

### "Path outside BASE_DIR"

Ensure file paths are within one of the configured roots (`BASE_DIR`, any `BASE_DIRS` entry, or any CLI `--base-dir`). Use absolute paths.

### "BASE_DIRS must be a JSON array..."

`BASE_DIRS` accepts a JSON array of one or more non-empty path strings:

- Valid: `BASE_DIRS='["/Users/me/work","/Users/me/specs"]'`
- Invalid: `BASE_DIRS=/a:/b` (delimiter syntax not supported)
- Invalid: `BASE_DIRS='[]'` (empty array)

### MCP client doesn't see tools

1. Verify config file syntax
2. Restart client completely (Cmd+Q on Mac for Cursor)
3. Test directly: `npx mcp-local-rag` should run without errors

</details>

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

## License

MIT License. Free for personal and commercial use.

## Blog Posts

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding) — Technical deep-dive into the semantic chunking and hybrid search design.

## Acknowledgments

Built with [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic, [LanceDB](https://lancedb.com/), and [Transformers.js](https://huggingface.co/docs/transformers.js).
