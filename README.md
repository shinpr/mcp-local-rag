<p align="center">
  <img src="assets/banner.jpg" alt="MCP Local RAG — Search below the surface." width="600" />
</p>

# MCP Local RAG

[![GitHub stars](https://img.shields.io/github/stars/shinpr/mcp-local-rag?style=social)](https://github.com/shinpr/mcp-local-rag)
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
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag
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
| `GET` | `/health` | No | Server health check |

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
- **File Upload** — Drag-and-drop file upload with progress tracking
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

### Running the Full Stack

**Quick start (both API and UI):**

```bash
pnpm install
pnpm run dev:full
```

This starts:
- API server on `http://127.0.0.1:3939`
- Web UI on `http://localhost:5173`

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

## Docker Deployment

Run the full stack (PostgreSQL + API + Web UI) with Docker Compose:

### Quick Start

```bash
# Clone the repository
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag

# Create .env file
cp .env.example .env
# Edit .env with your settings (especially DB_PASSWORD and JWT_SECRET)

# Start all services
docker compose up -d
```

This starts three containers:

| Service | Container | Port | Description |
|---------|-----------|------|-------------|
| PostgreSQL | `mcp-rag-postgres` | 5432 | Metadata database |
| API Server | `mcp-rag-api` | 3939 | REST API backend |
| Web UI | `mcp-rag-web` | 80 | React frontend (nginx) |

Access the Web UI at `http://localhost` and the API at `http://localhost:3939`.

### Docker Environment Variables

Create a `.env` file in the project root:

```bash
# Database
DB_USER=mcp_local_rag_user
DB_PASSWORD=your_secure_password_here
DB_NAME=mcp_local_rag_db
DB_PORT=5432

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
docker compose up -d postgres
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
git clone https://github.com/shinpr/mcp-local-rag.git
cd mcp-local-rag
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

# Start both API and UI concurrently
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
mcp-local-rag/
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

Ensure PostgreSQL is running and accessible. Check `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` are correct. With Docker, ensure the postgres container is healthy before the API starts.

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

Built with [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic, [LanceDB](https://lancedb.com/), [Transformers.js](https://huggingface.co/docs/transformers.js), [Fastify](https://fastify.dev/), and [Drizzle ORM](https://orm.drizzle.team/).
