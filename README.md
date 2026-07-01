<p align="center">
  <img src="assets/banner.jpg" alt="MCP Local RAG — Search below the surface." width="600" />
</p>

# MCP Local RAG

[![GitHub stars](https://img.shields.io/github/stars/pradeepgudipati/mcp-local-rag-web?style=social)](https://github.com/pradeepgudipati/mcp-local-rag-web)
[![npm version](https://img.shields.io/npm/v/mcp-local-rag.svg)](https://www.npmjs.com/package/mcp-local-rag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-green.svg)](https://registry.modelcontextprotocol.io/)

Local RAG for developers via MCP, CLI, REST API, or Web UI.
Semantic search with keyword boost for exact technical terms — fully private, zero setup.

---

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [System Requirements](#system-requirements)
- [Quick Start](#quick-start)
- [Installation](#installation)
  - [npm (Recommended)](#npm-recommended)
  - [From Source](#from-source)
  - [Docker](#docker)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Document Roots](#document-roots-base_dir-and-base_dirs)
  - [Database Setup](#database-setup)
- [Usage](#usage)
  - [MCP Server](#using-with-mcp)
  - [CLI](#using-as-cli)
  - [REST API](#rest-api)
  - [Web UI](#web-ui)
- [Testing Vector Search](#testing-vector-search)
- [Docker Deployment](#docker-deployment)
- [Search Tuning](#search-tuning)
- [How It Works](#how-it-works)
- [Agent Skills](#agent-skills)
- [Client-Specific Setup](#client-specific-setup)
- [Testing](#testing)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Semantic search with keyword boost**
  Vector search first, then keyword matching boosts exact matches. Terms like `useEffect`, error codes, and class names rank higher—not just semantically guessed.

- **Smart semantic chunking**
  Chunks documents by meaning, not character count. Uses embedding similarity to find natural topic boundaries—keeping related content together and splitting where topics change.

- **Quality-first result filtering**
  Groups results by relevance gaps instead of arbitrary top-K cutoffs. Get fewer but more trustworthy chunks.

- **Runs entirely locally**
  No API keys, no cloud, no data leaving your machine. Works fully offline after the first model download.

- **Zero-friction setup**
  One `npx` command. No Docker, no Python, no servers to manage.
  Use via MCP, CLI, REST API, Web UI, or all four. Optional [Agent Skills](#agent-skills) help AI assistants form better queries and interpret results.

- **Project namespaces**
  Organize documents into projects for multi-tenant search. Five project-scoped MCP tools for structured workflows.

- **Modern web UI**
  React-based dashboard for managing projects, uploading files, triggering indexing, and searching documents—all from your browser.

---

## Architecture Overview

MCP Local RAG provides **four interfaces** to the same underlying RAG engine:

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Local RAG                          │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   MCP    │  │   CLI    │  │ REST API │  │  Web UI  │   │
│  │  Server  │  │          │  │ (Fastify)│  │  (React) │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │         │
│       └──────────────┴──────────────┴──────────────┘        │
│                          │                                   │
│              ┌───────────┴───────────┐                       │
│              │     RAG Engine        │                       │
│              │  ┌───────┐ ┌───────┐  │                       │
│              │  │Parser │ │Chunker│  │                       │
│              │  └───┬───┘ └───┬───┘  │                       │
│              │      └────┬────┘      │                       │
│              │     ┌─────┴─────┐     │                       │
│              │     │ Embedder  │     │                       │
│              │     │(Transformers.js)│                       │
│              │     └─────┬─────┘     │                       │
│              │     ┌─────┴─────┐     │                       │
│              │     │ VectorDB  │     │                       │
│              │     │ (LanceDB) │     │                       │
│              │     └───────────┘     │                       │
│              └───────────────────────┘                       │
│                          │                                   │
│              ┌───────────┴───────────┐                       │
│              │   PostgreSQL (API)    │                       │
│              │   Metadata & Auth     │                       │
│              └───────────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

| Interface | Protocol | Use Case |
|-----------|----------|----------|
| **MCP Server** | stdio | AI coding tools (Cursor, Claude Code, Codex) |
| **CLI** | stdin/stdout | Scripts, automation, terminal workflows |
| **REST API** | HTTP/JSON | Custom integrations, programmatic access |
| **Web UI** | Browser | Visual project management, file upload, search |

**Storage layers:**
- **LanceDB** (file-based vector database) — stores document chunks and embeddings. No server process required.
- **PostgreSQL** (relational database) — stores API metadata: users, projects, uploaded files, and index jobs. Required only for the REST API and Web UI.

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **Node.js** | v22.0.0 | v22 LTS or later |
| **pnpm** | v11.9.0 | latest |
| **RAM** | 2 GB | 4 GB+ (for large document ingestion) |
| **Disk** | 1 GB free | 5 GB+ (models + vector DB) |
| **PostgreSQL** | 16.x | 16.x (only needed for API/Web UI) |
| **OS** | macOS, Linux, Windows | macOS or Linux |

**Notes:**
- The MCP server and CLI work without PostgreSQL — only LanceDB (file-based) is needed.
- The REST API and Web UI require PostgreSQL for user accounts, projects, and file metadata.
- The embedding model (~90 MB) downloads automatically on first use.
- Visual mode (optional) requires an additional 250 MB – 2.9 GB for the VLM model.

---

## Quick Start

Set `BASE_DIR` to the folder you want to search (or `BASE_DIRS` for multiple roots — see [Configuration](#configuration)). Documents must live under one of the configured roots.

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

**Or use directly as CLI** — no MCP server needed:

```bash
npx mcp-local-rag ingest ./docs/
npx mcp-local-rag query "authentication API"
```

That's it. No Docker, no Python, no server setup.

---

## Installation

### npm (Recommended)

```bash
npm install -g mcp-local-rag
# or use directly with npx (no install needed)
npx mcp-local-rag --help
```

### From Source

```bash
git clone https://github.com/pradeepgudipati/mcp-local-rag-web.git
cd mcp-local-rag-web
pnpm install
pnpm build
```

### Docker

See [Docker Deployment](#docker-deployment) for full containerized setup with PostgreSQL, API server, and Web UI.

---

## Why This Exists

You want AI to search your documents—technical specs, research papers, internal docs. But most solutions send your files to external APIs.

**Privacy.** Your documents might contain sensitive data. This runs entirely locally.

**Cost.** External embedding APIs charge per use. This is free after the initial model download.

**Offline.** Works without internet after setup.

**Code search.** Pure semantic search misses exact terms like `useEffect` or `ERR_CONNECTION_REFUSED`. Keyword boost catches both meaning and exact matches.

**Agent reality.** In practice, many AI environments mainly use tool calling. CLI support and Agent Skills make the same workflows available even without full MCP integration.

---

## Usage

mcp-local-rag provides four interfaces: an **MCP server** for AI coding tools, a **CLI** for terminal use, a **REST API** for programmatic access, and a **Web UI** for visual management.

### Using with MCP

The MCP server provides 12 tools: `ingest_file`, `ingest_data`, `query_documents`, `read_chunk_neighbors`, `list_files`, `delete_file`, `status`, `search_project_docs`, `list_projects`, `get_project_brief`, `requirement_lookup`, `planning_context`.

#### MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `ingest_file` | Ingest a document file (PDF, DOCX, TXT, MD) into the vector database |
| `ingest_data` | Ingest in-memory content (text, HTML, or Markdown) |
| `query_documents` | Search ingested documents with hybrid keyword + semantic matching |
| `read_chunk_neighbors` | Read chunks before/after a result for more context |
| `list_files` | List supported files and their ingestion status |
| `delete_file` | Delete a previously ingested file or data |
| `status` | Get index status (document count, chunk count, memory usage) |
| `search_project_docs` | Search within a specific project namespace |
| `list_projects` | List all indexed projects with document/chunk counts |
| `get_project_brief` | Get project overview from indexed docs |
| `requirement_lookup` | Look up a specific requirement within a project |
| `planning_context` | Gather structured context for planning a task |

#### Project Namespaces

Documents can be organized into project namespaces. Add `projectName` to `ingest_file`/`ingest_data` to index under a project. Legacy `query_documents` returns only the default project; use `search_project_docs` for project-scoped search.

**Via MCP:**
```
"Ingest /Users/me/docs/seg-spec.pdf under project SEG"
"Search project SEG for copper integration requirements"
"List all projects"
```

**Via CLI:**
```bash
npx mcp-local-rag ingest ./docs/SEG --project SEG
npx mcp-local-rag ingest ./docs/MVA --project MVA
```

**Configuration:**
- `DEFAULT_PROJECT` env var (default: `"default"`) — the project name used when none is specified
- Project names must start with a letter and contain only letters, digits, hyphens, underscores (1-64 chars)

#### Ingesting Documents

```
"Ingest the document at /Users/me/docs/api-spec.pdf"
```

Supports PDF, DOCX, TXT, and Markdown. The server extracts text, splits it into chunks, generates embeddings locally, and stores everything in a local vector database.

Re-ingesting the same file replaces the old version automatically.

##### Ingesting PDFs with figures (visual mode)

PDFs with charts, tables, or diagrams can optionally add local VLM-generated captions to the document index, giving visual content some searchable representation in the same vector + FTS pipeline. Captions are auxiliary text — not image search, not OCR, and not a faithful transcription of the figure.

**Via MCP**:
```
"Ingest /Users/me/docs/api-spec.pdf with visual: true"
```

**Via CLI**:
```bash
npx mcp-local-rag ingest ./docs/spec.pdf --visual
```

Each caption is emitted as its own chunk with the envelope `[Visual content on page N: …]`, alongside the page-body chunks. It flows through the existing embedder and FTS index — no schema differences, no separate index.

Visual mode is opt-in; normal ingest does not load the VLM. Per-page VLM failures are tolerated — that page proceeds with text only.

###### Choosing a visual-quality profile

Visual mode offers two profiles, selected per ingest call:

| Profile | Model | Disk (cache) | Per-page inference | Suited for |
|---|---|---|---|---|
| `fast` (default) | `HuggingFaceTB/SmolVLM-256M-Instruct` | ~250 MB | baseline | Light visual indexing, quick first-run setup. |
| `quality` | `onnx-community/Qwen2.5-VL-3B-Instruct-ONNX` | ~2.9 GB | ~2× `fast` | Figures with in-image text (axis labels, panel sub-labels, annotations) where caption fidelity matters more than inference time. |

The numbers above are measured on CPU during development on the project's probe PDFs; they may shift with model updates or differ on your hardware.

**Via MCP** — `ingest_file` accepts an optional `visualQuality` parameter (enum: `'fast' | 'quality'`, default `'fast'`; ignored when `visual` is false):
```
"Ingest /Users/me/docs/research-paper.pdf with visual: true and visualQuality: 'quality'"
```

**Via CLI** — `--visual-quality fast|quality` (default `fast`; silently ignored when `--visual` is absent):
```bash
npx mcp-local-rag ingest ./docs/research-paper.pdf --visual --visual-quality quality
```

Profile model identifiers and quantization variants are fixed per release. Both profiles share the same `CACHE_DIR` (default: `./models/`); the first run on each profile downloads its model.

> **Behavior change from v0.14.0**: Captions are now emitted as dedicated chunks rather than appended to the page text before chunking. As a side effect, `metadata.fileSize` for visual ingests no longer includes the caption character count — it measures the post-extraction body length only. The underlying PDF is unchanged; only the reported `fileSize` for visual-ingested PDFs may shrink across the release boundary.

> **Security note**: Visual captions are derived from PDF contents and may inherit attacker-controlled text. Downstream LLM consumers should treat retrieved chunks as untrusted data, not as instructions. The `[Visual content on page N: …]` envelope helps consumers distinguish caption text from prose.

#### Ingesting HTML Content

Use `ingest_data` to ingest HTML content retrieved by your AI assistant (via web fetch, curl, browser tools, etc.):

```
"Fetch https://example.com/docs and ingest the HTML"
```

The server extracts main content using Readability (removes navigation, ads, etc.), converts to Markdown, and indexes it. Perfect for:
- Web documentation
- HTML retrieved by the AI assistant
- Clipboard content

HTML is automatically cleaned—you get the article content, not the boilerplate.

> **Note:** The RAG server itself doesn't fetch web content—your AI assistant retrieves it and passes the HTML to `ingest_data`. This keeps the server fully local while letting you index any content your assistant can access. Please respect website terms of service and copyright when ingesting external content.

#### Searching Documents

```
"What does the API documentation say about authentication?"
"Find information about rate limiting"
"Search for error handling best practices"
```

Search uses semantic similarity with keyword boost. This means `useEffect` finds documents containing that exact term, not just semantically similar React concepts.

Results include text content, source file, document title, and relevance score. The document title provides context for each chunk, helping identify which document a result belongs to. Adjust result count with `limit` (1-20, default 10).

Narrow a search to part of your corpus with `scope` — one path prefix or a list of them. Results are restricted to chunks whose file path equals a prefix or sits under it (exact-or-descendant). For example, `"/docs/api"` matches `/docs/api` and `/docs/api/auth.md` but not `/docs/apiv2`; a file prefix like `"/docs/readme.md"` matches just that file. Pass prefixes in the server's OS path style.

#### Expanding Context Around a Result

When a search result needs more surrounding context, use `read_chunk_neighbors` to read the chunks before and after it:

```
"That result about authentication looks relevant — read the surrounding chunks for the full explanation"
```

Pass the `filePath` and `chunkIndex` from the search result. The response includes the target chunk (marked `isTarget: true`) plus its neighbors, sorted by chunk index. Defaults to 2 chunks before and 2 after (adjustable up to 50 each).

#### Managing Files

```
"List all files in configured base directories and their ingested status"   # See what's indexed
"Delete old-spec.pdf from RAG"     # Remove a file
"Show RAG server status"           # Check system health
```

### Using as CLI

All MCP tools are also available as CLI commands — no MCP server needed:

```bash
npx mcp-local-rag ingest ./docs/               # Bulk ingest files
npx mcp-local-rag query "authentication API"    # Search documents
npx mcp-local-rag query "auth" --scope /docs/api --scope /docs/guide  # Restrict to path prefixes (repeatable)
npx mcp-local-rag read-neighbors --file-path /abs/path.md --chunk-index 5  # Expand context
npx mcp-local-rag list                          # Show ingestion status
npx mcp-local-rag status                        # Database stats
npx mcp-local-rag delete ./docs/old.pdf         # Remove content
npx mcp-local-rag delete --source "https://..."  # Remove by source URL
npx mcp-local-rag serve                         # Start REST API server
```

`query`, `read-neighbors`, `list`, `status`, and `delete` output JSON to stdout for piping (e.g., `| jq`). `ingest` outputs progress to stderr. Global options (`--db-path`, `--cache-dir`, `--model-name`) go before the subcommand. Run `npx mcp-local-rag --help` for details.

> ⚠️ The CLI does **not** read your MCP client config (`mcp.json`, `config.toml`, etc.). Configure the CLI via flags or environment variables as shown below.

---

## REST API

In addition to MCP and CLI, the server exposes a REST API built with [Fastify](https://fastify.dev/) for managing projects, files, and search. The API requires PostgreSQL for metadata storage.

### Starting the API Server

```bash
# Via CLI
npx mcp-local-rag serve

# Or with custom port
API_PORT=8080 npx mcp-local-rag serve

# Via pnpm (development)
pnpm run dev:api
```

The API server starts on `http://127.0.0.1:3939` by default. On first start, it automatically runs database migrations to create the required PostgreSQL tables.

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | No | Register a new user |
| `POST` | `/auth/login` | No | Login and get JWT token |
| `GET` | `/auth/me` | JWT | Get current user info |
| `POST` | `/projects` | JWT | Create a project |
| `GET` | `/projects` | JWT | List user's projects |
| `GET` | `/projects/:id` | JWT | Get project details with stats |
| `DELETE` | `/projects/:id` | JWT | Delete project and all its data |
| `POST` | `/projects/:id/files/upload` | JWT | Upload a file to a project |
| `GET` | `/projects/:id/files` | JWT | List files in a project |
| `DELETE` | `/files/:id` | JWT | Delete a file |
| `POST` | `/projects/:id/index` | JWT | Trigger file indexing (background) |
| `POST` | `/projects/:id/reindex` | JWT | Reset and re-index all files |
| `POST` | `/files/:id/reindex` | JWT | Re-index a single file |
| `GET` | `/jobs/:id` | JWT | Check index job status |
| `POST` | `/search` | JWT | Search project documents |
| `GET` | `/health/live` | No | Liveness probe (process up, before embedder ready) |
| `GET` | `/health` | No | Readiness check (full startup complete) |

### Example: Register and Search

```bash
# Register
TOKEN=$(curl -s -X POST http://localhost:3939/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","username":"dev","password":"password123"}' \
  | jq -r .token)

# Create project
curl -s -X POST http://localhost:3939/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-project","description":"My docs"}'

# Upload and index a file
curl -s -X POST http://localhost:3939/projects/1/files/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./README.md"

curl -s -X POST http://localhost:3939/projects/1/index \
  -H "Authorization: Bearer $TOKEN"

# Search
curl -s -X POST http://localhost:3939/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectName":"my-project","query":"semantic search"}'
```

---

## Web UI

A modern web interface for managing your RAG system, built with React 19, TypeScript, Vite, and Tailwind CSS.

### Features

- **Authentication** — Register and login with JWT-based auth
- **Dashboard** — Overview of projects, server status, and quick actions
- **Project Management** — Create, view, and delete projects
- **File Upload** — Drag-and-drop file upload with per-file and batch progress, automatic retry on transient errors, and idempotent re-upload (duplicate content is skipped)
- **Document Indexing** — Trigger indexing and monitor job status
- **Search** — Search across indexed documents with relevance scoring
- **MCP Setup** — Generate MCP server configuration for Cursor
- **Skill Setup** — Generate RAG skill files for AI assistants
- **AGENTS.md Setup** — Generate AGENTS.md blocks for project context

### Key Pages

| Page | Route | Description |
|------|-------|-------------|
| Login | `/login` | User authentication |
| Register | `/register` | Create new account |
| Dashboard | `/dashboard` | Overview and quick actions |
| Projects | `/projects` | List and manage projects |
| Project Detail | `/projects/:id` | View files, trigger indexing |
| Upload | `/projects/:id/upload` | Upload documents |
| Search | `/search` | Search indexed documents |
| MCP Setup | `/setup/mcp` | Generate MCP configuration |
| Skill Setup | `/setup/skill` | Generate RAG skill files |
| AGENTS.md | `/setup/agents` | Generate AGENTS.md blocks |

### Updating Documents (Delete → Re-upload → Re-index)

When you need to replace a document with a newer version:

1. **Delete the old file** — On the project detail page, delete the file. This removes the stored copy from disk, the database record, and all indexed vector chunks for that file.
2. **Re-upload** — Upload the new version via the Upload page. Original filenames are preserved in metadata; files are stored on disk under `UPLOAD_DIR`.
3. **Re-index** — Click **Start indexing** on the project detail page to chunk, embed, and index the new upload.

**Re-uploading without deleting:** Uploading a file with identical content (same SHA-256 hash) is treated as already uploaded — the UI skips it and continues with remaining files. This makes batch retries safe after partial uploads.

**Partial upload retries:** If some files fail due to transient network errors, the upload UI retries automatically (up to 3 times) and continues with the rest. Successfully uploaded files are skipped on retry; only failed files need another attempt.

### Running the Full Stack

**Quick start (both API and UI):**

```bash
pnpm install
pnpm run dev:full
```

This starts the API first and waits for `/health` to pass (embedder load can take 30s–3min depending on CPU and whether the model is cached), then starts the Web UI — avoiding proxy `ECONNREFUSED` errors on startup.
- API server on `http://127.0.0.1:3939`
- Web UI on `http://localhost:5173` (after API is healthy)

Override the wait target with `API_PORT` (from `.env`) or `DEV_API_WAIT_TIMEOUT_MS` (default `180000`).

**Run separately:**

```bash
# Terminal 1: API server
pnpm run dev:api

# Terminal 2: Web UI
pnpm run dev:ui
```

### UI Project Structure

```
frontend/
├── src/
│   ├── api/          # API client functions
│   ├── components/   # Reusable UI components
│   ├── hooks/        # Custom React hooks (auth context)
│   ├── pages/        # Page components
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Utility functions
├── index.html
├── package.json
├── vite.config.ts    # Vite config with API proxy
└── tailwind.config.js
```

---

## Testing Vector Search

Once documents are ingested under a project namespace, you can verify the vector storage similarity search through every interface: MCP, CLI, REST API, and Web UI. This section walks through each path with practical examples.

### Prerequisites

Documents must be **ingested first** before searching. Ingest files under a project namespace so results are scoped:

```bash
# CLI — ingest a folder under project SEG
npx mcp-local-rag ingest ./docs/SEG --project SEG

# MCP — ask your AI assistant
"Ingest /Users/me/docs/seg-spec.pdf under project SEG"
```

Verify ingestion completed:

```bash
npx mcp-local-rag list
# or via MCP: "List all projects"
```

### Via MCP

Two tools support search — `query_documents` (default project) and `search_project_docs` (any project).

**`search_project_docs`** — project-scoped search (recommended for multi-project setups):

```
"Search project SEG for copper integration requirements"
"Find all references to voltage thresholds in project MVA"
```

Parameters:
- `project_name` (required) — project to search within
- `query` (required) — natural language search query
- `limit` — max results (1–20, default 10)

**`query_documents`** — default project search:

```
"What does the API documentation say about authentication?"
"Find information about rate limiting"
```

Parameters:
- `query` (required) — search query
- `limit` — max results (1–20, default 10)
- `scope` — absolute path prefix(es) to restrict results

Both tools return JSON arrays with `filePath`, `chunkIndex`, `text`, `score`, and `fileTitle` for each result.

### Via CLI

The CLI `query` command searches the default project:

```bash
# Basic search
npx mcp-local-rag query "copper integration requirements"

# Limit results
npx mcp-local-rag query "voltage thresholds" --limit 5

# Restrict to a path prefix
npx mcp-local-rag query "authentication" --scope /Users/me/docs/api

# Multiple scopes
npx mcp-local-rag query "error handling" --scope /Users/me/docs/api --scope /Users/me/docs/guide
```

Results are output as JSON to stdout, making them easy to pipe:

```bash
npx mcp-local-rag query "copper specs" | jq '.[0].text'
```

> **Note:** The CLI searches the default project only. For project-scoped search, use the MCP `search_project_docs` tool or the REST API.

### Via REST API

The `POST /search` endpoint accepts a JSON body with `projectName`, `query`, and optional `limit`.

**Step 1 — Authenticate:**

```bash
TOKEN=$(curl -s -X POST http://localhost:3939/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","username":"dev","password":"password123"}' \
  | jq -r .token)
```

**Step 2 — Search:**

```bash
# Search project SEG for copper integration requirements
curl -s -X POST http://localhost:3939/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectName":"SEG","query":"copper integration requirements"}' | jq

# With a result limit
curl -s -X POST http://localhost:3939/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectName":"MVA","query":"voltage thresholds","limit":5}' | jq
```

**Response format:**

```json
{
  "projectName": "SEG",
  "query": "copper integration requirements",
  "results": [
    {
      "content": "The copper integration module supports...",
      "source": "/Users/me/docs/seg-spec.pdf",
      "filename": "seg-spec.pdf",
      "chunkIndex": 12,
      "score": 0.847
    }
  ]
}
```

Each result includes the text `content`, source file path, `filename`, `chunkIndex`, and a relevance `score` (0–1, higher is better).

### Via Web UI

1. Start the full stack: `pnpm run dev:full`
2. Open `http://localhost:5173` and log in
3. Navigate to **Search** (`/search`)
4. Select a **project** from the dropdown
5. Enter your query (e.g., "copper integration requirements")
6. Adjust the **limit** (default 10, max 100 for the UI)
7. Click **Search**

Results display the filename, chunk index, a **percentage match** score, the content text, and the source file path.

### Understanding Results

| Field | Meaning |
|-------|---------|
| `score` (MCP/CLI/API) | Relevance score — **0 = best match**, higher = worse. This is a distance metric, not a percentage. |
| `score` (Web UI) | Displayed as `(score * 100).toFixed(1)` with a `% match` label. Higher is better in the UI display. |
| `chunkIndex` | Zero-based position of the chunk within the source document. Use with `read_chunk_neighbors` to expand context. |
| `fileTitle` | Extracted document title (from PDF metadata, Markdown heading, etc.) — may be `null`. |

**Relevance thresholds:**
- Scores below `0.3` (distance) are typically strong matches
- Scores above `0.6` may be loosely related — review before relying on them
- The `RAG_MAX_DISTANCE` env var can filter out low-relevance results automatically

### Tuning Search

**Result count:**
- MCP: `limit` parameter (1–20, default 10). Lower favors precision, higher recall.
- CLI: `--limit <n>` flag
- REST API: `"limit": N` in the request body
- Web UI: Limit input field (1–100)

**Project filtering:**
- All interfaces support project scoping — results are restricted to documents ingested under that project namespace
- Use `list_projects` (MCP), the projects page (Web UI), or `GET /projects` (API) to see available projects

**Path scoping (MCP and CLI only):**
- The `scope` parameter/flag restricts results to specific file path prefixes
- Useful for narrowing search to a subdirectory within a project

**Getting better results:**
- Use specific terms over generic ones — "copper integration voltage threshold" beats "specs"
- The keyword boost ensures exact terms like class names, error codes, and identifiers rank higher
- Increase `RAG_HYBRID_WEIGHT` (default `0.6`) for stronger keyword matching — see [Search Tuning](#search-tuning)
- Use `read_chunk_neighbors` (MCP) or `read-neighbors` (CLI) to expand a result with surrounding context

---

## Docker Deployment

Run the API and Web UI with Docker Compose. PostgreSQL is optional — use the bundled container (`--profile local-db`) or point at an existing database.

### External database (mini-pc)

Use this when PostgreSQL already runs on your LAN (for example at `192.168.50.105:5432`). **Do not** pass `--profile local-db`.

```bash
# On the mini-pc
git clone https://github.com/pradeepgudipati/mcp-local-rag-web.git
cd mcp-local-rag-web

cp .env.example .env
# Edit .env — set DB_HOST to your Postgres host (not localhost or postgres)

docker compose up -d --build
```

> **Tip:** Set `DOCKER_BUILDKIT=1` (and optionally `COMPOSE_BAKE=true`) before building for faster repeat builds. See [Fast rebuilds](#fast-rebuilds).

> **First start can take several minutes.** The API binds port 3939 immediately (`/health/live`), then loads the embedding model and runs DB migration. On a slow CPU, the first run also downloads the model into the `model_cache` volume. Use `/health` (not `/health/live`) to confirm full readiness. Watch progress with `docker compose logs -f api` — look for `API server ready at http://0.0.0.0:3939`.

**Required `.env` values for external Postgres:**

| Variable | Example | Notes |
|----------|---------|-------|
| `DB_HOST` | `192.168.50.105` | LAN IP or hostname of Postgres — **not** `localhost` or `postgres` |
| `DB_PORT` | `5432` | Postgres port |
| `DB_USER` | `mcp_local_rag_user` | Must exist on the external server |
| `DB_PASSWORD` | *(your password)* | Must match the external user |
| `DB_NAME` | `mcp_local_rag_db` | Database must exist on the external server |
| `JWT_SECRET` | *(random string)* | Required for auth |
| `API_PORT` | `3939` | Host port mapped to the API container |
| `WEB_PORT` | `80` | Host port mapped to the Web UI |

`API_HOST`, `DB_PATH`, `CACHE_DIR`, and `UPLOAD_DIR` are overridden inside the API container by `docker-compose.yml` — you do not need to change them for Docker.

**Verify connectivity** (optional, from the mini-pc after `docker compose up`):

```bash
# Liveness (responds as soon as the process binds the port)
curl -s http://localhost:3939/health/live

# Readiness (only after embedder + DB migration complete — check logs if this fails)
curl -s http://localhost:3939/health

# Direct Postgres check from the API image (uses postgres.js, same as the app)
docker compose run --rm api node -e "
const postgres = require('postgres');
const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
sql\`SELECT 1 AS ok\`.then((r) => { console.log('DB OK', r); return sql.end(); })
  .catch((e) => { console.error(e.message); process.exit(1); });
"
```

The API container reaches LAN IPs over the default bridge network; no `extra_hosts` or `network_mode: host` is required when `DB_HOST` is a routable address like `192.168.50.105`.

**Ports exposed on the mini-pc:**

| Service | Container | Host port | URL |
|---------|-----------|-----------|-----|
| Web UI | `mcp-rag-web` | `80` (or `WEB_PORT`) | `http://<mini-pc-ip>/` |
| API | `mcp-rag-api` | `3939` (or `API_PORT`) | `http://<mini-pc-ip>:3939/` |

The Web UI proxies `/api/*` to the API container via Docker's internal network.

```bash
# Logs and health
docker compose ps
docker compose logs -f api
curl -s http://localhost:3939/health
```

### Quick Start (bundled PostgreSQL)

```bash
# Clone the repository
git clone https://github.com/pradeepgudipati/mcp-local-rag-web.git
cd mcp-local-rag-web

# Create .env file
cp .env.example .env
# Edit .env — set DB_HOST=postgres for the bundled container

# Start all services (API + Web UI + local PostgreSQL)
docker compose --profile local-db up -d --build
```

With `--profile local-db`, this starts three containers:

| Service | Container | Port | Description |
|---------|-----------|------|-------------|
| PostgreSQL | `mcp-rag-postgres` | 5432 | Metadata database (`local-db` profile) |
| API Server | `mcp-rag-api` | 3939 | REST API backend |
| Web UI | `mcp-rag-web` | 80 | React frontend (nginx) |

Without `--profile local-db`, only **API** and **Web UI** start (two containers).

Access the Web UI at `http://localhost` and the API at `http://localhost:3939`.

### Docker Environment Variables

Create a `.env` file in the project root:

```bash
# Database — use postgres with --profile local-db, or a LAN IP for external Postgres
DB_HOST=postgres
DB_PORT=5432
DB_USER=mcp_local_rag_user
DB_PASSWORD=your_secure_password_here
DB_NAME=mcp_local_rag_db

# API Server
API_PORT=3939
JWT_SECRET=your_jwt_secret_here

# Frontend
WEB_PORT=80

# RAG Configuration
MODEL_NAME=Xenova/all-MiniLM-L6-v2
RAG_DEVICE=cpu
```

### Docker Volumes

The compose file creates four persistent volumes:

| Volume | Purpose |
|--------|---------|
| `postgres_data` | PostgreSQL database files |
| `lancedb_data` | LanceDB vector database |
| `model_cache` | Downloaded embedding models |
| `upload_data` | Uploaded document files |

### Fast rebuilds

Docker builds are optimized for **repeat dev iteration**. Enable BuildKit before building:

```bash
export DOCKER_BUILDKIT=1
export COMPOSE_BAKE=true   # optional: Compose bake backend (parallel builds, better caching)
docker compose build
```

**Do not use `--no-cache` for normal development** — it forces a full reinstall and re-export of every layer (~2+ minutes on a mini-pc). Only use `--no-cache` when debugging a stale layer or after changing base images.

#### What stays cached vs what rebuilds

| Change | `api` rebuilds | `web` rebuilds |
|--------|----------------|----------------|
| `src/` only | TypeScript compile + small `dist` layer | **cached** (skip with `docker compose build api`) |
| `frontend/src/` only | **cached** (skip with `docker compose build web`) | Vite build + nginx assets |
| `pnpm-lock.yaml` or `package.json` | deps + prod-deps layers | deps layer |
| `skills/` only | skills layer only | **cached** |
| `frontend/nginx.conf` | **cached** | nginx config layer only |

The API image uses a **separate prod-deps stage** so the large `node_modules` layer is **not** invalidated when you change backend source — only the small `dist/` layer is re-exported.

pnpm downloads are accelerated with **BuildKit cache mounts** (`/pnpm/store`), so even lockfile changes reuse previously downloaded packages.

#### Rebuild only what changed

```bash
# Backend code change only (~10–25s on a mini-pc with warm cache)
docker compose build api

# Frontend code change only
docker compose build web

# Both services (second build should show CACHED for unchanged layers)
docker compose build
```

#### Verify cache is working

Run `docker compose build` twice in a row. The second run should show `CACHED` on deps/prod-deps/nginx stages and complete in well under 30 seconds when nothing changed.

**Clean build** (first time or after `docker builder prune`): still downloads deps and exports prod `node_modules` once (~60–90s for API export on slow disks). Subsequent code-only rebuilds should be much faster.

### Stopping and Cleaning Up

```bash
# Stop services
docker compose down

# Stop and remove volumes (destroys all data)
docker compose down -v
```

---

## Configuration

### Environment Variables

The MCP server is configured by environment variables only — pass them through your MCP client's `env` block. The CLI accepts the same env vars plus equivalent flags (priority: CLI flag > env > default). CLI flags are not accepted on the bare `mcp-local-rag` (MCP server) launch.

#### RAG Engine Variables

| Environment Variable | CLI Flag | Default | Description |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` (repeatable) | Current directory | Single document root directory (security boundary). See [Document Roots](#document-roots-base_dir-and-base_dirs) for multi-root setup. |
| `BASE_DIRS` | — | (unset) | JSON array of document roots (security boundary). Takes precedence over `BASE_DIR`. See [Document Roots](#document-roots-base_dir-and-base_dirs). |
| `DB_PATH` | `--db-path` | `./lancedb/` | Vector database location |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Model cache directory |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID ([available models](https://huggingface.co/models?library=transformers.js&pipeline_tag=feature-extraction)) |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100MB) | Maximum file size in bytes |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Minimum chunk length in characters (1–10000) |
| `DEFAULT_PROJECT` | — | `default` | Default project name when none specified |
| `RAG_DEVICE` | — | `cpu` | Execution device. Passed straight to ONNX Runtime. See the [Transformers.js device source code](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/utils/devices.js) for the live list of supported backend names. If initialization fails, the server throws an error. |
| `RAG_DTYPE` | — | `fp32` | Embedding quantization dtype. Opt-in and passed straight through; accepts any dtype the chosen model provides (`fp32`, `fp16`, `q8`, `int8`, …). If the model lacks the requested variant, the server throws an error naming the dtypes it does provide. Changing `RAG_DEVICE`/`RAG_DTYPE` changes the embedding space — re-ingest existing data. |

#### API Server Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3939` | HTTP server port |
| `API_HOST` | `127.0.0.1` | HTTP server bind address |
| `JWT_SECRET` | (random) | JWT signing secret |
| `JWT_EXPIRES_IN` | `7d` | JWT token expiry |
| `DATABASE_URL` | — | Full PostgreSQL connection URL (overrides `DB_*` vars) |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | — | PostgreSQL password |
| `DB_NAME` | `mcp_local_rag_db` | PostgreSQL database name |
| `UPLOAD_DIR` | `<DB_PATH>/uploads/` | File upload storage directory |

**Model choice tips:**
- Multilingual docs → e.g., `onnx-community/embeddinggemma-300m-ONNX` (100+ languages)
- Scientific papers → e.g., `sentence-transformers/allenai-specter` (citation-aware)
- Code repositories → default often suffices; keyword boost matters more (or `jinaai/jina-embeddings-v2-base-code`)

⚠️ Changing `MODEL_NAME` changes embedding dimensions. Delete `DB_PATH` and re-ingest after switching models.

### Document Roots (`BASE_DIR` and `BASE_DIRS`)

mcp-local-rag enforces a security boundary: only files under a configured root are accessible to ingest, list, delete, or read-neighbor operations.

**Single root** — use `BASE_DIR`:

```bash
export BASE_DIR=/Users/me/Documents/work
```

**Multiple roots** — use `BASE_DIRS` with a JSON array:

```bash
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

Only JSON-array syntax is supported. Delimiter syntax such as `BASE_DIRS=/a:/b` is intentionally **not** supported (avoids ambiguity with spaces, colons, commas, and Windows paths).

**Resolution order** (highest precedence first):

1. CLI `--base-dir <path>` flags (repeatable on `ingest` and `list`)
2. `BASE_DIRS` environment variable
3. `BASE_DIR` environment variable
4. `process.cwd()` (current working directory)

CLI roots **replace** env roots — they are never merged. `BASE_DIRS` and `BASE_DIR` are never merged either: `BASE_DIRS` wins when both are set.

**Precedence warning** — when `BASE_DIRS` and `BASE_DIR` are both set (and no CLI `--base-dir` is supplied), `BASE_DIR` is ignored and a warning is surfaced. The warning is visible:

- In MCP tool responses (as an additional content block, on every tool — including `status`, `query_documents`, `ingest_file`, `ingest_data`, `list_files`, `delete_file`, `read_chunk_neighbors`).
- On CLI `stderr`.

Unset `BASE_DIR` (or remove `BASE_DIRS`) to silence the warning.

**Nested-root pruning** — if one configured root sits inside another after realpath resolution, the nested child is dropped to avoid duplicate scan results. A pruning warning is surfaced the same way as the precedence warning. The surviving parent root still defines the security boundary.

**Invalid `BASE_DIRS`** — when `BASE_DIRS` is not a valid JSON array of non-empty strings (malformed JSON, empty array, non-string elements, ...), root-dependent MCP tools return a structured error and CLI subcommands exit non-zero. There is **no silent fallback** to `BASE_DIR` or `cwd`. The MCP `status` tool remains callable so you can diagnose the config error through your MCP client.

### Database Setup

#### PostgreSQL (Required for API/Web UI)

The REST API and Web UI require PostgreSQL 16+. The database schema is auto-migrated on first API startup — no manual migration steps needed.

**Option 1: Docker (recommended)**
```bash
docker compose --profile local-db up -d postgres
```

**Option 2: Local PostgreSQL**
```bash
# Create database and user
psql -U postgres -c "CREATE USER mcp_local_rag_user WITH PASSWORD 'your_password';"
psql -U postgres -c "CREATE DATABASE mcp_local_rag_db OWNER mcp_local_rag_user;"
```

Then set the connection variables in `.env`:
```bash
DB_HOST=localhost
DB_PORT=5432
DB_USER=mcp_local_rag_user
DB_PASSWORD=your_password
DB_NAME=mcp_local_rag_db
```

Or use a single URL:
```bash
DATABASE_URL=postgresql://user:password@localhost:5432/mcp_local_rag_db
```

#### LanceDB (Automatic)

The vector database (LanceDB) is file-based and requires no setup. It is created automatically at `DB_PATH` (default: `./lancedb/`) on first use.

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

- **Path restriction**: Only files within a configured root (`BASE_DIR` or any `BASE_DIRS` / `--base-dir` entry) are accessible. Symlinks resolving outside all configured roots, and sibling-prefix paths (e.g. `/foo/barista` for root `/foo/bar`), are rejected.
- **Local only**: No network requests after model download
- **Model sources** (all official HuggingFace repositories):
  - Embedder: [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
  - Visual `fast` profile: [`HuggingFaceTB/SmolVLM-256M-Instruct`](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct)
  - Visual `quality` profile: [`onnx-community/Qwen2.5-VL-3B-Instruct-ONNX`](https://huggingface.co/onnx-community/Qwen2.5-VL-3B-Instruct-ONNX)
- **Visual caption fidelity**: The `quality` profile reproduces in-image text more faithfully than `fast`. Both profiles output captions wrapped as `[Visual content on page N: …]`, but a faithful reproduction means attacker-controlled in-image text — including characters like `]` that visually close the envelope — can appear verbatim in retrieved chunks. Downstream LLM consumers should treat retrieved chunks as untrusted data, not as instructions, regardless of envelope shape.

---

## Search Tuning

Adjust these for your use case:

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | Keyword boost factor. 0 = semantic only, higher = stronger keyword boost. |
| `RAG_GROUPING` | (not set) | `similar` for top group only, `related` for top 2 groups. |
| `RAG_MAX_DISTANCE` | (not set) | Filter out low-relevance results (e.g., `0.5`). |
| `RAG_MAX_FILES` | (not set) | Limit results to top N files (e.g., `1` for single best file). |

### Code-focused tuning

For codebases and API specs, increase keyword boost so exact identifiers (`useEffect`, `ERR_*`, class names) dominate ranking:

```json
"env": {
  "RAG_HYBRID_WEIGHT": "0.7",
  "RAG_GROUPING": "similar"
}
```

- `0.7` — balanced semantic + keyword
- `1.0` — aggressive; exact matches strongly rerank results

Keyword boost is applied *after* semantic filtering, so it improves precision without surfacing unrelated matches.

---

## How It Works

**TL;DR:**
- Documents are chunked by semantic similarity, not fixed character counts
- Each chunk is embedded locally using Transformers.js
- Search uses semantic similarity with keyword boost for exact matches
- Results are filtered based on relevance gaps, not raw scores

### Details

When you ingest a document, the parser extracts text based on file type (PDF via `mupdf`, DOCX via `mammoth`, text files directly).

The semantic chunker splits text into sentences, then groups them using embedding similarity. It finds natural topic boundaries where the meaning shifts—keeping related content together instead of cutting at arbitrary character limits. This produces chunks that are coherent units of meaning, typically 500-1000 characters. Markdown code blocks are kept intact—never split mid-block—preserving copy-pastable code in search results.

Each chunk goes through a Transformers.js embedding model (default: `all-MiniLM-L6-v2`, configurable via `MODEL_NAME`), converting text into vectors. Vectors are stored in LanceDB, a file-based vector database requiring no server process.

When you search:
1. Your query becomes a vector using the same model
2. Semantic (vector) search finds the most relevant chunks
3. Quality filters apply (distance threshold, grouping)
4. Keyword matches boost rankings for exact term matching

The keyword boost ensures exact terms like `useEffect` or error codes rank higher when they match.

---

## Agent Skills

[Agent Skills](https://agentskills.io/) provide optimized prompts that help AI assistants use RAG tools more effectively. Install skills for better query formulation, result interpretation, and ingestion workflows:

```bash
# Claude Code (project-level)
npx mcp-local-rag skills install --claude-code

# Claude Code (user-level)
npx mcp-local-rag skills install --claude-code --global

# Codex
npx mcp-local-rag skills install --codex
```

Skills include:
- **Query optimization**: Better search query formulation
- **Result interpretation**: Score thresholds and filtering guidelines
- **HTML ingestion**: Format selection and source naming

### Ensuring Skill Activation

Skills are loaded automatically in most cases—AI assistants scan skill metadata and load relevant instructions when needed. For consistent behavior:

**Option 1: Explicit request (natural language)**
Before RAG operations, request in natural language:
- "Use the mcp-local-rag skill for this search"
- "Apply RAG best practices from skills"

**Option 2: Add to agent instruction file**
Add to your `AGENTS.md`, `CLAUDE.md`, or other agent instruction file:
```
When using query_documents, ingest_file, or ingest_data tools,
apply the mcp-local-rag skill for better query formulation and result interpretation.
```

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Run with WebGPU acceleration
pnpm run test:webgpu

# Run end-to-end visual ingest tests
pnpm run test:e2e

# Run frontend tests
pnpm run test:ui

# Run full quality check (lint + format + type-check + tests)
pnpm run check:all
```

### Stage 0 Verification

Verify the ingest and query pipeline works end-to-end:

```bash
node scripts/verify-stage0.mjs
```

This script ingests a sample document into a temp database, queries it, and validates results. Exit 0 = pass.

---

## Development

### Building from Source

```bash
git clone https://github.com/pradeepgudipati/mcp-local-rag-web.git
cd mcp-local-rag-web
pnpm install
```

### Development Scripts

```bash
# Start MCP server in dev mode (with hot reload)
pnpm run dev

# Start API server
pnpm run dev:api

# Start Web UI (Vite dev server)
pnpm run dev:ui

# Start API, wait for /health, then start UI
pnpm run dev:full

# Build for production
pnpm run build

# TypeScript type checking
pnpm run type-check
```

### Code Quality

```bash
pnpm run type-check    # TypeScript check
pnpm run check:fix     # Lint and format
pnpm run check:deps    # Circular dependency check
pnpm run check:all     # Full quality check
```

### Project Structure

```
mcp-local-rag-web/
├── src/
│   ├── index.ts           # Entry point (routes to CLI or MCP server)
│   ├── cli-main.ts        # CLI subcommand dispatcher
│   ├── server-main.ts     # MCP server startup
│   ├── server/            # MCP tool handlers and definitions
│   ├── cli/               # CLI subcommands (ingest, query, list, delete, serve, etc.)
│   ├── api/               # Fastify HTTP API
│   │   ├── routes/        # Route handlers (auth, projects, files, search, health)
│   │   ├── db/            # Drizzle ORM schema and PostgreSQL connection
│   │   ├── middleware/    # Auth middleware (JWT)
│   │   ├── config.ts      # API configuration from env vars
│   │   └── server.ts      # Fastify app builder
│   ├── parser/            # PDF, DOCX, TXT, MD parsing
│   ├── chunker/           # Semantic text splitting
│   ├── embedder/          # Transformers.js embeddings
│   └── vectordb/          # LanceDB operations
├── frontend/              # React web UI
│   ├── src/
│   │   ├── api/           # API client functions
│   │   ├── components/    # Reusable UI components
│   │   ├── pages/         # Page components (Dashboard, Projects, Search, etc.)
│   │   ├── hooks/         # Custom React hooks
│   │   ├── types/         # TypeScript type definitions
│   │   └── utils/         # Utility functions
│   ├── Dockerfile         # Frontend production image (nginx)
│   ├── nginx.conf         # nginx config with API proxy
│   ├── vite.config.ts     # Vite config with API proxy
│   └── package.json
├── scripts/               # Build and verification scripts
├── skills/                # Agent skill files
├── Dockerfile             # Backend API production image
├── docker-compose.yml     # Full stack Docker Compose
├── pnpm-workspace.yaml    # pnpm workspace config (frontend is a workspace member)
└── package.json
```

---

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

Check chunk count with `status`. Large documents with many chunks may slow queries. Consider splitting very large files.

### "Path outside BASE_DIR"

Ensure file paths are within one of the configured roots (`BASE_DIR`, any `BASE_DIRS` entry, or any CLI `--base-dir`). Use absolute paths.

### "BASE_DIRS must be a JSON array..."

`BASE_DIRS` accepts only a JSON array of one or more non-empty path strings. Examples:

- Valid: `BASE_DIRS='["/Users/me/work","/Users/me/specs"]'`
- Invalid: `BASE_DIRS=/a:/b` (delimiter syntax not supported)
- Invalid: `BASE_DIRS='[]'` (empty array)
- Invalid: `BASE_DIRS='["",""]'` (empty string element)

When invalid, root-dependent operations fail with a clear error rather than silently falling back. The MCP `status` tool remains callable so you can inspect the diagnostic.

### MCP client doesn't see tools

1. Verify config file syntax
2. Restart client completely (Cmd+Q on Mac for Cursor)
3. Test directly: `npx mcp-local-rag` should run without errors

### PostgreSQL connection refused

Ensure PostgreSQL is running and accessible. Check `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` are correct. With `--profile local-db`, set `DB_HOST=postgres` and ensure the postgres container is healthy. With an external database, set `DB_HOST` to the LAN IP (not `localhost`) and confirm the mini-pc can reach that host on port 5432 (firewall / `pg_hba.conf`).

### Docker: `mcp-rag-api` unhealthy / dependency failed to start

**Diagnose first** — failure in a few seconds usually means the API process crashed or exited, not a slow health check:

```bash
docker compose ps -a              # "Exit 0" or rapid restarts = startup crash or bad config
docker logs mcp-rag-api --tail 100   # use docker logs if compose logs shows nothing
docker compose logs api           # crash: stack trace; slow start: embedder/model messages
docker compose config | grep -A6 healthcheck   # confirm /health/live after pulling latest
```

**Stale-image diagnostics** (exit code 0 in &lt;1s usually means the container ran `node dist/cli-main.js serve`, which exits immediately — that file is a library, not an entry point):

```bash
docker inspect mcp-rag-api --format '{{.Config.Cmd}}'
docker inspect mcp-rag-api --format '{{.Config.Entrypoint}}'
docker inspect mcp-rag-api --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
docker compose run --rm --no-deps --entrypoint node api -e "console.log('ok')"
docker compose run --rm --no-deps --entrypoint sh api -c "head -5 dist/index.js"
git show HEAD:Dockerfile | grep -E 'CMD|ENTRYPOINT'
```

Expected after this fix: `Cmd` is `[node dist/index.js serve]`, `Entrypoint` includes `docker-api-entrypoint.sh`, and logs show `[mcp-rag-api] starting with argv: node dist/index.js serve` then `[mcp-rag-api] serve module loaded`.

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| Fails in **&lt;10s**, logs show no `[mcp-rag-api] serve module loaded` | Stale image or wrong entrypoint (`cli-main.js` instead of `index.js`) | Force fresh image — see mini-pc rebuild below; `docker-compose.yml` now sets `command` explicitly |
| Logs show `Starting API server...` then **Postgres / ECONNREFUSED** | `DB_HOST` wrong from inside container | Use LAN IP (e.g. `192.168.50.105`), not `localhost` — test below |
| Container stays **starting** for several minutes | First-run model download + embedder load | Normal on slow CPUs — wait for `API server ready at http://0.0.0.0:3939` |
| `compose up` fails but API container is running | Old compose with `service_healthy` on web | Pull latest — web now uses `service_started` so the UI starts while API warms up |

Docker liveness uses **`/health/live`** (responds as soon as the process binds port 3939). **`/health`** is readiness — LanceDB, embedder, and PostgreSQL migration must finish first. On a slow CPU the first start also downloads the embedding model (~90 MB) into the `model_cache` volume. The health check uses **Node `fetch`** inside the container (no `curl` required).

```bash
docker compose logs -f api   # watch for "API server ready at http://0.0.0.0:3939"
docker compose ps            # api should show "healthy" once /health/live responds
```

**Test DB reachability from the API image** (same network as `docker compose up`):

```bash
docker compose run --rm api node -e "
const postgres = require('postgres');
const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
sql\`SELECT 1 AS ok\`.then((r) => { console.log('DB OK', r); return sql.end(); })
  .catch((e) => { console.error(e.message); process.exit(1); });
"
```

**Mini-pc rebuild after pulling fixes** (force a fresh API image — do not skip `docker rmi`):

```bash
cd mcp-local-rag-web
git checkout main
git pull origin main
export DOCKER_BUILDKIT=1
export GIT_REVISION=$(git rev-parse HEAD)
docker compose down
docker rmi mcp-local-rag-web-api mcp-rag-api:latest 2>/dev/null || true
docker compose build api
docker compose up -d
docker inspect mcp-rag-api --format '{{.Config.Cmd}}'
docker compose logs api --tail 30
```

Expected `Cmd`: `[node dist/index.js serve]`. First logs should include `[mcp-rag-api] starting with argv:` and `[mcp-rag-api] serve module loaded`.

### API returns 401 Unauthorized

JWT tokens expire after `JWT_EXPIRES_IN` (default: 7 days). Login again to get a fresh token.

</details>

<details>
<summary><strong>FAQ</strong></summary>

**Is this really private?**
Yes. After model download, nothing leaves your machine. Verify with network monitoring.

**Can I use this offline?**
Yes, after the required models are cached locally. Text ingest/search needs the embedding model. PDF visual mode is opt-in and also needs the VLM model on first use; the download is ~250 MB for the default `fast` profile (SmolVLM-256M) or ~2.9 GB for the `quality` profile (Qwen2.5-VL-3B), cached under `CACHE_DIR` (default: `./models/`).

**How does this compare to cloud RAG?**
Cloud services offer better accuracy at scale but require sending data externally. This trades some accuracy for complete privacy and zero runtime cost.

**What file formats are supported?**
PDF, DOCX, TXT, Markdown, and HTML (via `ingest_data`). Not yet: Excel, PowerPoint, images.

**Can I change the embedding model?**
Yes, but you must delete your database and re-ingest all documents. Different models produce incompatible vector dimensions.

**GPU acceleration?**
Opt-in via `RAG_DEVICE`. Devices are passed straight to ONNX Runtime. GPU support is highly dependent on your system, Node.js version, and the underlying ONNX backend. See the [Transformers.js device source code](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/utils/devices.js) for the live list of supported backend names. If the requested device fails to initialize, the server throws an error — set `RAG_DEVICE=cpu` to revert.

**Can I change the embedding precision (dtype)?**
Opt-in via `RAG_DTYPE` (default `fp32`); accepted values are in the env-var table above. A recognized dtype the model lacks errors and lists the available ones; an unrecognized value (a typo) silently falls back to `fp32`. Changing `RAG_DEVICE`/`RAG_DTYPE` changes the embedding space — delete `DB_PATH` and re-ingest.

**Multi-user support?**
Yes, via the REST API and Web UI. Each user has their own projects and files. The MCP server and CLI remain single-user.

**How to backup?**
Copy `DB_PATH` directory (default: `./lancedb/`) for vector data. For API metadata, dump the PostgreSQL database.

**Do I need PostgreSQL for the MCP server/CLI?**
No. PostgreSQL is only required for the REST API and Web UI. The MCP server and CLI use LanceDB (file-based) exclusively.

</details>

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

## License

MIT License. Free for personal and commercial use.

## Blog Posts

- [Building a Local RAG for Agentic Coding](https://www.norsica.jp/blog/local-rag-agentic-coding) — Technical deep-dive into the semantic chunking and hybrid search design.

## Acknowledgments

Forked from [shinpr/mcp-local-rag](https://github.com/shinpr/mcp-local-rag) — the upstream MCP/CLI RAG server this project extends with a REST API and Web UI.

Built with [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic, [LanceDB](https://lancedb.com/), [Transformers.js](https://huggingface.co/docs/transformers.js), [Fastify](https://fastify.dev/), and [Drizzle ORM](https://orm.drizzle.team/).
