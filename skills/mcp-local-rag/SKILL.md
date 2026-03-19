---
name: mcp-local-rag
description: Ingest, search, list, update, or delete content in a local mcp-local-rag index when the user is working with local documents or pasted/fetched HTML, Markdown, or text. Use this skill to choose the right MCP tool or `npx mcp-local-rag` CLI command, formulate effective queries, interpret search scores, and manage source metadata.
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
