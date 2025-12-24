# MCP Local RAG

[![npm version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Code-aware local RAG for developers using MCP.
Hybrid search (BM25 + semantic) — fully private, zero setup.

## Features

- **Code-aware hybrid search**
  Keyword (BM25) + semantic search combined. Exact terms like `useEffect`, error codes, and class names are matched reliably—not just semantically guessed.

- **Quality-first result filtering**
  Groups results by relevance gaps instead of arbitrary top-K cutoffs. Get fewer but more trustworthy chunks.

- **Runs entirely locally**
  No API keys, no cloud, no data leaving your machine. Works fully offline after the first model download.

- **Zero-friction setup**
  One `npx` command. No Docker, no Python, no servers to manage. Designed for Cursor, Codex, and Claude Code via MCP.

## Quick Start

Set `BASE_DIR` to the folder you want to search. Documents must live under it.

Add the MCP server to your AI coding tool:

**For Cursor** — Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/your/documents"
      }
    }
  }
}
```

**For Codex** — Add to `~/.codex/config.toml`:
```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
```

**For Claude Code** — Run this command:
```bash
claude mcp add local-rag --scope user --env BASE_DIR=/path/to/your/documents -- npx -y mcp-local-rag
```

Restart your tool, then start using it:

```
You: "Ingest api-spec.pdf"
Assistant: Successfully ingested api-spec.pdf (47 chunks created)

You: "What does the API documentation say about authentication?"
Assistant: Based on the documentation, authentication uses OAuth 2.0 with JWT tokens.
          The flow is described in section 3.2...
