# Query Optimization Reference

Core rules are in SKILL.md. This covers patterns and edge cases.

## Query Patterns by Intent

| User Intent | Query Pattern | Why |
|-------------|---------------|-----|
| Definition/Concept | `"[term] definition concept"` | Targets explanatory content |
| How-To/Procedure | `"[action] steps example usage"` | Targets instructional content |
| API/Function | `"[function] API arguments return"` | Targets reference docs |
| Troubleshooting | `"[error] fix solution cause"` | Targets problem-solving content |

## Multi-Query: When to Split

**Split** when "and" connects distinct topics:
```
"How do I authenticate AND handle errors?"
→ Query 1: "authentication login JWT session"
→ Query 2: "error handling exception catch"
```

**Don't split** when "and" is within single topic:
```
"How do I set up and configure the database?"
→ Single: "database setup configuration"
```

## Query Expansion Examples

When results are few or all score > 0.5:

| Type | Original | Expanded |
|------|----------|----------|
| Synonyms | delete | "delete remove" |
| Abbreviations | API | "API Application Programming Interface" |
| Related terms | auth | "auth authentication login" |
| Word forms | config | "config configuration configure" |

Keep original term first. Limit to 2-4 additions.

## Iterative Refinement

When initial results are unsatisfactory:

| Problem | Why It Happens | Action |
|---------|----------------|--------|
| Too few results | Term mismatch | Expand query (see above) |
| Too many irrelevant | Query too broad | Add specific terms |
| Missing expected | Phrasing mismatch | Try alternative wording |

## Language Mixing

Ngram tokenization supports cross-language queries:
```
"API error handling" → matches both English and Japanese content
```
