# MCP Local RAG

A privacy-first document search server that runs entirely on your machine. No API keys, no cloud services, no data leaving your computer.

Built for the Model Context Protocol (MCP), this lets you use Cursor, Codex, Claude Code, or any MCP client to search through your local documents using semantic search—without sending anything to external services.

## Quick Start

Add the MCP server to your AI coding tool. Choose your tool below:

**For Cursor** - Add to `~/.cursor/mcp.json`:
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

**For Codex** - Add to `~/.codex/config.toml`:
```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
```

**For Claude Code** - Run this command:
```bash
claude mcp add local-rag --scope user --env BASE_DIR=/path/to/your/documents -- npx -y mcp-local-rag
```

Restart your tool, then start using:
```
"Ingest api-spec.pdf"
"What does this document say about authentication?"
```

That's it. No installation, no Docker, no complex setup.

## Why This Exists

You want to use AI to search through your documents. Maybe they're technical specs, research papers, internal documentation, or meeting notes. The problem: most solutions require sending your files to external APIs.

This creates three issues:

**Privacy concerns.** Your documents might contain sensitive information—client data, proprietary research, personal notes. Sending them to third-party services means trusting them with that data.

**Cost at scale.** External embedding APIs charge per use. For large document sets or frequent searches, costs add up quickly.

**Network dependency.** If you're offline or have limited connectivity, you can't search your own documents.

This project solves these problems by running everything locally. Documents never leave your machine. The embedding model downloads once, then works offline. And it's free to use as much as you want.

## What You Get

The server provides five tools through MCP:

**Document ingestion** handles PDF, DOCX, TXT, and Markdown files. Point it at a file, and it extracts the text, splits it into searchable chunks, generates embeddings using a local model, and stores everything in a local vector database. If you ingest the same file again, it replaces the old version—no duplicate data.

**Semantic search** lets you query in natural language. Instead of keyword matching, it understands meaning. Ask "how does authentication work" and it finds relevant sections even if they use different words like "login flow" or "credential validation."

**File management** shows what you've ingested and when. You can see how many chunks each file produced and verify everything is indexed correctly.

**File deletion** removes ingested documents from the vector database. When you delete a file, all its chunks and embeddings are permanently removed. This is useful for removing outdated documents or sensitive data you no longer want indexed.

**System status** reports on your database—document count, total chunks, memory usage. Helpful for monitoring performance or debugging issues.

All of this uses:
- **LanceDB** for vector storage (file-based, no server needed)
- **Transformers.js** for embeddings (runs in Node.js, no Python)
- **all-MiniLM-L6-v2** model (384 dimensions, good balance of speed and accuracy)
- **RecursiveCharacterTextSplitter** for intelligent text chunking

The result: query responses typically under 3 seconds on a standard laptop, even with thousands of document chunks indexed.

## First Run

The server starts instantly, but the embedding model downloads **on first use** (when you ingest or search for the first time):
- **Download size**: ~90MB (model files)
- **Disk usage after caching**: ~120MB (includes ONNX runtime cache)
- **Time**: 1-2 minutes on a decent connection
- **First operation delay**: Your initial ingest or search request will wait for the model download to complete

You'll see a message like "Initializing model (downloading ~90MB, may take 1-2 minutes)..." in the console. The model caches in `CACHE_DIR` (default: `./models/`) for offline use.

**Why lazy initialization?** This approach allows the server to start immediately without upfront model loading. You only download when actually needed, making the server more responsive for quick status checks or file management operations.

**Offline Mode**: After first download, works completely offline—no internet required.

## Security

**Path Restriction**: This server only accesses files within your `BASE_DIR`. Any attempt to access files outside this directory (e.g., via `../` path traversal) will be rejected.

**Local Only**: All processing happens on your machine. No network requests are made after the initial model download.

**Model Verification**: The embedding model downloads from HuggingFace's official repository (`Xenova/all-MiniLM-L6-v2`). Verify integrity by checking the [official model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

## Configuration

The server works out of the box with sensible defaults, but you can customize it through environment variables.