```

That's it. No installation, no Docker, no complex setup.

## Why This Exists

You want AI to search your documents—technical specs, research papers, internal docs. But most solutions send your files to external APIs.

**Privacy.** Your documents might contain sensitive data. This runs entirely locally.

**Cost.** External embedding APIs charge per use. This is free after the initial model download.

**Offline.** Works without internet after setup.

**Code search.** Pure semantic search misses exact terms like `useEffect` or `ERR_CONNECTION_REFUSED`. Hybrid search catches both meaning and exact matches.

## Usage

The server provides 5 MCP tools: ingest, search, list, delete, status
(`ingest_file`, `query_documents`, `list_files`, `delete_file`, `status`).

### Ingesting Documents

```
"Ingest the document at /Users/me/docs/api-spec.pdf"
```

Supports PDF, DOCX, TXT, and Markdown. The server extracts text, splits it into chunks, generates embeddings locally, and stores everything in a local vector database.

Re-ingesting the same file replaces the old version automatically.

### Searching Documents

```
"What does the API documentation say about authentication?"
"Find information about rate limiting"
"Search for error handling best practices"
```

The hybrid search combines keyword matching (BM25) with semantic search. This means `useEffect` finds documents containing that exact term, not just semantically similar React concepts.

Results include text content, source file, and relevance score. Adjust result count with `limit` (1-20, default 10).

### Managing Files

```
"List all ingested files"          # See what's indexed
"Delete old-spec.pdf from RAG"     # Remove a file
"Show RAG server status"           # Check system health
```

## Search Tuning

Adjust these for your use case:

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Keyword vs semantic balance. Higher = more exact matching. |
| `RAG_GROUPING` | (not set) | `similar` for top group only, `related` for top 2 groups. |
| `RAG_MAX_DISTANCE` | (not set) | Filter out low-relevance results (e.g., `0.5`). |

Example (stricter, code-focused):
```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7",
  "RAG_GROUPING": "similar"
}
```

## How It Works

**TL;DR:**
- Documents are chunked intelligently (overlapping, boundary-aware)
- Each chunk is embedded locally using Transformers.js
- Search uses a weighted combination of BM25 + vector similarity
- Results are filtered based on relevance gaps, not raw scores

### Details

When you ingest a document, the parser extracts text based on file type (PDF via `pdf-parse`, DOCX via `mammoth`, text files directly).

The chunker splits text using LangChain's RecursiveCharacterTextSplitter—breaking on natural boundaries while keeping chunks around 512 characters with 100-character overlap.

Each chunk goes through the Transformers.js embedding model (`all-MiniLM-L6-v2`), converting text into 384-dimensional vectors. Vectors are stored in LanceDB, a file-based vector database requiring no server process.

When you search:
1. Your query becomes a vector using the same model
2. LanceDB performs both BM25 keyword search and vector similarity search
3. Results are combined (default: 60% keyword, 40% semantic)
4. Top matches return with original text and metadata

The keyword-heavy default works well for developer documentation where exact terms matter.

<details>
<summary><strong>Configuration</strong></summary>

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_DIR` | Current directory | Document root directory (security boundary) |
| `DB_PATH` | `./lancedb/` | Vector database location |
| `CACHE_DIR` | `./models/` | Model cache directory |
| `MODEL_NAME` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID ([available models](https://huggingface.co/models?library=transformers.js&pipeline_tag=feature-extraction)) |
| `MAX_FILE_SIZE` | `104857600` (100MB) | Maximum file size in bytes |
| `CHUNK_SIZE` | `512` | Characters per chunk |
| `CHUNK_OVERLAP` | `100` | Overlap between chunks |

### Client-Specific Setup

**Cursor** — Global: `~/.cursor/mcp.json`, Project: `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/your/documents"
      }
    }
  }
}
```

**Codex** — `~/.codex/config.toml` (note: must use `mcp_servers` with underscore)

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
```

**Claude Code**:

```bash
claude mcp add local-rag --scope user \
  --env BASE_DIR=/path/to/your/documents \
  -- npx -y mcp-local-rag
```

### First Run

The embedding model (~90MB) downloads on first use. Takes 1-2 minutes, then works offline.

### Security

- **Path restriction**: Only files within `BASE_DIR` are accessible
- **Local only**: No network requests after model download
- **Model source**: Official HuggingFace repository ([verify here](https://huggingface.co/Xenova/all-MiniLM-L6-v2))

</details>

<details>
<summary><strong>Performance</strong></summary>

Tested on MacBook Pro M1 (16GB RAM), Node.js 22:

**Query Speed**: ~1.2 seconds for 10,000 chunks (p90 < 3s)

**Ingestion** (10MB PDF):
- PDF parsing: ~8s
- Chunking: ~2s
- Embedding: ~30s
- DB insertion: ~5s

**Memory**: ~200MB idle, ~800MB peak (50MB file ingestion)

**Concurrency**: Handles 5 parallel queries without degradation.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

### "No results found"

Documents must be ingested first. Run `"List all ingested files"` to verify.

### Model download failed

Check internet connection. If behind a proxy, configure network settings. The model can also be [downloaded manually](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

### "File too large"

Default limit is 100MB. Split large files or increase `MAX_FILE_SIZE`.

### Slow queries

Check chunk count with `status`. Consider increasing `CHUNK_SIZE` to reduce the number of chunks (trade-off: larger chunks may reduce retrieval precision).

### "Path outside BASE_DIR"

Ensure file paths are within `BASE_DIR`. Use absolute paths.

### MCP client doesn't see tools

1. Verify config file syntax
2. Restart client completely (Cmd+Q on Mac for Cursor)
3. Test directly: `npx mcp-local-rag` should run without errors

</details>

<details>
<summary><strong>FAQ</strong></summary>

**Is this really private?**
Yes. After model download, nothing leaves your machine. Verify with network monitoring.

**Can I use this offline?**
Yes, after the first model download (~90MB).

**How does this compare to cloud RAG?**
Cloud services offer better accuracy at scale but require sending data externally. This trades some accuracy for complete privacy and zero runtime cost.

**What file formats are supported?**
PDF, DOCX, TXT, Markdown. Not yet: Excel, PowerPoint, images, HTML.

**Can I change the embedding model?**
Yes, but you must delete your database and re-ingest all documents. Different models produce incompatible vector dimensions.

**GPU acceleration?**
Transformers.js runs on CPU. GPU support is experimental. CPU performance is adequate for most use cases.

**Multi-user support?**
No. Designed for single-user, local access. Multi-user would require authentication/access control.

**How to backup?**
Copy `DB_PATH` directory (default: `./lancedb/`).

</details>

<details>
<summary><strong>Development</strong></summary>

### Building from Source

```bash
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag
npm install
```

### Testing

```bash
npm test              # Run all tests
npm run test:coverage # With coverage
npm run test:watch    # Watch mode
```

### Code Quality

```bash
npm run type-check    # TypeScript check
npm run check:fix     # Lint and format
npm run check:deps    # Circular dependency check
npm run check:all     # Full quality check
```

### Project Structure

```
src/
  index.ts      # Entry point
  server/       # MCP tool handlers
  parser/       # PDF, DOCX, TXT, MD parsing
  chunker/      # Text splitting
  embedder/     # Transformers.js embeddings
  vectordb/     # LanceDB operations
  __tests__/    # Test suites
```

</details>

## Contributing

Contributions welcome. Before submitting a PR:

1. Run tests: `npm test`
2. Check quality: `npm run check:all`
3. Add tests for new features
4. Update docs if behavior changes

## License

MIT License. Free for personal and commercial use.

## Acknowledgments

Built with [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic, [LanceDB](https://lancedb.com/), [Transformers.js](https://huggingface.co/docs/transformers.js), and [LangChain.js](https://js.langchain.com/).
