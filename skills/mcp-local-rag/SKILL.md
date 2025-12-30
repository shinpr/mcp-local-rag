---
name: mcp-local-rag
description: >
  Optimizes RAG search and ingestion (query_documents, ingest_file, ingest_data).
  Activate when: (1) search score > 0.5, (2) query is vague or too specific,
  (3) ingesting HTML/web content.
---

# MCP Local RAG Skills

## Tools

| Tool | Use When |
|------|----------|
| `ingest_file` | Local files (PDF, DOCX, TXT, MD) |
| `ingest_data` | Raw content (HTML, text) with source URL |
| `query_documents` | Semantic + keyword hybrid search |
| `delete_file` / `list_files` / `status` | Management |

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

**HTML source options:**
- Static page → LLM fetch
- SPA/JS-rendered → Browser MCP
- Auth required → Manual paste

Re-ingest same source to update.

## References

For edge cases and examples:
- [html-ingestion.md](references/html-ingestion.md) - URL normalization, SPA handling
- [query-optimization.md](references/query-optimization.md) - Query patterns by intent
- [result-refinement.md](references/result-refinement.md) - Contradiction resolution, chunking