### For Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
DB_PATH = "./lancedb"
CACHE_DIR = "./models"
```

**Note:** The section name must be `mcp_servers` (with underscore). Using `mcp-servers` or `mcpservers` will cause Codex to ignore the configuration.

### For Cursor

Add to your Cursor settings:
- **Global** (all projects): `~/.cursor/mcp.json`
- **Project-specific**: `.cursor/mcp.json` in your project root

```json
{
  "mcpServers": {
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/your/documents",
        "DB_PATH": "./lancedb",
        "CACHE_DIR": "./models"
      }
    }
  }
}
```

### For Claude Code

Run in your project directory to enable for that project:

```bash
cd /path/to/your/project
claude mcp add local-rag --env BASE_DIR=/path/to/your/documents -- npx -y mcp-local-rag
```

Or add globally for all projects:

```bash
claude mcp add local-rag --scope user --env BASE_DIR=/path/to/your/documents -- npx -y mcp-local-rag
```

**With additional environment variables:**

```bash
claude mcp add local-rag --scope user \
  --env BASE_DIR=/path/to/your/documents \
  --env DB_PATH=./lancedb \
  --env CACHE_DIR=./models \
  -- npx -y mcp-local-rag
```

### Environment Variables

| Variable | Default | Description | Valid Range |
|----------|---------|-------------|-------------|
| `BASE_DIR` | Current directory | Document root directory. Server only accesses files within this path (prevents accidental system file access). | Any valid path |
| `DB_PATH` | `./lancedb/` | Vector database storage location. Can grow large with many documents. | Any valid path |
| `CACHE_DIR` | `./models/` | Model cache directory. After first download, model stays here for offline use. | Any valid path |
| `MODEL_NAME` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model identifier. Must be Transformers.js compatible. See [available models](https://huggingface.co/models?library=transformers.js&pipeline_tag=feature-extraction&sort=trending). **Note:** Changing models requires re-ingesting all documents as embeddings from different models are incompatible. | HF model ID |
| `MAX_FILE_SIZE` | `104857600` (100MB) | Maximum file size in bytes. Larger files rejected to prevent memory issues. | 1MB - 500MB |
| `CHUNK_SIZE` | `512` | Characters per chunk. Larger = more context but slower processing. | 128 - 2048 |
| `CHUNK_OVERLAP` | `100` | Overlap between chunks. Preserves context across boundaries. | 0 - (CHUNK_SIZE/2) |
| `RAG_MAX_DISTANCE` | (not set) | Maximum distance threshold for search results. Results with distance greater than this value are excluded. Lower values mean stricter filtering (e.g., `0.5` for high relevance only). | Positive number |
| `RAG_GROUPING` | (not set) | Grouping mode for quality filtering. `similar` returns only the most similar group (stops at first distance jump). `related` includes related groups (stops at second distance jump). | `similar` or `related` |

## Usage

**After configuration**, restart your MCP client:
- **Cursor**: Fully quit and relaunch (Cmd+Q on Mac, not just closing windows)
- **Codex**: Restart the IDE/extension
- **Claude Code**: No restart needed—changes apply immediately

The server will appear as available tools that your AI assistant can use.

### Ingesting Documents

**In Cursor**, the Composer Agent automatically uses MCP tools when needed:

```
"Ingest the document at /Users/me/docs/api-spec.pdf"
```

**In Codex CLI**, the assistant automatically uses configured MCP tools when needed:

```bash
codex "Ingest the document at /Users/me/docs/api-spec.pdf into the RAG system"
```

**In Claude Code**, just ask naturally:

```
"Ingest the document at /Users/me/docs/api-spec.pdf"
```

**Path Requirements**: The server requires **absolute paths** to files. Your AI assistant will typically convert natural language requests into absolute paths automatically. The `BASE_DIR` setting restricts access to only files within that directory tree for security, but you must still provide the full path.

The server:
1. Validates the file exists and is under 100MB
2. Extracts text (handling PDF/DOCX/TXT/MD formats)
3. Splits into chunks (512 chars, 100 char overlap)
4. Generates embeddings for each chunk
5. Stores in the vector database

This takes roughly 5-10 seconds per MB on a standard laptop. You'll see a confirmation when complete, including how many chunks were created.

### Searching Documents

Ask questions in natural language:

```
"What does the API documentation say about authentication?"
"Find information about rate limiting"
"Search for error handling best practices"
```

The server:
1. Converts your query to an embedding vector
2. Searches the vector database for similar chunks
3. Returns the top 10 matches with similarity scores (default)

Results include the text content, which file it came from, and a relevance score. Your AI assistant then uses these results to answer your question.

You can adjust the number of results:

```
"Search for database optimization tips, return 5 results"   # Fewer, more precise
"Search for database optimization tips, return 20 results"  # Broader exploration
```

The limit parameter accepts 1-20 results. Recommended: 5 for precision, 10 for balance, 20 for broad exploration.

### Managing Files

See what's indexed:

```
"List all ingested files"
```

This shows each file's path, how many chunks it produced, and when it was ingested.

Delete a file from the database:

```
"Delete /Users/me/docs/old-spec.pdf from the RAG system"
```

This permanently removes the file and all its chunks from the vector database. The operation is idempotent—deleting a file that doesn't exist succeeds without error.

Check system status:

```
"Show the RAG server status"
```

This reports total documents, total chunks, current memory usage, and uptime.

### Re-ingesting Files

If you update a document, ingest it again:

```
"Re-ingest api-spec.pdf with the latest changes"
```

The server automatically deletes old chunks for that file before adding new ones. No duplicates, no stale data.

## Development

### Building from Source

```bash
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag
npm install
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

