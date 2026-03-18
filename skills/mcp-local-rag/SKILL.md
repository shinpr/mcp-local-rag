---
name: mcp-local-rag
description: Use this skill when ingesting or querying documents with MCP local RAG, including `query_documents`, `ingest_file`, `ingest_data`, and CLI bulk ingestion. Covers query refinement, result score interpretation, and source metadata conventions for PDF, HTML, DOCX, TXT, and Markdown. Not for general file operations or SQL/database queries.
---

# MCP Local RAG Skills

## Tools

| Tool | Use When |
|------|----------|
| `ingest_file` | Local files (PDF, DOCX, TXT, MD) |
| `ingest_data` | Raw content (HTML, text) with source URL |
| `query_documents` | Semantic + keyword hybrid search |
| `delete_file` / `list_files` / `status` | Management |
| `npx mcp-local-rag ingest` | Multiple files or directory (shell) |

## Search: Core Rules

Hybrid search combines vector (semantic) and keyword (BM25).

### Score Interpretation

Lower = better match. Use this to filter noise.

| Score | Action |
|-------|--------|
| < 0.3 | Use directly |
| 0.3-0.5 | Include if mentions same concept/entity |
| > 0.5 | Skip unless no better results |

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
- Other content → Use scheme: `{type}://{date}` or `{type}://{date}/{detail}`
  - Examples: `clipboard://2024-12-30`, `chat://2024-12-30/project-discussion`

**HTML source options:**
- Static page → LLM fetch
- SPA/JS-rendered → Browser MCP
- Auth required → Manual paste

Re-ingest same source to update. Use same source in `delete_file` to remove.

### CLI ingest

For multiple files or directory ingestion. Prefer over repeated `ingest_file` calls.

| Scenario | Use |
|----------|-----|
| Single file from user request | `ingest_file` |
| Multiple files or a directory | `npx mcp-local-rag ingest <path>` |
| Raw HTML/text content | `ingest_data` (CLI does not support stdin) |

```bash
npx mcp-local-rag ingest [options] <path>
```

- `<path>`: file or directory (recursively scans supported formats)
- Use `--help` for all options and defaults
- Options must match MCP server config — see [cli-ingest.md](references/cli-ingest.md)

**Output interpretation:**

- Exit code 0: all files succeeded
- Exit code 1: one or more files failed — report failed files to user
- `SKIPPED (0 chunks)`: file was empty or too short, counted as success

## References

For edge cases and examples:
- [html-ingestion.md](references/html-ingestion.md) - URL normalization, SPA handling
- [query-optimization.md](references/query-optimization.md) - Query patterns by intent
- [result-refinement.md](references/result-refinement.md) - Contradiction resolution, chunking
- [cli-ingest.md](references/cli-ingest.md) - CLI options, config matching
