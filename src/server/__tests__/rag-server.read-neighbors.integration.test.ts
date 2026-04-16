// read_chunk_neighbors Integration Test - Design Doc: read-chunk-neighbors-design.md
// Generated: 2026-04-16 | Budget Used: 7/3 integration (Design Doc explicitly prescribes
// AC-005/006/007/011/013/019 + single-call sufficiency + P95; budget overrun reported)
// PRD reference: docs/prd/read-chunk-neighbors-prd.md (AC-001..AC-020)
//
// Test framework: vitest (pool: forks, maxWorkers: 1, isolate: false)
// Mock boundary decisions (Design Doc §Test Boundaries):
//   @real-dependency: RAGServer, VectorStore, LanceDB, DocumentParser, raw-data-utils
//   Mocked: none in this file (except the single-call-sufficiency spy on vectorStore.getChunksByRange)
//
// Follow existing pattern from rag-server.delete.integration.test.ts:
//   - describe block per AC (or AC group) with its own tmp dbPath + baseDir
//   - beforeAll: create dirs, construct RAGServer, initialize, seed fixtures
//   - afterAll: rmSync tmp dirs recursively
//   - Use handleIngestFile / handleIngestData to seed real chunks

import { describe, it } from 'vitest'

describe.skip('read_chunk_neighbors integration (awaiting Task 2.4 / #008)', () => {
  it.todo('Test 1: Default window returns 5 sorted chunks with core fields and isTarget')
  it.todo('Test 2: Single-call sufficiency (PRD Quantitative Metric 3)')
  it.todo('Test 3: Near-start target returns clamped window (AC-005)')
  it.todo('Test 4: Missing target and fully out-of-range behavior (AC-006)')
  it.todo('Test 5: source input resolves to same document as filePath (AC-003)')
  it.todo('Test 6: Raw-data row includes source field (AC-020)')
  it.todo('Test 7: P95 under 100ms on 10k chunk document (NFR)')

  // =============================================================================
  // Test 1: Default window returns 5 sorted chunks with core fields and isTarget
  // =============================================================================
  // AC: AC-001 "Given an ingested document at filePath, when a client calls
  //     read_chunk_neighbors({ filePath, chunkIndex: N }) with the defaults
  //     (before=2, after=2), then the response contains all existing chunks from
  //     index N-2 to N+2 in the same document, sorted by chunkIndex ascending."
  // AC: AC-002 "Each item contains exactly the core required fields: chunkIndex,
  //     text, filePath."
  // AC: AC-008 "Default before=2, after=2."
  // AC: AC-018 "Response array is always sorted by chunkIndex ascending."
  // AC: AC-019 "Each item includes isTarget (boolean); exactly one item in a
  //     non-empty response has isTarget: true; that item's chunkIndex equals the
  //     requested chunkIndex."
  // ROI: 109 (BV:10 x Freq:10 + Legal:0 + Defect:9)
  // Behavior: Ingest document with >=5 chunks -> call handleReadChunkNeighbors
  //   with filePath + chunkIndex in mid-document -> response is ordered 5-item
  //   window with correct fields and exactly one isTarget:true at the requested
  //   chunkIndex.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB, DocumentParser
  // @complexity: medium
  //
  // Setup:
  //   - Ingest a text file large enough to produce at least 7 chunks
  //     (use '. '.repeat(N) pattern from rag-server.delete.integration.test.ts
  //      or a file sized against CHUNK_MIN_LENGTH to guarantee >= 7 chunks).
  //   - Record the filePath and pick a mid-document chunkIndex (e.g., 3).
  //
  // Verification items:
  //   - Response shape: { content: [{ type: 'text', text: <json> }] }
  //   - Parsed JSON is an array of length 5
  //   - chunkIndex values equal [N-2, N-1, N, N+1, N+2] in that exact order
  //     (ascending sort guarantee; AC-018)
  //   - Every item has keys: chunkIndex (number), text (non-empty string),
  //     filePath (matches ingested path), isTarget (boolean), fileTitle
  //     (string or null)
  //   - Exactly one item has isTarget === true (AC-019)
  //   - The isTarget:true item's chunkIndex equals the requested chunkIndex
  //   - No item carries a 'score' field (Design Doc §Data Representation Decision)
  //   - No item carries a 'metadata' field
  //
  // Pass criteria:
  //   - All verification items above hold.

  // =============================================================================
  // Test 2: Single-call sufficiency (PRD Quantitative Metric 3)
  // =============================================================================
  // AC: Metric 3 "In an end-to-end agent scenario (query_documents hit ->
  //     read_chunk_neighbors), the agent produces the expected surrounding
  //     context in exactly one follow-up tool call with no retries, measured by
  //     at least one integration test that asserts call count = 1."
  // ROI: 78 (BV:9 x Freq:8 + Legal:0 + Defect:6)
  // Behavior: Simulate agent workflow: query_documents returns a hit -> use
  //   that hit's filePath+chunkIndex -> call read_chunk_neighbors once ->
  //   vectorStore.getChunksByRange is invoked exactly once for the neighbor call.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB (real), vi.spyOn on getChunksByRange
  // @complexity: medium
  //
  // Setup:
  //   - Ingest a document containing a distinctive query term so
  //     handleQueryDocuments returns a deterministic hit.
  //   - Install vi.spyOn(vectorStore, 'getChunksByRange') AFTER the query step
  //     so the query path itself does not contribute to the call count.
  //     Alternative: reset the spy with spy.mockClear() between the two steps.
  //
  // Verification items:
  //   - handleQueryDocuments returns at least one hit; extract filePath and
  //     chunkIndex from results[0]
  //   - After handleReadChunkNeighbors is called with those values,
  //     getChunksByRange spy call count === 1 (not 0, not 2+)
  //   - The single call's arguments match (ingestedFilePath, chunkIndex-2,
  //     chunkIndex+2) — confirming default window + correct filePath plumbing
  //   - Response resolves (no exception thrown)
  //
  // Pass criteria:
  //   - Spy call count equals 1 on the neighbor call.
  //   - Arguments match the expected minIdx/maxIdx range.

  // =============================================================================
  // Test 3: Near-start target returns clamped window (AC-005)
  // =============================================================================
  // AC: AC-005 "Given a target chunkIndex near the start or end of the document
  //     (e.g., chunkIndex: 0 with before=2), when the tool runs, then the
  //     response includes only the chunks that exist (e.g., indices 0, 1, 2)
  //     with no error and no placeholder entries for missing indices."
  // ROI: 71 (BV:9 x Freq:7 + Legal:0 + Defect:8)
  // Behavior: Request neighbors centered on chunkIndex=0 with default before=2 ->
  //   no error; response contains only indices [0, 1, 2]; no negative-index
  //   placeholder rows.
  // @category: edge-case
  // @dependency: RAGServer, VectorStore, LanceDB
  // @complexity: low
  //
  // Setup:
  //   - Ingest a document producing at least 4 chunks (so chunks 0,1,2 all exist).
  //   - Call handleReadChunkNeighbors with chunkIndex=0 (defaults on before/after).
  //
  // Verification items:
  //   - Operation resolves without throwing
  //   - Response is an array of length 3
  //   - chunkIndex values are exactly [0, 1, 2] in order
  //   - The item with chunkIndex === 0 has isTarget: true
  //   - The other two items have isTarget: false
  //   - No item has a negative chunkIndex
  //
  // Pass criteria:
  //   - All verification items above hold; response is the clamped window.

  // =============================================================================
  // Test 4: Missing target and fully out-of-range behavior (AC-006)
  // =============================================================================
  // AC: AC-006 "When the target chunkIndex itself does not exist, the tool
  //     returns only the surrounding chunks (within [N-before, N+after]) that
  //     do exist; if none of the requested range exists, it returns an empty
  //     array. No error is raised."
  // AC (cross-reference): AC-019 "when the target chunkIndex itself does not
  //     exist in the document, all returned items have isTarget: false."
  // ROI: 63 (BV:9 x Freq:6 + Legal:0 + Defect:9)
  // Behavior: Two sub-scenarios in a single test:
  //   (a) Target chunkIndex is just past the last valid index (e.g., doc has
  //       chunks 0..5, request chunkIndex=6): surrounding indices 4,5 remain.
  //   (b) Target chunkIndex is far past the document (e.g., chunkIndex=999):
  //       response is an empty array, no error.
  // @category: edge-case
  // @dependency: RAGServer, VectorStore, LanceDB
  // @complexity: medium
  //
  // Setup:
  //   - Ingest a document yielding exactly N known chunks (e.g., N=6 -> last
  //     valid chunkIndex = 5). The exact chunk count is not asserted here
  //     (chunker is deterministic enough via fixed input text) — the test
  //     reads the count via handleListFiles or a prior getChunksByRange call
  //     if needed.
  //
  // Verification items (sub-scenario a):
  //   - Request chunkIndex=(N) with default before=2 after=2
  //   - Operation resolves without throwing
  //   - Response is a non-empty array
  //   - All returned items have isTarget: false (target itself absent)
  //   - All returned chunkIndex values are <= N-1 (no item beyond doc end)
  //   - chunkIndex values are strictly ascending
  //
  // Verification items (sub-scenario b):
  //   - Request chunkIndex=999 (far outside) with default before=2 after=2
  //   - Operation resolves without throwing
  //   - Response is an empty array ([])
  //
  // Pass criteria:
  //   - Both sub-scenarios hold as specified.

  // =============================================================================
  // Test 5: source input resolves to same document as filePath (AC-003)
  // =============================================================================
  // AC: AC-003 "Given the caller passes source (the identifier used in
  //     ingest_data) instead of filePath, when the tool runs, then it resolves
  //     the internal storage key via the same raw-data-utils helpers used by
  //     delete_file and returns neighbors for that document."
  // ROI: 47 (BV:8 x Freq:5 + Legal:0 + Defect:7)
  // Behavior: Ingest raw data via handleIngestData(content, metadata.source=X)
  //   -> call handleReadChunkNeighbors({ source: X, chunkIndex: N }) -> response
  //   items belong to the same underlying document (same internal filePath).
  // @category: integration
  // @dependency: RAGServer, VectorStore, LanceDB, raw-data-utils
  // @complexity: medium
  //
  // Setup:
  //   - Call handleIngestData with distinctive content and metadata:
  //     { source: 'https://example.com/read-neighbors-test', format: 'html' or 'markdown' }.
  //   - Capture ingest result; confirm chunkCount >= 3 so chunkIndex=1 yields a
  //     full window.
  //   - Call handleReadChunkNeighbors({ source: 'https://example.com/...', chunkIndex: 1 }).
  //
  // Verification items:
  //   - Operation resolves without throwing
  //   - Response is a non-empty array
  //   - All returned items share the same filePath value
  //   - The shared filePath is under the raw-data storage directory
  //     (isRawDataPath(filePath) === true)
  //   - Exactly one item has isTarget: true with chunkIndex === 1
  //
  // Pass criteria:
  //   - Source-based resolution yields a valid neighbor window from the same
  //     raw-data document.

  // =============================================================================
  // Test 6: Raw-data row includes source field (AC-020)
  // =============================================================================
  // AC: AC-020 "Given a document ingested via ingest_data, when
  //     read_chunk_neighbors returns its chunks, each item includes a source
  //     field whose value equals the ingestion source URL/identifier."
  // ROI: 35 (BV:7 x Freq:4 + Legal:0 + Defect:7)
  // Behavior: Reuse the raw-data document from Test 5 (or seed a new one) ->
  //   verify every returned item carries source === the ingestion identifier.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB, raw-data-utils
  // @complexity: low
  //
  // Setup:
  //   - Ingest content via handleIngestData with metadata.source = KNOWN_SOURCE.
  //   - Call handleReadChunkNeighbors with either { source: KNOWN_SOURCE,
  //     chunkIndex: 0 } or { filePath: <rawDataPath>, chunkIndex: 0 }.
  //     Both paths must surface the source field (Design Doc §Field
  //     Propagation Map: source is derived from targetPath via
  //     extractSourceFromPath, not from the input key).
  //
  // Verification items:
  //   - Response is a non-empty array
  //   - Every item has a 'source' property of type string
  //   - Every item's source === KNOWN_SOURCE (exact match)
  //
  // Cross-check negative:
  //   - For a handleIngestFile-seeded document (non-raw-data), call
  //     handleReadChunkNeighbors and confirm items do NOT carry a 'source' key
  //     (or source is undefined). This guards against source being incorrectly
  //     populated for file-backed documents.
  //
  // Pass criteria:
  //   - source present and correct on raw-data items; absent on file-backed
  //     items.

  // =============================================================================
  // Test 7: P95 under 100ms on 10k chunk document (NFR)
  // =============================================================================
  // AC: PRD Non-Functional Requirement "P95 under 100 ms for a window of
  //     before=2, after=2 on a document with up to 10,000 chunks, measured in
  //     CI on the default GitHub Actions runner."
  // ROI: 85 (BV:8 x Freq:10 + Legal:0 + Defect:5)
  // Behavior: Seed a LanceDB table with 10,000 chunks for a single filePath ->
  //   warm up with 3 discarded calls -> measure 20 consecutive neighbor calls
  //   -> assert computed P95 < 100 ms.
  // @category: core-functionality
  // @dependency: RAGServer, VectorStore, LanceDB
  // @complexity: high
  //
  // Setup (per Design Doc §Performance Measurement Mechanism):
  //   - Insert 10,000 contiguous chunks for one synthetic filePath. Use a
  //     small constant vector (e.g., zeros of embedding dimension) to keep
  //     insertion fast; this is setup, not part of the measured section.
  //   - Consider bypassing the full handleIngestFile pipeline (which invokes
  //     the real embedder) by inserting directly through vectorStore if the
  //     existing test helper (createTestChunk from vectordb unit tests)
  //     allows — otherwise accept longer setup and rely on vitest's 10s
  //     default timeout; if setup exceeds that, split via beforeAll so only
  //     the measured section runs under the per-test timeout.
  //
  // Measurement protocol:
  //   - Warm up: call handleReadChunkNeighbors 3 times with before=2, after=2
  //     on varied chunkIndex values (e.g., 100, 5000, 9500); discard timings.
  //   - Measurement: call handleReadChunkNeighbors 20 times with before=2,
  //     after=2 on a varied set of chunkIndex values spanning start / middle /
  //     end (e.g., a cycle through [50, 2500, 5000, 7500, 9950] four times).
  //   - Record per-call wall-clock using performance.now() deltas (start
  //     BEFORE the call, end AFTER the awaited promise resolves).
  //   - Sort timings ascending; P95 = timings[Math.ceil(0.95 * 20) - 1]
  //     (index 18 of the sorted 20-element array, i.e., the 19th smallest).
  //
  // Verification items:
  //   - All 20 measured calls resolve without throwing
  //   - P95 value is a finite number > 0 (sanity)
  //   - P95 < 100 (milliseconds)
  //   - Emit the observed P95 via console.error(`P95: ${p95.toFixed(2)} ms`)
  //     so CI logs capture the value for the PR description (PRD Success
  //     Criteria 2)
  //
  // Pass criteria:
  //   - P95 strictly below 100 ms.
  //   - On failure, the failure message includes the full timings array for
  //     the PR author (Design Doc §Performance Measurement Mechanism).
  //
  // Flake mitigation note:
  //   - The 100 ms target includes headroom vs. the expected operation cost
  //     on GitHub Actions shared runners (Design Doc §Risks). If the test
  //     flakes in practice, relax to P95 < 150 ms and record the observed
  //     distribution per Design Doc mitigation guidance.
})