The test suite includes:
- Unit tests for each component
- Integration tests for the full ingestion and search flow
- Security tests for path traversal protection
- Performance tests verifying query speed targets

### Code Quality

```bash
# Type check
npm run type-check

# Lint and format
npm run check:fix

# Check circular dependencies
npm run check:deps

# Full quality check (runs everything)
npm run check:all
```

### Project Structure

```
src/
  index.ts          # Entry point, starts the MCP server
  server/           # RAGServer class, MCP tool handlers
  parser/           # Document parsing (PDF, DOCX, TXT, MD)
  chunker/          # Text splitting logic
  embedder/         # Embedding generation with Transformers.js
  vectordb/         # LanceDB operations
  __tests__/        # Test suites
```

Each module has clear boundaries:
- **Parser** validates file paths and extracts text
- **Chunker** splits text into overlapping segments
- **Embedder** generates 384-dimensional vectors
- **VectorStore** handles all database operations
- **RAGServer** orchestrates everything and exposes MCP tools

## Performance

**Test Environment**: MacBook Pro M1 (16GB RAM), tested with v0.1.3 on Node.js 22 (January 2025)

**Query Performance**:
- Average: 1.2 seconds for 10,000 indexed chunks (5 results)
- Target: p90 < 3 seconds ✓

**Ingestion Speed** (10MB PDF):
- Total: ~45 seconds
  - PDF parsing: ~8 seconds (17%)
  - Text chunking: ~2 seconds (4%)
  - Embedding generation: ~30 seconds (67%)
  - Database insertion: ~5 seconds (11%)

**Memory Usage**:
- Baseline: ~200MB idle
- Peak: ~800MB when ingesting 50MB file
- Target: < 1GB ✓

**Concurrent Queries**: Handles 5 parallel queries without degradation. LanceDB's async API allows non-blocking operations.

**Note**: Your results will vary based on hardware, especially CPU speed (embeddings run on CPU, not GPU).

## Troubleshooting

### "No results found" when searching

**Cause**: Documents must be ingested before searching.

**Solution**:
1. First ingest documents: `"Ingest /path/to/document.pdf"`
2. Verify ingestion: `"List all ingested files"`
3. Then search: `"Search for [your query]"`

**Common mistake**: Trying to search immediately after configuration without ingesting any documents.

### "Model download failed"

The embedding model downloads from HuggingFace on first use (when you ingest or search for the first time). If you're behind a proxy or firewall, you might need to configure network settings.

**When it happens**: Your first ingest or search operation will trigger the download. If it fails, you'll see a detailed error message with troubleshooting guidance (network issues, disk space, cache corruption).

**What to do**: The error message provides specific recommendations. Common solutions:
1. Check your internet connection and retry the operation
2. Ensure you have sufficient disk space (~120MB needed)
3. If problems persist, delete the cache directory and try again

Alternatively, download the model manually:
1. Visit https://huggingface.co/Xenova/all-MiniLM-L6-v2
2. Download the model files
3. Set CACHE_DIR to where you saved them

### "File too large" error

Default limit is 100MB. For larger files:
- Split them into smaller documents
- Or increase MAX_FILE_SIZE in your config (be aware of memory usage)

### Slow query performance

If queries take longer than expected:
- Check how many chunks you have indexed (`status` command)
- Consider the hardware (embeddings are CPU-intensive)
- Try reducing CHUNK_SIZE to create fewer chunks

### "Path outside BASE_DIR" error

The server restricts file access to BASE_DIR for security. Make sure your file path is within that directory. Check for:
- Correct BASE_DIR setting in your MCP config
- Relative paths vs absolute paths
- Typos in the file path

### MCP client doesn't see the tools

**For Cursor:**
1. Open Settings → Features → Model Context Protocol
2. Verify the server configuration is saved
3. Restart Cursor completely
4. Check the MCP connection status in the status bar

