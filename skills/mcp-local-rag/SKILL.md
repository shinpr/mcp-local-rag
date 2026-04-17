---
name: mcp-local-rag
description: Search, ingest, expand chunk context, or manage local documents via a local RAG MCP server (tools: query_documents, read_chunk_neighbors, ingest_file, ingest_data, delete_file, list_files). Use when user says "search my docs", "save this page", "read around that chunk", "what did I save about X", or invokes `npx mcp-local-rag`.
---

# MCP Local RAG Skills

## Tools

| MCP Tool | CLI Equivalent | Use When |
|----------|---------------|----------|
| `ingest_file` | `npx mcp-local-rag ingest <path>` | Local files (PDF, DOCX, TXT, MD). CLI for bulk/directory. |
| `ingest_data` | — | Raw content (HTML, text) with source URL |
| `query_documents` | `npx mcp-local-rag query <text>` | Semantic + keyword hybrid search |
| `delete_file` | `npx mcp-local-rag delete <path>` | Remove ingested content |
| `list_files` | `npx mcp-local-rag list` | File ingestion status |
| `status` | `npx mcp-local-rag status` | Database stats |
| `read_chunk_neighbors` | `npx mcp-local-rag read-neighbors` | Read N chunks adjacent to a known chunkIndex (context expansion; call after `query_documents` or grep) |

## Search: Core Rules

Hybrid search combines vector (semantic) and keyword (BM25).

### Score Interpretation

Lower = better match. Use this to filter noise.

| Score | Action |
|-------|--------|
| < 0.3 | Use directly |
| 0.3-0.5 | Include if mentions same concept/entity |
| 0.5-0.7 | Include only if directly relevant to the question |
| > 0.7 | Skip unless no better results |

### Limit Selection

| Intent | Limit |
|--------|-------|
| Specific answer (function, error) | 5 |
| General understanding | 10 |
| Comprehensive survey | 20 |

### Query Formulation

| Situation | Why Transform | Action |
|-----------|---------------|--------|
| Specific term mentioned | Keyword search needs exact match | KEEP term |
| Vague query | Vector search needs semantic signal | ADD context |
| Error stack or code block | Long text dilutes relevance | EXTRACT core keywords |
| Multiple distinct topics | Single query conflates results | SPLIT queries |
| Few/poor results | Term mismatch | EXPAND (see below) |

### Query Expansion

When results are few or all score > 0.5, expand query terms:

- Keep original term first, add 2-4 variants
- Types: synonyms, abbreviations, related terms, word forms
- Example: `"config"` → `"config configuration settings configure"`

Avoid over-expansion (causes topic drift).

### Result Selection

When to include vs skip—based on answer quality, not just score.

**INCLUDE** if:
- Directly answers the question
- Provides necessary context
- Score < 0.5

**SKIP** if:
- Same keyword, unrelated context
- Score > 0.7
- Mentions term without explanation

### fileTitle

Each result includes `fileTitle` (document title extracted from content). Null when extraction fails.

| Use | How |
|-----|-----|
| Disambiguate chunks | Use fileTitle to identify which document the chunk belongs to |
| Group related chunks | Same fileTitle = same document context |
| Deprioritize mismatches | fileTitle unrelated to query AND score > 0.5 → rank lower |

## Context Expansion (read_chunk_neighbors)

`read_chunk_neighbors` (CLI: `read-neighbors`) is an **on-demand context expansion utility**, not a routine follow-up to every `query_documents` call. Chunks in this index are **semantic units** — sentences or paragraphs grouped by topic via Max-Min semantic chunking, not fixed-size text slices. Reading the chunks immediately before and after a target chunk yields coherent surrounding context, not arbitrary fragments.

Each `query_documents` result item already includes `filePath` and `chunkIndex`. Pass those to `read_chunk_neighbors` to expand a specific hit in place.

Trigger this tool only when one of these signals is present:
- **Insufficient context for your answer**: during response generation, the target chunk alone is not enough to reach a grounded conclusion (e.g., it references "this approach" or "as shown above" without the referent).
- **Explicit user request for more context**: the user asks for surrounding detail ("what comes before that?", "read more around that section", "show me the full explanation").

If neither signal is present, stop at the `query_documents` results.

Typical workflow when triggered:
1. Identify the specific chunk to expand (from a prior `query_documents` hit or `grep`).
2. Take that chunk's `filePath` and `chunkIndex`.
3. Call `read_chunk_neighbors` with those values; the response contains the target chunk plus its semantic neighbors, sorted by `chunkIndex`.

See [cli-reference.md](references/cli-reference.md#read-neighbors) for output fields and an example.

## Ingestion

### ingest_file
```
ingest_file({ filePath: "/absolute/path/to/document.pdf" })
```

### ingest_data
```
ingest_data({
  content: "<html>...</html>",
  metadata: { source: "https://example.com/page", format: "html" }
})
```

**Format selection** — match the data you have:
- HTML string → `format: "html"`
- Markdown string → `format: "markdown"`
- Other → `format: "text"`

**Source format:**
- Web page → Use URL: `https://example.com/page`
- Other content → Use scheme: `{type}://{date}` or `{type}://{date}/{detail}` where `{type}` is a short identifier for the content origin (e.g., clipboard, chat, note, meeting)

**HTML source options:**
- Static page → HTTP fetch
- SPA/JS-rendered → Browser/web tool with DOM rendering
- Auth required → Manual paste

If HTTP fetch returns empty or minimal content, retry with a browser/web tool.

Source URLs are normalized: query strings and fragments are stripped. See [html-ingestion.md](references/html-ingestion.md) for cases where this matters.

Re-ingest same source to update. Use same source in `delete_file` to remove.

### CLI commands

CLI subcommands mirror MCP tools. Useful for bulk operations, scripting, and environments without MCP.

- `query`, `list`, `status`, `delete` output JSON to stdout
- `ingest` outputs progress to stderr
- Use `--help` on any command for options
- See [cli-reference.md](references/cli-reference.md) for options and config matching

## References

For edge cases and examples:
- [html-ingestion.md](references/html-ingestion.md) - URL normalization, SPA handling
- [query-optimization.md](references/query-optimization.md) - Query patterns by intent
- [result-refinement.md](references/result-refinement.md) - Synthesis vs filter strategy, contradiction resolution, chunking
- [cli-reference.md](references/cli-reference.md) - CLI command options, config matching, output conventions
