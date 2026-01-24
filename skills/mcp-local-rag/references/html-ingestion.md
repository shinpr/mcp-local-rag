# HTML Ingestion Reference

Basic usage is in SKILL.md. This covers URL handling and edge cases.

## System Behavior

The parser extracts main content only—navigation, ads, and boilerplate are stripped. What gets indexed is clean body text, not the full HTML.

## When to Use Each Source Method

| Source Type | Method | Why |
|-------------|--------|-----|
| Static page, public | LLM fetch | Simplest, no extra tools |
| SPA / JS-rendered | Browser MCP | Need rendered DOM |
| Auth required | Manual paste | Can't fetch programmatically |

## URL Normalization

System strips query strings and fragments:
```
https://example.com/page?utm=x#section → https://example.com/page
```

**When query strings matter** (pagination, dynamic IDs):
```
ingest_data({
  content: page1_html,
  metadata: { source: "https://example.com/results?page=1", format: "html" }
})
```
Explicitly include full URL as source.

## Edge Cases

### Empty/Minimal Extraction

Why it happens:
- JS-rendered content (use browser MCP)
- Non-standard HTML structure
- Login required

### SPA/Dynamic Content

1. Use browser MCP to render
2. Wait for content load
3. Extract rendered HTML
4. Ingest via `ingest_data`

### Pages with Only Navigation

Skip or fetch deeper linked pages instead.

## Updating Content

Re-ingest with same source to replace:
```
ingest_data({
  content: updated_html,
  metadata: { source: "https://example.com/page", format: "html" }
})
```

## Search Results

Results from HTML include `source` field:
```json
{
  "filePath": "raw-data/abc123.html",
  "source": "https://example.com/page",
  "text": "...",
  "score": 0.25
}
```