**For Codex CLI:**
1. Check `~/.codex/config.toml` to verify the configuration
2. Ensure the section name is `[mcp_servers.local-rag]` (with underscore)
3. Test the server directly: `npx mcp-local-rag` should run without errors
4. Restart Codex CLI or IDE extension
5. Check for error messages when Codex starts

**For Claude Code:**
1. Run `claude mcp list` to see configured servers
2. Verify the server appears in the list
3. Check `~/.config/claude/mcp_config.json` for syntax errors
4. Test the server directly: `npx mcp-local-rag` should run without errors

**Common issues:**
- Invalid JSON syntax in config files
- Wrong file paths in BASE_DIR setting
- Server binary not found (try global install: `npm install -g mcp-local-rag`)
- Firewall blocking local communication

## How It Works

When you ingest a document, the parser extracts text based on the file type. PDFs use `pdf-parse`, DOCX uses `mammoth`, and text files are read directly.

The chunker then splits the text using LangChain's RecursiveCharacterTextSplitter. It tries to break on natural boundaries (paragraphs, sentences) while keeping chunks around 512 characters. Adjacent chunks overlap by 100 characters to preserve context.

Each chunk goes through the Transformers.js embedding model, which converts text into a 384-dimensional vector representing its semantic meaning. This happens in batches of 8 chunks at a time for efficiency.

Vectors are stored in LanceDB, a columnar vector database that works with local files. No server process, no complex setup. It's just a directory with data files.

When you search, your query becomes a vector using the same model. LanceDB finds the chunks with vectors most similar to your query vector (using cosine similarity). The top matches return to your MCP client with their original text and metadata.

The beauty of this approach: semantically similar text has similar vectors, even if the words are different. "authentication process" and "how users log in" will match each other, unlike keyword search.

## FAQ

**Is this really private?**

Yes. After the initial model download, nothing leaves your machine. You can verify with network monitoring tools—no outbound requests during ingestion or search.

**Can I use this offline?**

Yes, once the model is cached. The first run needs internet to download the model (~90MB), but after that, everything works offline.

**How does this compare to cloud RAG services?**

Cloud services (OpenAI, Pinecone, etc.) typically offer better accuracy and scale. But they require sending your documents externally, ongoing costs, and internet connectivity. This project trades some accuracy for complete privacy and zero runtime cost.

**What file formats are supported?**

Currently supported:
- **PDF**: `.pdf` (uses pdf-parse)
- **Microsoft Word**: `.docx` (uses mammoth, not `.doc`)
- **Plain Text**: `.txt`
- **Markdown**: `.md`, `.markdown`

**Not yet supported**:
- Excel/CSV (`.xlsx`, `.csv`)
- PowerPoint (`.pptx`)
- Images with OCR (`.jpg`, `.png`)
- HTML (`.html`)
- Old Word documents (`.doc`)

Want support for another format? [Open an issue](https://github.com/shinpr/mcp-local-rag/issues/new) with your use case.

**Can I customize the embedding model?**

Yes, set MODEL_NAME to any Transformers.js-compatible model from HuggingFace. Keep in mind that different models have different vector dimensions, so you'll need to rebuild your database if you switch.

**How much does accuracy depend on the model?**

`all-MiniLM-L6-v2` is optimized for English and performs well for technical documentation. For other languages, consider multilingual models like `multilingual-e5-small`. For higher accuracy, try larger models—but expect slower processing.

**What about GPU acceleration?**

Transformers.js runs on CPU by default. GPU support is experimental and varies by platform. For most use cases, CPU performance is adequate (embeddings are reasonably fast even without GPU).

**Can multiple people share a database?**

The current design assumes single-user, local access. For multi-user scenarios, you'd need to implement authentication and access control—both out of scope for this project's privacy-first design.

**How do I back up my data?**

Copy your DB_PATH directory (default: `./lancedb/`). That's your entire vector database. Copy BASE_DIR for your original documents. Both are just files—no special export needed.

## Contributing

Contributions are welcome. Before submitting a PR:

1. Run the test suite: `npm test`
2. Ensure code quality: `npm run check:all`
3. Add tests for new features
4. Update documentation if you change behavior

## License

MIT License - see LICENSE file for details.

Free for personal and commercial use. No attribution required, but appreciated.

## Acknowledgments

Built with:
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- [LanceDB](https://lancedb.com/) for vector storage
- [Transformers.js](https://huggingface.co/docs/transformers.js) by HuggingFace
- [LangChain.js](https://js.langchain.com/) for text splitting

Created as a practical tool for developers who want AI-powered document search without compromising privacy.
