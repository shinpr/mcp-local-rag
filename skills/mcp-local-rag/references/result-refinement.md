# Result Refinement Reference

Core rules (score, include/skip) are in SKILL.md. This covers when and how to combine multiple results.

## When to Synthesize vs Filter

Match approach to user intent:

| User Intent | Approach | Why |
|-------------|----------|-----|
| Specific answer ("how to X") | Filter to 1-2 best | Extra results add noise |
| Understanding a topic | Synthesize multiple | Builds complete picture |
| Troubleshooting error | Filter to direct cause | Tangential info confuses |
| Comparing options | Synthesize with structure | Need all perspectives |

## Multiple Results Handling

### Synthesis

When: User needs comprehensive understanding.

```
Result 1: "API accepts JSON..."
Result 2: "Auth uses Bearer tokens..."
→ Combine into unified answer
```

### Deduplication

When: Results overlap significantly.

1. Pick most complete result
2. Add only unique info from others

### Contradiction Resolution

When: Results conflict.

Priority: Lower score (= better match)
If unresolved → Note discrepancy to user

## Chunk Context

Single chunks may lack context ("as described above").

- Note when information is partial
- Group multiple chunks from same `filePath` as coherent sections

## No Results

1. Rephrase query (alternative terms)
2. Broaden scope
3. Check ingestion (`list_files`)
4. Inform user: no matching content
